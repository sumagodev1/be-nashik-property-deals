const { pool } = require('../pool');

async function create({ kind, title, body, relatedKind, relatedId, moduleKey, targetActorType, targetActorId }) {
  const [result] = await pool.query(
    `INSERT INTO notifications
       (kind, title, body, related_kind, related_id, module_key, target_actor_type, target_actor_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      kind,
      title,
      body || null,
      relatedKind || null,
      relatedId || null,
      moduleKey || null,
      targetActorType || null,
      targetActorId || null,
    ],
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
/**
 * Build the visibility WHERE fragment for a caller. A notification is visible
 * if EITHER:
 *   - it has no target_actor (broadcast) AND the module check passes, OR
 *   - it's privately targeted at this exact caller (regardless of module).
 *
 * `actor` shape: { type: 'admin' | 'sub_admin', id: number } — optional;
 * when omitted, only the broadcast-by-module rule applies (legacy behaviour).
 */
function buildVisibilityWhere({ allowedModules, actor }) {
  const broadcastClauses = ['target_actor_type IS NULL'];
  const broadcastParams = [];
  if (Array.isArray(allowedModules)) {
    if (allowedModules.length === 0) {
      broadcastClauses.push('module_key IS NULL');
    } else {
      broadcastClauses.push('(module_key IS NULL OR module_key IN (?))');
      broadcastParams.push(allowedModules);
    }
  }
  const broadcastSql = `(${broadcastClauses.join(' AND ')})`;

  if (actor && actor.type && actor.id) {
    return {
      sql: `(${broadcastSql} OR (target_actor_type = ? AND target_actor_id = ?))`,
      params: [...broadcastParams, actor.type, actor.id],
    };
  }
  return { sql: broadcastSql, params: broadcastParams };
}

async function list({ allowedModules, actor, isRead, limit = 50, offset = 0 }) {
  const where = [];
  const params = [];

  const vis = buildVisibilityWhere({ allowedModules, actor });
  where.push(vis.sql);
  params.push(...vis.params);

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
    `SELECT id, kind, title, body, related_kind, related_id, module_key,
            target_actor_type, target_actor_id, is_read, created_at
     FROM notifications
     ${whereSql}
     ORDER BY created_at DESC, id DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  return { rows, total };
}

async function unreadCount({ allowedModules, actor }) {
  const vis = buildVisibilityWhere({ allowedModules, actor });
  const [[{ count }]] = await pool.query(
    `SELECT COUNT(*) AS count FROM notifications WHERE is_read = 0 AND ${vis.sql}`,
    vis.params,
  );
  return Number(count);
}

// Scope-aware mark-read. The same `allowedModules` shape used by list() /
// unreadCount() / markAllRead() — admin (null) sees everything; sub-admin
// (array) can only touch rows whose module_key is null OR in their list.
// Returns true only if a row was actually flipped — false means the row
// didn't exist OR was outside the caller's scope (caller treats both as 404).
async function markRead(id, { allowedModules, actor } = {}) {
  const vis = buildVisibilityWhere({ allowedModules, actor });
  const [result] = await pool.query(
    `UPDATE notifications SET is_read = 1 WHERE id = ? AND ${vis.sql}`,
    [id, ...vis.params],
  );
  return result.affectedRows > 0;
}

async function markAllRead({ allowedModules, actor }) {
  const vis = buildVisibilityWhere({ allowedModules, actor });
  const [result] = await pool.query(
    `UPDATE notifications SET is_read = 1 WHERE is_read = 0 AND ${vis.sql}`,
    vis.params,
  );
  return result.affectedRows;
}

module.exports = { create, list, unreadCount, markRead, markAllRead };
