/**
 * DB layer for the Business Associates directory.
 *
 * Standard soft-delete + pagination pattern. Contact fields are stored
 * as free text — normalization is a service concern.
 */

const { pool } = require('../pool');

const COLUMNS = `
  id, general_category, salutation, first_name, middle_name, surname,
  company_name, business_category,
  designation, area_wise, property_wise,
  address_line1, address_line2,
  city_code, taluka_code, district_code,
  phone1, phone2, mobile1, mobile2, mobile3, whatsapp,
  email1, email2, website1, website2, date_of_birth,
  notes,
  created_by_admin_id, created_at, updated_at
`;

async function list({
  page = 1,
  pageSize = 10,
  search = '',
  ownerSearch = '',
  generalCategory = '',
  businessCategory = '',
  designation = '',
} = {}) {
  const offset = (page - 1) * pageSize;
  const args = [];
  let where = 'WHERE deleted_at IS NULL';

  // Unified `search`: single free-text query that scans every user-visible
  // string column so admins get an Inventory-style "type anything" box.
  // Extends the historical mobile/email/name coverage with company,
  // notes, address, and the new general_category / business_category so
  // "phone book" or "builder" also match. Case-insensitivity comes from
  // the utf8mb4 collation (…_ci).
  if (search) {
    where += ` AND (
      first_name LIKE ? OR middle_name LIKE ? OR surname LIKE ?
      OR CONCAT_WS(' ', first_name, COALESCE(middle_name,''), COALESCE(surname,'')) LIKE ?
      OR company_name LIKE ? OR designation LIKE ?
      OR business_category LIKE ? OR general_category LIKE ?
      OR area_wise LIKE ? OR property_wise LIKE ?
      OR address_line1 LIKE ? OR address_line2 LIKE ?
      OR city_code LIKE ? OR taluka_code LIKE ? OR district_code LIKE ?
      OR phone1 LIKE ? OR phone2 LIKE ?
      OR mobile1 LIKE ? OR mobile2 LIKE ? OR mobile3 LIKE ? OR whatsapp LIKE ?
      OR email1 LIKE ? OR email2 LIKE ?
      OR website1 LIKE ? OR website2 LIKE ?
      OR notes LIKE ?
    )`;
    const like = `%${String(search).trim()}%`;
    for (let i = 0; i < 26; i++) args.push(like);
  }

  // Owner Search (T-2026-032, T-2026-036) — retained unchanged so any
  // caller that still passes `ownerSearch` continues to get the exact
  // same behaviour as before the merge.
  if (typeof ownerSearch === 'string' && ownerSearch.trim() !== '') {
    where += ` AND (
      first_name LIKE ? OR middle_name LIKE ? OR surname LIKE ?
      OR CONCAT_WS(' ', first_name, COALESCE(middle_name,''), COALESCE(surname,'')) LIKE ?
      OR mobile1 LIKE ? OR mobile2 LIKE ? OR mobile3 LIKE ?
      OR phone1 LIKE ? OR phone2 LIKE ?
      OR whatsapp LIKE ?
      OR email1 LIKE ? OR email2 LIKE ?
      OR designation LIKE ?
      OR city_code LIKE ? OR district_code LIKE ?
    )`;
    const like = `%${ownerSearch.trim()}%`;
    for (let i = 0; i < 15; i++) args.push(like);
  }

  // Categorical filters — all optional, all composable via AND.
  if (generalCategory === 'business_associate' || generalCategory === 'phone_book') {
    where += ' AND general_category = ?';
    args.push(generalCategory);
  }
  // Partial (LIKE) match on business_category — no master exists for
  // this column so admins should be able to type "Builder" and match
  // any legacy free-text variation ("Builders", "Builder / Developer").
  if (typeof businessCategory === 'string' && businessCategory.trim() !== '') {
    where += ' AND business_category LIKE ?';
    args.push(`%${businessCategory.trim()}%`);
  }
  // Exact-code match on designation (values come from the shared
  // business_associate_designation master). Legacy free-text rows still
  // match because the code equals the stored value in that case.
  if (typeof designation === 'string' && designation.trim() !== '') {
    where += ' AND designation = ?';
    args.push(designation.trim());
  }

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM business_associates ${where}`,
    args,
  );
  const [rows] = await pool.query(
    `SELECT ${COLUMNS} FROM business_associates ${where}
     ORDER BY first_name ASC, COALESCE(surname,'') ASC, id ASC LIMIT ? OFFSET ?`,
    [...args, pageSize, offset],
  );
  return { data: rows, total: Number(total), page, pageSize };
}

async function getById(id) {
  const [rows] = await pool.query(
    `SELECT ${COLUMNS} FROM business_associates
     WHERE id = ? AND deleted_at IS NULL`,
    [id],
  );
  return rows[0] || null;
}

// `general_category` defaults to 'business_associate' when the caller
// omits it — preserves the historical behaviour of the create endpoint
// so any pre-merge script that still POSTs without the new field keeps
// producing Business Associate rows.
function normalizeGeneralCategory(raw) {
  if (raw === 'business_associate' || raw === 'phone_book') return raw;
  return 'business_associate';
}

async function create(payload, adminId) {
  const [r] = await pool.query(
    `INSERT INTO business_associates (
      general_category,
      salutation, first_name, middle_name, surname,
      company_name, business_category,
      designation, area_wise, property_wise,
      address_line1, address_line2,
      city_code, taluka_code, district_code,
      phone1, phone2, mobile1, mobile2, mobile3, whatsapp,
      email1, email2, website1, website2, date_of_birth,
      notes,
      created_by_admin_id
    ) VALUES (?, ?,?,?,?, ?,?, ?,?,?, ?,?, ?,?,?, ?,?,?,?,?,?, ?,?,?,?,?, ?, ?)`,
    [
      normalizeGeneralCategory(payload.generalCategory),
      payload.salutation,
      payload.firstName,
      payload.middleName || null,
      payload.surname || null,
      payload.companyName || null,
      payload.businessCategory || null,
      payload.designation || null,
      payload.areaWise || null,
      payload.propertyWise || null,
      payload.addressLine1 || null,
      payload.addressLine2 || null,
      payload.cityCode || null,
      payload.talukaCode || null,
      payload.districtCode || null,
      payload.phone1 || null,
      payload.phone2 || null,
      payload.mobile1 || null,
      payload.mobile2 || null,
      payload.mobile3 || null,
      payload.whatsapp || null,
      payload.email1 || null,
      payload.email2 || null,
      payload.website1 || null,
      payload.website2 || null,
      payload.dateOfBirth || null,
      payload.notes || null,
      adminId || null,
    ],
  );
  return getById(r.insertId);
}

async function update(id, payload) {
  await pool.query(
    `UPDATE business_associates SET
      general_category = ?,
      salutation = ?, first_name = ?, middle_name = ?, surname = ?,
      company_name = ?, business_category = ?,
      designation = ?, area_wise = ?, property_wise = ?,
      address_line1 = ?, address_line2 = ?,
      city_code = ?, taluka_code = ?, district_code = ?,
      phone1 = ?, phone2 = ?, mobile1 = ?, mobile2 = ?, mobile3 = ?, whatsapp = ?,
      email1 = ?, email2 = ?, website1 = ?, website2 = ?, date_of_birth = ?,
      notes = ?
     WHERE id = ? AND deleted_at IS NULL`,
    [
      normalizeGeneralCategory(payload.generalCategory),
      payload.salutation,
      payload.firstName,
      payload.middleName || null,
      payload.surname || null,
      payload.companyName || null,
      payload.businessCategory || null,
      payload.designation || null,
      payload.areaWise || null,
      payload.propertyWise || null,
      payload.addressLine1 || null,
      payload.addressLine2 || null,
      payload.cityCode || null,
      payload.talukaCode || null,
      payload.districtCode || null,
      payload.phone1 || null,
      payload.phone2 || null,
      payload.mobile1 || null,
      payload.mobile2 || null,
      payload.mobile3 || null,
      payload.whatsapp || null,
      payload.email1 || null,
      payload.email2 || null,
      payload.website1 || null,
      payload.website2 || null,
      payload.dateOfBirth || null,
      payload.notes || null,
      id,
    ],
  );
  return getById(id);
}

async function softDelete(id) {
  await pool.query(
    `UPDATE business_associates SET deleted_at = CURRENT_TIMESTAMP
     WHERE id = ? AND deleted_at IS NULL`,
    [id],
  );
}



// ── Bulk-lookup for duplicate detection (additive) ───────────────────────
//
// One indexed query that returns every row whose ANY contact field matches
// one of the supplied values. The service layer then builds the per-item
// lookup maps in memory. Keeping the SQL to a single OR-ed IN() list keeps
// the round-trip count constant regardless of upload size.
async function findByContactFields({ mobiles = [], phones = [], whatsapps = [], emails = [] } = {}) {
  const clauses = [];
  const args = [];
  const addIn = (cols, values) => {
    const clean = Array.from(new Set(values.map((v) => String(v || '').trim()).filter(Boolean)));
    if (clean.length === 0) return;
    for (const col of cols) {
      clauses.push(`${col} IN (${clean.map(() => '?').join(',')})`);
      args.push(...clean);
    }
  };
  addIn(['mobile1', 'mobile2', 'mobile3'], mobiles);
  addIn(['phone1', 'phone2'], phones);
  addIn(['whatsapp'], whatsapps);
  addIn(['email1', 'email2'], emails);

  if (clauses.length === 0) return [];

  const [rows] = await pool.query(
    `SELECT id, mobile1, mobile2, mobile3, phone1, phone2, whatsapp, email1, email2
       FROM business_associates
      WHERE deleted_at IS NULL AND (${clauses.join(' OR ')})`,
    args,
  );
  return rows;
}

module.exports = { list, getById, create, update, softDelete, findByContactFields };
