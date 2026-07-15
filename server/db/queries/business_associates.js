/**
 * DB layer for the Business Associates directory.
 *
 * Standard soft-delete + pagination pattern. Contact fields are stored
 * as free text — normalization is a service concern.
 */

const { pool } = require('../pool');

const COLUMNS = `
  id, salutation, first_name, middle_name, surname, designation,
  address_line1, address_line2,
  city_code, taluka_code, district_code,
  phone1, phone2, mobile1, mobile2, mobile3, whatsapp,
  email1, email2, website1, website2, date_of_birth,
  created_by_admin_id, created_at, updated_at
`;

async function list({ page = 1, pageSize = 10, search = '' } = {}) {
  const offset = (page - 1) * pageSize;
  const args = [];
  let where = 'WHERE deleted_at IS NULL';
  if (search) {
    where += ` AND (
      first_name LIKE ? OR middle_name LIKE ? OR surname LIKE ?
      OR designation LIKE ?
      OR mobile1 LIKE ? OR mobile2 LIKE ? OR mobile3 LIKE ? OR whatsapp LIKE ?
      OR email1 LIKE ? OR email2 LIKE ?
    )`;
    const like = `%${search}%`;
    args.push(like, like, like, like, like, like, like, like, like, like);
  }
  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM business_associates ${where}`,
    args,
  );
  const [rows] = await pool.query(
    `SELECT ${COLUMNS} FROM business_associates ${where}
     ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
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

async function create(payload, adminId) {
  const [r] = await pool.query(
    `INSERT INTO business_associates (
      salutation, first_name, middle_name, surname, designation,
      address_line1, address_line2,
      city_code, taluka_code, district_code,
      phone1, phone2, mobile1, mobile2, mobile3, whatsapp,
      email1, email2, website1, website2, date_of_birth,
      created_by_admin_id
    ) VALUES (?,?,?,?,?, ?,?, ?,?,?, ?,?,?,?,?,?, ?,?,?,?,?, ?)`,
    [
      payload.salutation,
      payload.firstName,
      payload.middleName || null,
      payload.surname || null,
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
      adminId || null,
    ],
  );
  return getById(r.insertId);
}

async function update(id, payload) {
  await pool.query(
    `UPDATE business_associates SET
      salutation = ?, first_name = ?, middle_name = ?, surname = ?, designation = ?,
      address_line1 = ?, address_line2 = ?,
      city_code = ?, taluka_code = ?, district_code = ?,
      phone1 = ?, phone2 = ?, mobile1 = ?, mobile2 = ?, mobile3 = ?, whatsapp = ?,
      email1 = ?, email2 = ?, website1 = ?, website2 = ?, date_of_birth = ?
     WHERE id = ? AND deleted_at IS NULL`,
    [
      payload.salutation,
      payload.firstName,
      payload.middleName || null,
      payload.surname || null,
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

module.exports = { list, getById, create, update, softDelete };
