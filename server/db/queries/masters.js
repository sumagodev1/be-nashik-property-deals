/**
 * Generic CRUD over the master_* tables. The four legacy single-vocabulary
 * tables (property_types / transaction_types / flat_types / status_types)
 * and the multi-vocabulary `master_lookups` table all share the same shape
 * (id, code, label, sort_order, is_active, timestamps, deleted_at).
 *
 * `master_lookups` additionally carries a `master_key` discriminator (which
 * vocabulary this row belongs to) and a `parent_code` (for hierarchical
 * masters: district → taluka → shivar). Every function below accepts an
 * optional `discriminator = { masterKey, parentCode }` — when provided, the
 * SQL is augmented with the corresponding WHERE/INSERT/UPDATE columns. When
 * omitted, behaviour is unchanged from the legacy single-table call.
 *
 * The table name is provided by the caller; we whitelist it to prevent SQL
 * injection.
 */

const { pool } = require('../pool');

const ALLOWED_TABLES = new Set([
  'master_property_types',
  'master_transaction_types',
  'master_flat_types',
  'master_status_types',
  'master_lookups',
]);

function assertTable(table) {
  if (!ALLOWED_TABLES.has(table)) {
    throw new Error(`masters.queries: table "${table}" is not whitelisted`);
  }
}

// Helper: builds the (where[], params[]) discriminator filter shared by every
// read query. Passing `discriminator: { masterKey: 'floor_level' }` adds
// `master_key = ?` to the WHERE clause; passing parentCode adds it too.
function applyDiscriminator(where, params, discriminator) {
  if (!discriminator) return;
  if (discriminator.masterKey) {
    where.push('master_key = ?');
    params.push(discriminator.masterKey);
  }
  if (discriminator.parentCode !== undefined && discriminator.parentCode !== null) {
    where.push('parent_code = ?');
    params.push(discriminator.parentCode);
  }
}

// T-2026-045: description column exists ONLY on master_status_types today.
// Central helper so every SELECT/INSERT/UPDATE stays consistent. Extend the
// Set below to widen support to more tables in future.
const TABLES_WITH_DESCRIPTION = new Set(["master_status_types"]);
function hasDescription(table) { return TABLES_WITH_DESCRIPTION.has(table); }
function descCol(table) { return hasDescription(table) ? ", description" : ""; }

// Whitelist for the list() sort param (T-2026-045).
const SORT_COLUMNS = {
  name:      "label",
  createdAt: "created_at",
  status:    "is_active",
};
function buildOrderBy(sort) {
  if (!sort) return "ORDER BY sort_order ASC, label ASC, id ASC";
  const parts = String(sort).split(":");
  const col = SORT_COLUMNS[parts[0]];
  if (!col) return "ORDER BY sort_order ASC, label ASC, id ASC";
  const dir = (parts[1] || "asc").toLowerCase() === "desc" ? "DESC" : "ASC";
  return "ORDER BY " + col + " " + dir + ", id ASC";
}

async function list(table, { search, isActive, page = 1, pageSize = 10, discriminator, sort } = {}) {
  assertTable(table);
  const where = ['deleted_at IS NULL'];
  const params = [];
  applyDiscriminator(where, params, discriminator);
  if (search) {
    // T-2026-045: also match description when the column exists (status_type).
    if (hasDescription(table)) {
      where.push('(code LIKE ? OR label LIKE ? OR description LIKE ?)');
      const s = `%${search}%`;
      params.push(s, s, s);
    } else {
      where.push('(code LIKE ? OR label LIKE ?)');
      const s = `%${search}%`;
      params.push(s, s);
    }
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
  const orderBy = buildOrderBy(sort);
  const [rows] = await pool.query(
    `SELECT id, code, label${descCol(table)}, sort_order, is_active, created_at, updated_at${table === 'master_lookups' ? ', parent_code' : ''}
     FROM ${table}
     ${whereSql}
     ${orderBy}
     LIMIT ? OFFSET ?`,
    [...params, pageSize, offset],
  );
  return { rows, total };
}

async function listAll(table, { isActive, discriminator } = {}) {
  assertTable(table);
  const where = ['deleted_at IS NULL'];
  const params = [];
  applyDiscriminator(where, params, discriminator);
  if (typeof isActive === 'boolean') {
    where.push('is_active = ?');
    params.push(isActive ? 1 : 0);
  }
  const [rows] = await pool.query(
    `SELECT id, code, label${descCol(table)}, sort_order, is_active, created_at, updated_at${table === 'master_lookups' ? ', parent_code' : ''}
     FROM ${table}
     WHERE ${where.join(' AND ')}
     ORDER BY sort_order ASC, label ASC, id ASC`,
    params,
  );
  return rows;
}

async function findById(table, id, { discriminator } = {}) {
  assertTable(table);
  const where = ['id = ?', 'deleted_at IS NULL'];
  const params = [id];
  applyDiscriminator(where, params, discriminator);
  const [rows] = await pool.query(
    `SELECT id, code, label${descCol(table)}, sort_order, is_active, created_at, updated_at${table === 'master_lookups' ? ', parent_code' : ''}
     FROM ${table} WHERE ${where.join(' AND ')} LIMIT 1`,
    params,
  );
  return rows[0] || null;
}

async function findByCode(table, code, { discriminator } = {}) {
  assertTable(table);
  const where = ['code = ?', 'deleted_at IS NULL'];
  const params = [code];
  applyDiscriminator(where, params, discriminator);
  const [rows] = await pool.query(
    `SELECT id, code, label, sort_order, is_active${table === 'master_lookups' ? ', parent_code' : ''}
     FROM ${table} WHERE ${where.join(' AND ')} LIMIT 1`,
    params,
  );
  return rows[0] || null;
}

// Find a SOFT-DELETED row with the given code — used by `create` to revive
// a deleted entry instead of colliding with the DB unique key on
// (master_key, code). The `code` column is not cleared on soft-delete, so
// re-inserting the same code hits ER_DUP_ENTRY at the MySQL layer even
// though the app-level `findByCode` reports no conflict.
async function findDeletedByCode(table, code, { discriminator } = {}) {
  assertTable(table);
  const where = ['code = ?', 'deleted_at IS NOT NULL'];
  const params = [code];
  applyDiscriminator(where, params, discriminator);
  const [rows] = await pool.query(
    `SELECT id, code, label, sort_order, is_active${table === 'master_lookups' ? ', parent_code' : ''}
     FROM ${table} WHERE ${where.join(' AND ')} LIMIT 1`,
    params,
  );
  return rows[0] || null;
}

async function findDeletedByLabel(table, label, { discriminator } = {}) {
  assertTable(table);
  const where = ['LOWER(label) = ?', 'deleted_at IS NOT NULL'];
  const params = [String(label).toLowerCase()];
  applyDiscriminator(where, params, discriminator);
  const [rows] = await pool.query(
    `SELECT id, code, label, sort_order, is_active${table === 'master_lookups' ? ', parent_code' : ''}
     FROM ${table} WHERE ${where.join(' AND ')} LIMIT 1`,
    params,
  );
  return rows[0] || null;
}

// Revive a soft-deleted row: clear deleted_at and set is_active=1 (plus
// update the mutable fields with the fresh payload). Used by
// masters/management.js `create` so re-adding a deleted entry works
// without the caller having to know a soft-deleted twin ever existed.
async function revive(table, id, { code, label, sortOrder, isActive, parentCode, description }) {
  assertTable(table);
  if (table === 'master_lookups') {
    await pool.query(
      `UPDATE master_lookups
         SET code = ?, label = ?, parent_code = ?, sort_order = ?,
             is_active = ?, deleted_at = NULL
       WHERE id = ?`,
      [code, label, parentCode ?? null, sortOrder ?? 0, isActive ? 1 : 0, id],
    );
    return;
  }
  if (hasDescription(table)) {
    await pool.query(
      `UPDATE ${table}
         SET code = ?, label = ?, description = ?, sort_order = ?, is_active = ?, deleted_at = NULL
       WHERE id = ?`,
      [code, label, normalizeDescription(description), sortOrder ?? 0, isActive ? 1 : 0, id],
    );
    return;
  }
  await pool.query(
    `UPDATE ${table}
       SET code = ?, label = ?, sort_order = ?, is_active = ?, deleted_at = NULL
     WHERE id = ?`,
    [code, label, sortOrder ?? 0, isActive ? 1 : 0, id],
  );
}

// Case-insensitive lookup by label. Returns the row (with is_active) so the
// caller can give the admin a useful "already exists" error that says
// whether the conflicting row is active or inactive and what its id is.
async function findByLabel(table, label, excludeId = null, { discriminator } = {}) {
  assertTable(table);
  const where = ['LOWER(label) = ?', 'deleted_at IS NULL'];
  const params = [String(label).toLowerCase()];
  applyDiscriminator(where, params, discriminator);
  let sql = `SELECT id, code, label, sort_order, is_active${table === 'master_lookups' ? ', parent_code' : ''}
             FROM ${table} WHERE ${where.join(' AND ')}`;
  if (excludeId !== null) {
    sql += ' AND id <> ?';
    params.push(excludeId);
  }
  sql += ' LIMIT 1';
  const [rows] = await pool.query(sql, params);
  return rows[0] || null;
}

async function activeCodes(table, { discriminator } = {}) {
  assertTable(table);
  const where = ['is_active = 1', 'deleted_at IS NULL'];
  const params = [];
  applyDiscriminator(where, params, discriminator);
  const [rows] = await pool.query(
    `SELECT code FROM ${table} WHERE ${where.join(' AND ')}`,
    params,
  );
  return rows.map((r) => r.code);
}

async function codeTaken(table, code, excludeId = null, { discriminator } = {}) {
  assertTable(table);
  const where = ['code = ?', 'deleted_at IS NULL'];
  const params = [code];
  applyDiscriminator(where, params, discriminator);
  let sql = `SELECT id FROM ${table} WHERE ${where.join(' AND ')}`;
  if (excludeId !== null) {
    sql += ' AND id <> ?';
    params.push(excludeId);
  }
  sql += ' LIMIT 1';
  const [rows] = await pool.query(sql, params);
  return rows.length > 0;
}

async function create(table, { code, label, sortOrder, isActive, masterKey, parentCode, description }) {
  assertTable(table);
  if (table === 'master_lookups') {
    const [r] = await pool.query(
      `INSERT INTO master_lookups (master_key, code, label, parent_code, sort_order, is_active)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [masterKey, code, label, parentCode ?? null, sortOrder ?? 0, isActive ? 1 : 0],
    );
    return r.insertId;
  }
  if (hasDescription(table)) {
    const [r] = await pool.query(
      `INSERT INTO ${table} (code, label, description, sort_order, is_active) VALUES (?, ?, ?, ?, ?)`,
      [code, label, normalizeDescription(description), sortOrder ?? 0, isActive ? 1 : 0],
    );
    return r.insertId;
  }
  const [r] = await pool.query(
    `INSERT INTO ${table} (code, label, sort_order, is_active) VALUES (?, ?, ?, ?)`,
    [code, label, sortOrder ?? 0, isActive ? 1 : 0],
  );
  return r.insertId;
}

// T-2026-045: trim/coerce description to NULL when empty/whitespace, cap at 255.
function normalizeDescription(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.slice(0, 255);
}

async function update(table, id, { code, label, sortOrder, isActive, parentCode, description }, { discriminator } = {}) {
  assertTable(table);
  const where = ['id = ?', 'deleted_at IS NULL'];
  const params = [];
  if (table === 'master_lookups') {
    params.push(
      code,
      label,
      parentCode ?? null,
      sortOrder ?? 0,
      isActive ? 1 : 0,
      id,
    );
    applyDiscriminator(where, params, discriminator);
    await pool.query(
      `UPDATE master_lookups
         SET code = ?, label = ?, parent_code = ?, sort_order = ?, is_active = ?
       WHERE ${where.join(' AND ')}`,
      params,
    );
    return;
  }
  if (hasDescription(table)) {
    await pool.query(
      `UPDATE ${table} SET code = ?, label = ?, description = ?, sort_order = ?, is_active = ?
       WHERE id = ? AND deleted_at IS NULL`,
      [code, label, normalizeDescription(description), sortOrder ?? 0, isActive ? 1 : 0, id],
    );
    return;
  }
  await pool.query(
    `UPDATE ${table} SET code = ?, label = ?, sort_order = ?, is_active = ?
     WHERE id = ? AND deleted_at IS NULL`,
    [code, label, sortOrder ?? 0, isActive ? 1 : 0, id],
  );
}

async function softDelete(table, id, { discriminator } = {}) {
  assertTable(table);
  const where = ['id = ?', 'deleted_at IS NULL'];
  const params = [id];
  applyDiscriminator(where, params, discriminator);
  await pool.query(
    `UPDATE ${table} SET deleted_at = NOW(), is_active = 0
     WHERE ${where.join(' AND ')}`,
    params,
  );
}

async function labelTaken(table, label, excludeId = null, { discriminator } = {}) {
  assertTable(table);
  const where = ['LOWER(label) = ?', 'deleted_at IS NULL'];
  const params = [label.toLowerCase()];
  applyDiscriminator(where, params, discriminator);
  let sql = `SELECT id FROM ${table} WHERE ${where.join(' AND ')}`;
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
  TABLES_WITH_DESCRIPTION,
  hasDescription,
  list,
  listAll,
  findById,
  findByCode,
  findByLabel,
  findDeletedByCode,
  findDeletedByLabel,
  activeCodes,
  codeTaken,
  labelTaken,
  create,
  update,
  revive,
  softDelete,
};
