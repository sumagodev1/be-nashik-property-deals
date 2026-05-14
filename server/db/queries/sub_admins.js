const { pool } = require('../pool');

async function findActiveByEmail(email) {
  const [rows] = await pool.query(
    `SELECT id, email, password_hash, full_name, is_active
     FROM sub_admins
     WHERE email = ? AND deleted_at IS NULL AND is_active = 1
     LIMIT 1`,
    [email],
  );
  return rows[0] || null;
}

async function findById(id) {
  const [rows] = await pool.query(
    `SELECT id, email, full_name, is_active, last_login_at, created_at, updated_at
     FROM sub_admins
     WHERE id = ? AND deleted_at IS NULL
     LIMIT 1`,
    [id],
  );
  return rows[0] || null;
}

async function findActiveById(id) {
  const [rows] = await pool.query(
    `SELECT id, email, full_name, is_active
     FROM sub_admins
     WHERE id = ? AND deleted_at IS NULL AND is_active = 1
     LIMIT 1`,
    [id],
  );
  return rows[0] || null;
}

async function emailTaken(email, excludeId = null) {
  const params = [email];
  let sql = 'SELECT id FROM sub_admins WHERE email = ? AND deleted_at IS NULL';
  if (excludeId !== null) {
    sql += ' AND id <> ?';
    params.push(excludeId);
  }
  sql += ' LIMIT 1';
  const [rows] = await pool.query(sql, params);
  return rows.length > 0;
}

async function list({ page, pageSize, search, isActive }) {
  const offset = (page - 1) * pageSize;
  const where = ['deleted_at IS NULL'];
  const params = [];
  if (search) {
    where.push('(full_name LIKE ? OR email LIKE ?)');
    params.push(`%${search}%`, `%${search}%`);
  }
  if (typeof isActive === 'boolean') {
    where.push('is_active = ?');
    params.push(isActive ? 1 : 0);
  }
  const whereSql = `WHERE ${where.join(' AND ')}`;

  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM sub_admins ${whereSql}`, params);

  const [rows] = await pool.query(
    `SELECT id, email, full_name, is_active, last_login_at, created_at
     FROM sub_admins
     ${whereSql}
     ORDER BY created_at DESC, id DESC
     LIMIT ? OFFSET ?`,
    [...params, pageSize, offset],
  );

  return { rows, total };
}

async function create({ email, passwordHash, fullName, isActive, createdByAdminId }) {
  const [result] = await pool.query(
    `INSERT INTO sub_admins (email, password_hash, full_name, is_active, created_by_admin_id)
     VALUES (?, ?, ?, ?, ?)`,
    [email, passwordHash, fullName, isActive ? 1 : 0, createdByAdminId],
  );
  return result.insertId;
}

async function updateProfile(id, { fullName, email, isActive }) {
  await pool.query(
    `UPDATE sub_admins
     SET full_name = ?, email = ?, is_active = ?
     WHERE id = ? AND deleted_at IS NULL`,
    [fullName, email, isActive ? 1 : 0, id],
  );
}

async function updatePassword(id, passwordHash) {
  await pool.query(
    `UPDATE sub_admins SET password_hash = ? WHERE id = ? AND deleted_at IS NULL`,
    [passwordHash, id],
  );
}

async function softDelete(id) {
  await pool.query(
    `UPDATE sub_admins SET deleted_at = NOW(), is_active = 0 WHERE id = ? AND deleted_at IS NULL`,
    [id],
  );
}

async function updateLastLogin(id) {
  await pool.query('UPDATE sub_admins SET last_login_at = NOW() WHERE id = ?', [id]);
}

module.exports = {
  findActiveByEmail,
  findById,
  findActiveById,
  emailTaken,
  list,
  create,
  updateProfile,
  updatePassword,
  softDelete,
  updateLastLogin,
};
