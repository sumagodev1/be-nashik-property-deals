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

// Like findActiveByEmail but also returns rows where is_active = 0.
// Used by the login flow so we can distinguish "wrong password" from
// "account is deactivated" after the password has been verified.
async function findByEmail(email) {
  const [rows] = await pool.query(
    `SELECT id, email, password_hash, full_name, is_active
     FROM sub_admins
     WHERE email = ? AND deleted_at IS NULL
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

// Returns a row matching `email` even if it's soft-deleted. Used by the
// create flow to give a friendly error (and an option to restore) instead
// of letting the INSERT hit MySQL's unique-index and crash with ER_DUP_ENTRY.
async function findAnyByEmail(email) {
  const [rows] = await pool.query(
    `SELECT id, email, full_name, is_active, deleted_at
     FROM sub_admins
     WHERE email = ?
     LIMIT 1`,
    [email],
  );
  return rows[0] || null;
}

// Bring a previously soft-deleted sub admin back to life with the new
// password / name supplied in the recreate form. The id stays the same so
// historical audit-log entries and lead-assignment records still resolve
// to a real row. Module assignments are wiped — the caller re-inserts the
// new module set right after this call.
async function restoreSoftDeleted(id, { passwordHash, fullName, isActive }) {
  await pool.query(
    `UPDATE sub_admins
        SET deleted_at = NULL,
            password_hash = ?,
            full_name = ?,
            is_active = ?
      WHERE id = ?`,
    [passwordHash, fullName, isActive ? 1 : 0, id],
  );
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

// Sub-admins that have lead_management module access AND are active. Used to
// populate the "Assign to" picker on the Kanban board so admins can route a
// lead only to a teammate who can actually act on it.
async function listAssignableForLeads() {
  const [rows] = await pool.query(
    `SELECT sa.id, sa.full_name, sa.email
     FROM sub_admins sa
     INNER JOIN sub_admin_modules sam ON sam.sub_admin_id = sa.id
     WHERE sa.deleted_at IS NULL
       AND sa.is_active = 1
       AND sam.module_key = 'lead_management'
     ORDER BY sa.full_name ASC, sa.id ASC`,
  );
  return rows;
}

module.exports = {
  findActiveByEmail,
  findByEmail,
  findById,
  findActiveById,
  emailTaken,
  list,
  create,
  updateProfile,
  updatePassword,
  softDelete,
  updateLastLogin,
  listAssignableForLeads,
  findAnyByEmail,
  restoreSoftDeleted,
};
