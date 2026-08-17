const { pool } = require('../pool');

// T-2026-173: rows now carry access_level ENUM('read','write'). Pre-migration
// callers that just want the module keys can still do `.map((r) => r.module_key)`
// on the returned array — the shape is a superset of the legacy shape.
async function listForSubAdmin(subAdminId) {
  const [rows] = await pool.query(
    `SELECT module_key, access_level
       FROM sub_admin_modules
      WHERE sub_admin_id = ?`,
    [subAdminId],
  );
  return rows.map((r) => ({
    module_key: r.module_key,
    access_level: r.access_level === 'write' ? 'write' : 'read',
  }));
}

// Legacy convenience: returns just the module keys the sub-admin has ANY
// grant on (read OR write). Used by services that only care about "can this
// sub-admin see this module" and don't need the read/write distinction.
// KEPT so services/db/queries/sub_admins.js#listAssignableForLeads and
// similar callers don't need to be rewritten (they already only care about
// presence, not level).
async function listKeysForSubAdmin(subAdminId) {
  const rows = await listForSubAdmin(subAdminId);
  return rows.map((r) => r.module_key);
}

// T-2026-173: replaceForSubAdmin now accepts EITHER shape:
//   - Legacy: array of plain strings (e.g. ['inventory_management', 'crm_management'])
//     → each entry becomes { module_key, access_level: 'write' } (matches
//       migration 110 DEFAULT + preserves pre-T-173 behavior where every
//       grant was implicitly full write).
//   - New:    array of { module_key, access_level } objects
//     → written verbatim, subject to validation upstream.
// Dedupe is by module_key; if the caller sends the same key twice with
// different levels the LATER entry wins.
async function replaceForSubAdmin(subAdminId, grants) {
  const normalized = normalizeGrants(grants);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM sub_admin_modules WHERE sub_admin_id = ?', [subAdminId]);
    if (normalized.length > 0) {
      const values = normalized.map(() => '(?, ?, ?)').join(', ');
      const params = normalized.flatMap((g) => [subAdminId, g.module_key, g.access_level]);
      await conn.query(
        `INSERT INTO sub_admin_modules (sub_admin_id, module_key, access_level) VALUES ${values}`,
        params,
      );
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

function normalizeGrants(input) {
  if (!Array.isArray(input)) return [];
  const byKey = new Map();
  for (const entry of input) {
    if (typeof entry === 'string' && entry.length > 0) {
      byKey.set(entry, { module_key: entry, access_level: 'write' });
      continue;
    }
    if (entry && typeof entry === 'object' && typeof entry.module_key === 'string') {
      const level = entry.access_level === 'read' ? 'read' : 'write';
      byKey.set(entry.module_key, { module_key: entry.module_key, access_level: level });
    }
  }
  return Array.from(byKey.values());
}

module.exports = {
  listForSubAdmin,
  listKeysForSubAdmin,
  replaceForSubAdmin,
  normalizeGrants,
};
