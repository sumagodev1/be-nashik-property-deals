const { pool } = require('../pool');

async function listForProperty(conn, propertyKind, propertyId) {
  const c = conn || pool;
  const [rows] = await c.query(
    `SELECT id, original_name, stored_name, mime_type, size_bytes, sort_order, created_at
     FROM property_files
     WHERE property_kind = ? AND property_id = ? AND file_kind = 'image'
     ORDER BY sort_order ASC, id ASC`,
    [propertyKind, propertyId],
  );
  return rows;
}

// Sibling lister for amenity thumbnails — same table, different file_kind.
// The amenity label is stored in `original_name`.
async function listAmenitiesForProperty(conn, propertyKind, propertyId) {
  const c = conn || pool;
  const [rows] = await c.query(
    `SELECT id, original_name, stored_name, mime_type, size_bytes, sort_order, created_at
     FROM property_files
     WHERE property_kind = ? AND property_id = ? AND file_kind = 'amenity'
     ORDER BY sort_order ASC, id ASC`,
    [propertyKind, propertyId],
  );
  return rows;
}

async function insertMany(conn, rows) {
  if (rows.length === 0) return [];
  const placeholders = rows.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
  const params = rows.flatMap((r) => [
    r.property_kind,
    r.property_id,
    r.file_kind,
    r.original_name,
    r.stored_name,
    r.mime_type,
    r.size_bytes,
    r.sort_order,
  ]);
  await conn.query(
    `INSERT INTO property_files (property_kind, property_id, file_kind, original_name, stored_name, mime_type, size_bytes, sort_order)
     VALUES ${placeholders}`,
    params,
  );
}

async function findById(conn, id) {
  const c = conn || pool;
  const [rows] = await c.query(
    `SELECT id, property_kind, property_id, original_name, stored_name, mime_type, size_bytes
     FROM property_files
     WHERE id = ?
     LIMIT 1`,
    [id],
  );
  return rows[0] || null;
}

async function deleteById(conn, id) {
  await conn.query('DELETE FROM property_files WHERE id = ?', [id]);
}

async function deleteAllForProperty(conn, propertyKind, propertyId) {
  const [rows] = await conn.query(
    `SELECT id, stored_name, size_bytes FROM property_files
     WHERE property_kind = ? AND property_id = ?`,
    [propertyKind, propertyId],
  );
  await conn.query('DELETE FROM property_files WHERE property_kind = ? AND property_id = ?', [
    propertyKind,
    propertyId,
  ]);
  return rows;
}

async function maxSortOrder(conn, propertyKind, propertyId) {
  const c = conn || pool;
  const [[row]] = await c.query(
    `SELECT COALESCE(MAX(sort_order), -1) AS max_sort FROM property_files
     WHERE property_kind = ? AND property_id = ?`,
    [propertyKind, propertyId],
  );
  return row.max_sort;
}

module.exports = { listForProperty, listAmenitiesForProperty, insertMany, findById, deleteById, deleteAllForProperty, maxSortOrder };
