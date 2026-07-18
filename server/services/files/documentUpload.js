/**
 * Document uploads for properties + seller agents.
 *   - Inventory / Website properties → property_files (file_kind='document'),
 *     stored privately under uploads/private/<kind>/.
 *   - Seller agents → seller_documents.
 *
 * Documents are PRIVATE (auth-required) — they're business records, not
 * public listings. Served by a streaming endpoint (see routes).
 *
 * Magic-byte validation for PDF + the same image set we already support.
 */

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const { pool } = require('../../db/pool');
const propertyFiles = require('../../db/queries/property_files');
const storageUsage = require('../../db/queries/storage_usage');
const { HttpError } = require('../../middleware/errors');
const {
  ALLOWED_DOC_MIMES_EXTENDED,
  DOC_MIME_TO_EXT,
  detectDocumentMime,
} = require('../../constants/property');

// T-2026-048: per-file cap raised to 5 MB (spec). Env override still applies.
const MAX_FILE_BYTES = Number(process.env.UPLOAD_MAX_FILE_BYTES) || 5 * 1024 * 1024;
const TOTAL_QUOTA_BYTES = Number(process.env.UPLOAD_TOTAL_QUOTA_BYTES) || 500 * 1024 * 1024;
const PRIVATE_DIR = process.env.UPLOAD_PRIVATE_DIR || 'uploads/private';

// Per-property document cap (spec: max 5). Applied additively.
const MAX_DOCS_PER_PROPERTY = Number(process.env.UPLOAD_MAX_DOCS_PER_PROPERTY) || 5;

// T-2026-048: expanded allowlist and MIME→ext map come from
// constants/property.js so the same tables are reachable by the frontend
// (via a public constants endpoint) and by tests.
const ALLOWED_DOC_MIMES = ALLOWED_DOC_MIMES_EXTENDED;
const MIME_TO_EXT = DOC_MIME_TO_EXT;

function appRoot() { return path.resolve(__dirname, '..', '..', '..'); }
function ensureDirSync(dir) { fs.mkdirSync(dir, { recursive: true }); }
function privateSubdir(kind) { return path.join(appRoot(), PRIVATE_DIR, kind); }

function validateFile({ originalname, buffer, size }) {
  if (size > MAX_FILE_BYTES) {
    throw new HttpError(400, 'FILE_TOO_LARGE', `"${originalname}" exceeds the ${MAX_FILE_BYTES}-byte per-file limit`);
  }
  const detected = detectDocumentMime(buffer, originalname);
  if (!detected || !ALLOWED_DOC_MIMES.includes(detected)) {
    throw new HttpError(
      400,
      'UNSUPPORTED_FORMAT',
      `"${originalname}" is not a supported document (PDF, DOC, DOCX, XLS, XLSX, CSV, PPT, PPTX, TXT, ZIP, RAR, JPG, PNG)`,
    );
  }
  return detected;
}

/**
 * Save a batch of documents to a property (inventory or website).
 * Writes to uploads/private/<propertyKind>/ — NEVER served as static.
 */
async function persistPropertyDocuments({ propertyKind, propertyId, files }) {
  if (!files || files.length === 0) return [];

  const validated = files.map((f) => ({ ...f, detectedMime: validateFile(f) }));

  // T-2026-048: enforce per-property document cap.
  const existing = await listPropertyDocuments(propertyKind, propertyId);
  if (existing.length + validated.length > MAX_DOCS_PER_PROPERTY) {
    throw new HttpError(
      400,
      'TOO_MANY_DOCUMENTS',
      `Uploading ${validated.length} document(s) would exceed the ${MAX_DOCS_PER_PROPERTY}-document cap per property (currently ${existing.length}).`,
    );
  }

  const totalDelta = validated.reduce((acc, f) => acc + f.size, 0);
  const dir = privateSubdir(propertyKind);
  ensureDirSync(dir);

  const writtenPaths = [];
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const used = await storageUsage.getUsedBytes(conn);
    if (used + totalDelta > TOTAL_QUOTA_BYTES) {
      throw new HttpError(413, 'QUOTA_EXCEEDED', `Upload would exceed the ${TOTAL_QUOTA_BYTES}-byte total storage quota`);
    }
    let nextSort = (await propertyFiles.maxSortOrder(conn, propertyKind, propertyId)) + 1;
    const rows = [];
    for (const f of validated) {
      const ext = MIME_TO_EXT[f.detectedMime];
      const storedName = `${crypto.randomUUID()}.${ext}`;
      const fullPath = path.join(dir, storedName);
      await fsp.writeFile(fullPath, f.buffer);
      writtenPaths.push(fullPath);
      rows.push({
        property_kind: propertyKind,
        property_id: propertyId,
        file_kind: 'document',
        original_name: f.originalname.slice(0, 255),
        stored_name: `${propertyKind}/${storedName}`,
        mime_type: f.detectedMime,
        size_bytes: f.size,
        sort_order: nextSort++,
      });
    }
    await propertyFiles.insertMany(conn, rows);
    await storageUsage.addBytes(conn, totalDelta);
    await conn.commit();
    return rows;
  } catch (err) {
    await conn.rollback().catch(() => {});
    await Promise.all(writtenPaths.map((p) => fsp.unlink(p).catch(() => {})));
    throw err;
  } finally {
    conn.release();
  }
}

async function deletePropertyDocument({ fileId, propertyKind, propertyId }) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const file = await propertyFiles.findById(conn, fileId);
    if (!file || file.property_kind !== propertyKind || Number(file.property_id) !== Number(propertyId)) {
      throw new HttpError(404, 'NOT_FOUND', 'Document not found for this property');
    }
    await storageUsage.getUsedBytes(conn);
    await propertyFiles.deleteById(conn, fileId);
    await storageUsage.subtractBytes(conn, Number(file.size_bytes));
    await conn.commit();
    const absolute = path.join(appRoot(), PRIVATE_DIR, file.stored_name);
    await fsp.unlink(absolute).catch(() => {});
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

async function listPropertyDocuments(propertyKind, propertyId) {
  const [rows] = await pool.query(
    `SELECT id, original_name, stored_name, mime_type, size_bytes, sort_order, created_at
     FROM property_files
     WHERE property_kind = ? AND property_id = ? AND file_kind = 'document'
     ORDER BY sort_order ASC, id ASC`,
    [propertyKind, propertyId],
  );
  return rows;
}

/**
 * Stream a private property document to the authenticated caller. Caller
 * verifies access first (e.g. is admin/sub-admin with the right module).
 */
async function streamPropertyDocument(res, file) {
  const absolute = path.join(appRoot(), PRIVATE_DIR, file.stored_name);
  res.setHeader('Content-Type', file.mime_type);
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(file.original_name)}"`);
  res.setHeader('Cache-Control', 'private, max-age=0, no-cache');
  fs.createReadStream(absolute).on('error', () => { res.status(404).end(); }).pipe(res);
}

// ─────────── seller agent documents ───────────

async function persistSellerDocuments({ sellerId, files }) {
  if (!files || files.length === 0) return [];
  const validated = files.map((f) => ({ ...f, detectedMime: validateFile(f) }));
  const totalDelta = validated.reduce((acc, f) => acc + f.size, 0);
  const dir = privateSubdir('seller');
  ensureDirSync(dir);

  const writtenPaths = [];
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const used = await storageUsage.getUsedBytes(conn);
    if (used + totalDelta > TOTAL_QUOTA_BYTES) {
      throw new HttpError(413, 'QUOTA_EXCEEDED', `Upload would exceed the ${TOTAL_QUOTA_BYTES}-byte total storage quota`);
    }
    const rows = [];
    for (const f of validated) {
      const ext = MIME_TO_EXT[f.detectedMime];
      const storedName = `${crypto.randomUUID()}.${ext}`;
      const fullPath = path.join(dir, storedName);
      await fsp.writeFile(fullPath, f.buffer);
      writtenPaths.push(fullPath);
      await conn.query(
        `INSERT INTO seller_documents (seller_id, original_name, stored_name, mime_type, size_bytes)
         VALUES (?, ?, ?, ?, ?)`,
        [sellerId, f.originalname.slice(0, 255), `seller/${storedName}`, f.detectedMime, f.size],
      );
      rows.push({
        original_name: f.originalname,
        stored_name: `seller/${storedName}`,
        mime_type: f.detectedMime,
        size_bytes: f.size,
      });
    }
    await storageUsage.addBytes(conn, totalDelta);
    await conn.commit();
    return rows;
  } catch (err) {
    await conn.rollback().catch(() => {});
    await Promise.all(writtenPaths.map((p) => fsp.unlink(p).catch(() => {})));
    throw err;
  } finally {
    conn.release();
  }
}

async function listSellerDocuments(sellerId) {
  const [rows] = await pool.query(
    `SELECT id, original_name, stored_name, mime_type, size_bytes, created_at
     FROM seller_documents
     WHERE seller_id = ?
     ORDER BY id DESC`,
    [sellerId],
  );
  return rows;
}

async function findSellerDocumentById(id) {
  const [rows] = await pool.query(
    `SELECT id, seller_id, original_name, stored_name, mime_type, size_bytes
     FROM seller_documents WHERE id = ? LIMIT 1`,
    [id],
  );
  return rows[0] || null;
}

async function deleteSellerDocument(id) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query(
      `SELECT id, stored_name, size_bytes FROM seller_documents WHERE id = ? LIMIT 1`,
      [id],
    );
    if (rows.length === 0) {
      await conn.rollback();
      throw new HttpError(404, 'NOT_FOUND', 'Document not found');
    }
    const file = rows[0];
    await storageUsage.getUsedBytes(conn);
    await conn.query(`DELETE FROM seller_documents WHERE id = ?`, [id]);
    await storageUsage.subtractBytes(conn, Number(file.size_bytes));
    await conn.commit();
    const absolute = path.join(appRoot(), PRIVATE_DIR, file.stored_name);
    await fsp.unlink(absolute).catch(() => {});
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

async function streamSellerDocument(res, file) {
  const absolute = path.join(appRoot(), PRIVATE_DIR, file.stored_name);
  res.setHeader('Content-Type', file.mime_type);
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(file.original_name)}"`);
  res.setHeader('Cache-Control', 'private, max-age=0, no-cache');
  fs.createReadStream(absolute).on('error', () => { res.status(404).end(); }).pipe(res);
}

module.exports = {
  persistPropertyDocuments,
  deletePropertyDocument,
  listPropertyDocuments,
  streamPropertyDocument,
  persistSellerDocuments,
  listSellerDocuments,
  findSellerDocumentById,
  deleteSellerDocument,
  streamSellerDocument,
  ALLOWED_DOC_MIMES,
};
