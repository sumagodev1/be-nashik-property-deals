const { pool } = require('../pool');

async function create({ kind, title, body, relatedKind, relatedId, moduleKey }) {
  const [result] = await pool.query(
    `INSERT INTO notifications (kind, title, body, related_kind, related_id, module_key)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [kind, title, body || null, relatedKind || null, relatedId || null, moduleKey || null],
  );
  return result.insertId;
}

/**
 * List notifications, newest first. Optionally scoped to:
 *   - allowedModules — array of module keys (sub-admins only see notifications
 *     whose module_key is null OR in their list). Pass null for admin (sees all).
 *   - isRead — true/false to filter, undefined for all.
 * Returns { rows, total }.
 */
async function list({ allowedModules, isRead, limit = 50, offset = 0 }) {
  const where = [];
  const params = [];

  if (Array.isArray(allowedModules)) {
    if (allowedModules.length === 0) {
      where.push('module_key IS NULL');
    } else {
      where.push('(module_key IS NULL OR module_key IN (?))');
      params.push(allowedModules);
    }
  }
  if (typeof isRead === 'boolean') {
    where.push('is_read = ?');
    params.push(isRead ? 1 : 0);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM notifications ${whereSql}`,
    params,
  );

  const [rows] = await pool.query(
    `SELECT id, kind, title, body, related_kind, related_id, module_key, is_read, created_at
     FROM notifications
     ${whereSql}
     ORDER BY created_at DESC, id DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  return { rows, total };
}

async function unreadCount({ allowedModules }) {
  const where = ['is_read = 0'];
  const params = [];

  if (Array.isArray(allowedModules)) {
    if (allowedModules.length === 0) {
      where.push('module_key IS NULL');
    } else {
      where.push('(module_key IS NULL OR module_key IN (?))');
      params.push(allowedModules);
    }
  }

  const [[{ count }]] = await pool.query(
    `SELECT COUNT(*) AS count FROM notifications WHERE ${where.join(' AND ')}`,
    params,
  );
  return Number(count);
}

async function markRead(id) {
  const [result] = await pool.query(
    `UPDATE notifications SET is_read = 1 WHERE id = ?`,
    [id],
  );
  return result.affectedRows > 0;
}

async function markAllRead({ allowedModules }) {
  const where = ['is_read = 0'];
  const params = [];

  if (Array.isArray(allowedModules)) {
    if (allowedModules.length === 0) {
      where.push('module_key IS NULL');
    } else {
      where.push('(module_key IS NULL OR module_key IN (?))');
      params.push(allowedModules);
    }
  }

  const [result] = await pool.query(
    `UPDATE notifications SET is_read = 1 WHERE ${where.join(' AND ')}`,
    params,
  );
  return result.affectedRows;
}

module.exports = { create, list, unreadCount, markRead, markAllRead };
