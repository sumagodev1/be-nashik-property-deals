/**
 * Generic CRUD over the four master_* tables. All four tables share the same
 * shape (id, code, label, sort_order, is_active, timestamps, deleted_at), so
 * one parametrised query module covers them. The table name is provided by
 * the caller; we whitelist it to prevent SQL injection.
 */

const { pool } = require('../pool');

const ALLOWED_TABLES = new Set([
  'master_property_types',
  'master_transaction_types',
  'master_flat_types',
  'master_status_types',
]);

function assertTable(table) {
  if (!ALLOWED_TABLES.has(table)) {
    throw new Error(`masters.queries: table "${table}" is not whitelisted`);
  }
}

async function list(table, { search, isActive, page = 1, pageSize = 10 } = {}) {
  assertTable(table);
  const where = ['deleted_at IS NULL'];
  const params = [];
  if (search) {
    where.push('(code LIKE ? OR label LIKE ?)');
    const s = `%${search}%`;
    params.push(s, s);
  }
  if (typeof isActive === 'boolean') {
    where.push('is_active = ?');
    params.push(isActive ? 1 : 0);
  }
  const whereSql = `WHERE ${where.join(' AND ')}`;
  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM ${table} ${whereSql}`,
    params,
  );
  const offset = (page - 1) * pageSize;
  const [rows] = await pool.query(
    `SELECT id, code, label, sort_order, is_active, created_at, updated_at
     FROM ${table}
     ${whereSql}
     ORDER BY sort_order ASC, label ASC, id ASC
     LIMIT ? OFFSET ?`,
    [...params, pageSize, offset],
  );
  return { rows, total };
}

async function listAll(table, { isActive } = {}) {
  assertTable(table);
  const where = ['deleted_at IS NULL'];
  const params = [];
  if (typeof isActive === 'boolean') {
    where.push('is_active = ?');
    params.push(isActive ? 1 : 0);
  }
  const [rows] = await pool.query(
    `SELECT id, code, label, sort_order, is_active, created_at, updated_at
     FROM ${table}
     WHERE ${where.join(' AND ')}
     ORDER BY sort_order ASC, label ASC, id ASC`,
    params,
  );
  return rows;
}

async function findById(table, id) {
  assertTable(table);
  const [rows] = await pool.query(
    `SELECT id, code, label, sort_order, is_active, created_at, updated_at
     FROM ${table} WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
    [id],
  );
  return rows[0] || null;
}

async function findByCode(table, code) {
  assertTable(table);
  const [rows] = await pool.query(
    `SELECT id, code, label, sort_order, is_active
     FROM ${table} WHERE code = ? AND deleted_at IS NULL LIMIT 1`,
    [code],
  );
  return rows[0] || null;
}

// Case-insensitive lookup by label. Returns the row (with is_active) so the
// caller can give the admin a useful "already exists" error that says
// whether the conflicting row is active or inactive and what its id is.
async function findByLabel(table, label, excludeId = null) {
  assertTable(table);
  const params = [String(label).toLowerCase()];
  let sql = `SELECT id, code, label, sort_order, is_active
             FROM ${table} WHERE LOWER(label) = ? AND deleted_at IS NULL`;
  if (excludeId !== null) {
    sql += ' AND id <> ?';
    params.push(excludeId);
  }
  sql += ' LIMIT 1';
  const [rows] = await pool.query(sql, params);
  return rows[0] || null;
}

async function activeCodes(table) {
  assertTable(table);
  const [rows] = await pool.query(
    `SELECT code FROM ${table} WHERE is_active = 1 AND deleted_at IS NULL`,
  );
  return rows.map((r) => r.code);
}

async function codeTaken(table, code, excludeId = null) {
  assertTable(table);
  const params = [code];
  let sql = `SELECT id FROM ${table} WHERE code = ? AND deleted_at IS NULL`;
  if (excludeId !== null) {
    sql += ' AND id <> ?';
    params.push(excludeId);
  }
  sql += ' LIMIT 1';
  const [rows] = await pool.query(sql, params);
  return rows.length > 0;
}

async function create(table, { code, label, sortOrder, isActive }) {
  assertTable(table);
  const [r] = await pool.query(
    `INSERT INTO ${table} (code, label, sort_order, is_active) VALUES (?, ?, ?, ?)`,
    [code, label, sortOrder ?? 0, isActive ? 1 : 0],
  );
  return r.insertId;
}

async function update(table, id, { code, label, sortOrder, isActive }) {
  assertTable(table);
  await pool.query(
    `UPDATE ${table} SET code = ?, label = ?, sort_order = ?, is_active = ?
     WHERE id = ? AND deleted_at IS NULL`,
    [code, label, sortOrder ?? 0, isActive ? 1 : 0, id],
  );
}

async function softDelete(table, id) {
  assertTable(table);
  await pool.query(
    `UPDATE ${table} SET deleted_at = NOW(), is_active = 0
     WHERE id = ? AND deleted_at IS NULL`,
    [id],
  );
}

async function labelTaken(table, label, excludeId = null) {
  assertTable(table);
  const params = [label.toLowerCase()];
  let sql = `SELECT id FROM ${table} WHERE LOWER(label) = ? AND deleted_at IS NULL`;
  if (excludeId !== null) {
    sql += ' AND id <> ?';
    params.push(excludeId);
  }
  sql += ' LIMIT 1';
  const [rows] = await pool.query(sql, params);
  return rows.length > 0;
}

module.exports = {
  ALLOWED_TABLES,
  list,
  listAll,
  findById,
  findByCode,
  findByLabel,
  activeCodes,
  codeTaken,
  labelTaken,
  create,
  update,
  softDelete,
};
