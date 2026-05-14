/**
 * Singleton-row tracker for total uploaded bytes. Bounded by env
 * UPLOAD_TOTAL_QUOTA_BYTES (500 MB by default).
 *
 * Always call these inside an outer transaction when concurrent writes
 * are possible — the SELECT FOR UPDATE locks the singleton row.
 */

async function getUsedBytes(conn) {
  const [rows] = await conn.query('SELECT used_bytes FROM storage_usage WHERE id = 1 FOR UPDATE');
  return rows[0] ? Number(rows[0].used_bytes) : 0;
}

async function addBytes(conn, delta) {
  await conn.query('UPDATE storage_usage SET used_bytes = used_bytes + ? WHERE id = 1', [delta]);
}

async function subtractBytes(conn, delta) {
  await conn.query('UPDATE storage_usage SET used_bytes = GREATEST(0, used_bytes - ?) WHERE id = 1', [delta]);
}

module.exports = { getUsedBytes, addBytes, subtractBytes };
