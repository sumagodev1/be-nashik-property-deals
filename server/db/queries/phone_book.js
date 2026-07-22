/**
 * DB layer for the Phone Book directory.
 *
 * Independent from Business Associates — Phone Book is a fully separate
 * module with its own table (`phone_book`), its own contacts vocabulary,
 * and its own CRUD pipeline. No queries or SQL are shared with
 * `business_associates`.
 */

const { pool } = require('../pool');

const COLUMNS = `
  id, salutation, first_name, middle_name, surname,
  company_name, designation,
  address_line1, address_line2,
  city_code, taluka_code, district_code,
  phone1, phone2, mobile1, mobile2, mobile3, whatsapp,
  email1, email2, website1, website2, date_of_birth, notes,
  created_by_admin_id, created_at, updated_at
`;

async function list({ page = 1, pageSize = 10, search = '' } = {}) {
  const offset = (page - 1) * pageSize;
  const args = [];
  let where = 'WHERE deleted_at IS NULL';
  if (search) {
    where += ` AND (
      first_name LIKE ? OR middle_name LIKE ? OR surname LIKE ?
      OR CONCAT_WS(' ', first_name, COALESCE(middle_name,''), COALESCE(surname,'')) LIKE ?
      OR company_name LIKE ?
      OR designation LIKE ?
      OR mobile1 LIKE ? OR mobile2 LIKE ? OR mobile3 LIKE ?
      OR phone1 LIKE ? OR phone2 LIKE ?
      OR whatsapp LIKE ?
      OR email1 LIKE ? OR email2 LIKE ?
      OR city_code LIKE ? OR district_code LIKE ?
    )`;
    const like = `%${search}%`;
    args.push(
      like, like, like, like, like, like,
      like, like, like, like, like, like,
      like, like, like, like,
    );
  }
  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM phone_book ${where}`,
    args,
  );
  const [rows] = await pool.query(
    `SELECT ${COLUMNS} FROM phone_book ${where}
     ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    [...args, pageSize, offset],
  );
  return { data: rows, total: Number(total), page, pageSize };
}

async function getById(id) {
  const [rows] = await pool.query(
    `SELECT ${COLUMNS} FROM phone_book
     WHERE id = ? AND deleted_at IS NULL`,
    [id],
  );
  return rows[0] || null;
}

async function create(payload, adminId) {
  const [r] = await pool.query(
    `INSERT INTO phone_book (
      salutation, first_name, middle_name, surname,
      company_name, designation,
      address_line1, address_line2,
      city_code, taluka_code, district_code,
      phone1, phone2, mobile1, mobile2, mobile3, whatsapp,
      email1, email2, website1, website2, date_of_birth, notes,
      created_by_admin_id
    ) VALUES (?,?,?,?, ?,?, ?,?, ?,?,?, ?,?,?,?,?,?, ?,?,?,?,?,?, ?)`,
    [
      payload.salutation || null,
      payload.firstName,
      payload.middleName || null,
      payload.surname || null,
      payload.companyName || null,
      payload.designation || null,
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
    `UPDATE phone_book SET
      salutation = ?, first_name = ?, middle_name = ?, surname = ?,
      company_name = ?, designation = ?,
      address_line1 = ?, address_line2 = ?,
      city_code = ?, taluka_code = ?, district_code = ?,
      phone1 = ?, phone2 = ?, mobile1 = ?, mobile2 = ?, mobile3 = ?, whatsapp = ?,
      email1 = ?, email2 = ?, website1 = ?, website2 = ?, date_of_birth = ?, notes = ?
     WHERE id = ? AND deleted_at IS NULL`,
    [
      payload.salutation || null,
      payload.firstName,
      payload.middleName || null,
      payload.surname || null,
      payload.companyName || null,
      payload.designation || null,
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
    `UPDATE phone_book SET deleted_at = CURRENT_TIMESTAMP
     WHERE id = ? AND deleted_at IS NULL`,
    [id],
  );
}

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
       FROM phone_book
      WHERE deleted_at IS NULL AND (${clauses.join(' OR ')})`,
    args,
  );
  return rows;
}

module.exports = { list, getById, create, update, softDelete, findByContactFields };
