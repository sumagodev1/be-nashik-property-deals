/**
 * DB layer for the Document Directory module.
 *
 * Soft-delete + pagination + LIKE-search across document_name,
 * original_filename and extension. Only active (non-soft-deleted) rows
 * are returned. Binary content is written to disk under the storage_path
 * — this table stores only metadata.
 */

const { pool } = require('../pool');

const COLUMNS = `
  id, document_id, document_name, description, category, tags,
  original_filename, stored_filename, extension, mime_type,
  file_size, storage_path, uploaded_by, status,
  created_at, updated_at
`;

const SORTABLE_COLUMNS = {
  document_id: 'document_id',
  document_name: 'document_name',
  original_filename: 'original_filename',
  extension: 'extension',
  file_size: 'file_size',
  created_at: 'created_at',
  status: 'status',
};

async function list({
  page = 1,
  pageSize = 10,
  search = '',
  sortBy = 'created_at',
  sortDir = 'desc',
} = {}) {
  const offset = (page - 1) * pageSize;
  const args = [];
  let where = 'WHERE deleted_at IS NULL';
  const q = typeof search === 'string' ? search.trim() : '';
  if (q) {
    where += ` AND (document_name LIKE ? OR original_filename LIKE ? OR extension LIKE ?)`;
    const like = `%${q}%`;
    args.push(like, like, like);
  }

  const sortCol = SORTABLE_COLUMNS[sortBy] || 'created_at';
  const direction = String(sortDir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM documents ${where}`,
    args,
  );
  const [rows] = await pool.query(
    `SELECT ${COLUMNS} FROM documents ${where}
     ORDER BY ${sortCol} ${direction}, id DESC
     LIMIT ? OFFSET ?`,
    [...args, Number(pageSize), Number(offset)],
  );
  return { data: rows, total: Number(total), page: Number(page), pageSize: Number(pageSize) };
}

async function getById(id) {
  const [rows] = await pool.query(
    `SELECT ${COLUMNS} FROM documents
     WHERE id = ? AND deleted_at IS NULL`,
    [id],
  );
  return rows[0] || null;
}

async function existsByDocumentId(docId) {
  const [rows] = await pool.query(
    `SELECT id FROM documents WHERE document_id = ? LIMIT 1`,
    [docId],
  );
  return rows.length > 0;
}

async function create(payload) {
  const [r] = await pool.query(
    `INSERT INTO documents (
      document_id, document_name, description, category, tags,
      original_filename, stored_filename, extension, mime_type,
      file_size, storage_path, uploaded_by, status
    ) VALUES (?,?,?,?,?, ?,?,?,?, ?,?,?,?)`,
    [
      payload.documentId,
      payload.documentName,
      payload.description || null,
      payload.category || null,
      payload.tags || null,
      payload.originalFilename,
      payload.storedFilename,
      payload.extension || null,
      payload.mimeType || null,
      Number(payload.fileSize) || 0,
      payload.storagePath,
      payload.uploadedBy || null,
      payload.status || 'active',
    ],
  );
  return getById(r.insertId);
}

async function updateMetadata(id, payload) {
  await pool.query(
    `UPDATE documents SET
       document_name = COALESCE(?, document_name),
       description   = ?,
       category      = ?,
       tags          = ?,
       status        = COALESCE(?, status)
     WHERE id = ? AND deleted_at IS NULL`,
    [
      payload.documentName ?? null,
      payload.description ?? null,
      payload.category ?? null,
      payload.tags ?? null,
      payload.status ?? null,
      id,
    ],
  );
  return getById(id);
}

async function softDelete(id) {
  await pool.query(
    `UPDATE documents SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [id],
  );
}

module.exports = {
  list,
  getById,
  existsByDocumentId,
  create,
  updateMetadata,
  softDelete,
};
