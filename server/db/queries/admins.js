const { pool } = require('../pool');

async function findActiveByEmail(email) {
  const [rows] = await pool.query(
    `SELECT id, email, password_hash, full_name, is_active
     FROM admins
     WHERE email = ? AND deleted_at IS NULL AND is_active = 1
     LIMIT 1`,
    [email],
  );
  return rows[0] || null;
}

async function findActiveById(id) {
  const [rows] = await pool.query(
    `SELECT id, email, full_name, is_active
     FROM admins
     WHERE id = ? AND deleted_at IS NULL AND is_active = 1
     LIMIT 1`,
    [id],
  );
  return rows[0] || null;
}

async function updateLastLogin(id) {
  await pool.query('UPDATE admins SET last_login_at = NOW() WHERE id = ?', [id]);
}

async function create({ email, passwordHash, fullName }) {
  const [result] = await pool.query(
    `INSERT INTO admins (email, password_hash, full_name) VALUES (?, ?, ?)`,
    [email, passwordHash, fullName],
  );
  return result.insertId;
}

module.exports = { findActiveByEmail, findActiveById, updateLastLogin, create };
