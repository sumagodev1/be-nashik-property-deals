const { pool } = require('../pool');

/**
 * Append a row to `audit_log`. Never throws — failures are swallowed and
 * logged to stderr so audit-log issues can never block the actual mutation
 * being recorded. Callers should use the higher-level `services/admin/audit`
 * helper, not this directly.
 */
async function append({ actorType, actorId, actorName, action, entityType, entityId, summary, metadata, ipAddress }) {
  try {
    await pool.query(
      `INSERT INTO audit_log
         (actor_type, actor_id, actor_name, action, entity_type, entity_id, summary, metadata, ip_address)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        actorType,
        actorId,
        actorName || null,
        action,
        entityType,
        entityId || null,
        summary || null,
        metadata ? JSON.stringify(metadata) : null,
        ipAddress || null,
      ],
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[audit-log] append failed:', err.message);
  }
}

async function list({ page = 1, pageSize = 25, action, entityType, entityId, actorType, actorId, search, dateFrom, dateTo }) {
  const offset = (page - 1) * pageSize;
  const where = [];
  const params = [];
  if (action)     { where.push('action = ?');        params.push(action); }
  if (entityType) { where.push('entity_type = ?');   params.push(entityType); }
  if (entityId)   { where.push('entity_id = ?');     params.push(entityId); }
  if (actorType)  { where.push('actor_type = ?');    params.push(actorType); }
  if (actorId)    { where.push('actor_id = ?');      params.push(actorId); }
  if (search) {
    where.push('(actor_name LIKE ? OR summary LIKE ? OR action LIKE ? OR entity_type LIKE ?)');
    const s = `%${search}%`;
    params.push(s, s, s, s);
  }
  if (dateFrom) { where.push('created_at >= ?'); params.push(dateFrom); }
  if (dateTo)   { where.push('created_at < DATE_ADD(?, INTERVAL 1 DAY)'); params.push(dateTo); }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM audit_log ${whereSql}`,
    params,
  );

  const [rows] = await pool.query(
    `SELECT id, actor_type, actor_id, actor_name, action, entity_type, entity_id,
            summary, metadata, ip_address, created_at
     FROM audit_log
     ${whereSql}
     ORDER BY created_at DESC, id DESC
     LIMIT ? OFFSET ?`,
    [...params, pageSize, offset],
  );

  return { rows, total };
}

// Distinct action / entity_type values actually present in the log.
//
// The Audit Log filter dropdowns used to be hardcoded <option> lists, which
// drifted the moment a module started emitting a new action - the masters
// layer alone contributes one entity_type per master vocabulary
// ("master:<key>"), which can never be enumerated by hand. Deriving the
// options from the data keeps them exhaustive by construction, and means
// every option is guaranteed to return rows (no dead choices).
//
// Trade-off, deliberate: an action that has never occurred does not appear.
// That is the correct behaviour for a FILTER - offering a choice that can
// only ever return "no results" is worse than omitting it.
//
// Two cheap indexed DISTINCTs (ix_audit_log_action exists; entity_type is
// the leading column of ix_audit_log_entity), run in parallel.
async function facets() {
  const [[actions], [entities]] = await Promise.all([
    pool.query('SELECT DISTINCT action FROM audit_log ORDER BY action ASC'),
    pool.query('SELECT DISTINCT entity_type FROM audit_log ORDER BY entity_type ASC'),
  ]);
  return {
    actions: actions.map((r) => r.action).filter(Boolean),
    entityTypes: entities.map((r) => r.entity_type).filter(Boolean),
  };
}

module.exports = { append, list, facets };
