const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const { pool } = require('../../db/pool');
const propertyFiles = require('../../db/queries/property_files');
const storageUsage = require('../../db/queries/storage_usage');
const { HttpError } = require('../../middleware/errors');
const { detectImageMime, ALLOWED_IMAGE_MIMES } = require('../../constants/property');

// T-2026-048: per-file cap raised to 5 MB (spec). Env override still
// applies so ops can dial it down without a code change.
const MAX_FILE_BYTES = Number(process.env.UPLOAD_MAX_FILE_BYTES) || 5 * 1024 * 1024;
const TOTAL_QUOTA_BYTES = Number(process.env.UPLOAD_TOTAL_QUOTA_BYTES) || 500 * 1024 * 1024;
const PUBLIC_DIR = process.env.UPLOAD_PUBLIC_DIR || 'uploads/public';

// Per-property image cap (spec: max 5). Enforced additively — persistImages
// counts existing rows and rejects the batch if the total would exceed it.
const MAX_IMAGES_PER_PROPERTY = Number(process.env.UPLOAD_MAX_IMAGES_PER_PROPERTY) || 5;

const MIME_TO_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
};

function appRoot() {
  return path.resolve(__dirname, '..', '..', '..');
}

function publicSubdir(propertyKind) {
  return path.join(appRoot(), PUBLIC_DIR, propertyKind);
}

function ensureDirSync(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Validate and persist a batch of in-memory image files for a property.
 * - Validates per-file size and magic bytes.
 * - Locks storage_usage and rejects if the batch would exceed total quota.
 * - Writes files to disk, inserts rows, increments usage in a single transaction.
 * - On any failure after files are on disk, removes them so the DB and FS stay consistent.
 *
 * @param {object} ctx
 * @param {'inventory'|'website'} ctx.propertyKind
 * @param {number} ctx.propertyId
 * @param {Array<{originalname: string, mimetype: string, buffer: Buffer, size: number}>} ctx.files
 * @returns {Promise<Array<{id:number, storedName:string, originalName:string, mimeType:string, sizeBytes:number, sortOrder:number}>>}
 */
async function persistImages({ propertyKind, propertyId, files, fileKind = 'image' }) {
  if (!files || files.length === 0) return [];

  const validated = [];
  for (const f of files) {
    if (f.size > MAX_FILE_BYTES) {
      throw new HttpError(400, 'FILE_TOO_LARGE', `"${f.originalname}" exceeds the ${MAX_FILE_BYTES}-byte per-file limit`);
    }
    const detected = detectImageMime(f.buffer);
    if (!detected || !ALLOWED_IMAGE_MIMES.includes(detected)) {
      throw new HttpError(400, 'UNSUPPORTED_FORMAT', `"${f.originalname}" is not a supported image (jpg, png, webp, heic)`);
    }
    validated.push({ ...f, detectedMime: detected });
  }

  // T-2026-048: enforce per-property image cap. Only applies to file_kind='image'
  // — amenity thumbnails and other kinds share the table but stay uncapped by
  // this rule.
  if (fileKind === 'image') {
    const existing = await propertyFiles.listForProperty(null, propertyKind, propertyId);
    if (existing.length + validated.length > MAX_IMAGES_PER_PROPERTY) {
      throw new HttpError(
        400,
        'TOO_MANY_IMAGES',
        `Uploading ${validated.length} image(s) would exceed the ${MAX_IMAGES_PER_PROPERTY}-image cap per property (currently ${existing.length}).`,
      );
    }
  }

  const totalDelta = validated.reduce((acc, f) => acc + f.size, 0);
  const dir = publicSubdir(propertyKind);
  ensureDirSync(dir);

  const writtenPaths = [];
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const usedBytes = await storageUsage.getUsedBytes(conn);
    if (usedBytes + totalDelta > TOTAL_QUOTA_BYTES) {
      throw new HttpError(
        413,
        'QUOTA_EXCEEDED',
        `Upload would exceed the ${TOTAL_QUOTA_BYTES}-byte total storage quota (currently using ${usedBytes})`,
      );
    }

    let nextSort = (await propertyFiles.maxSortOrder(conn, propertyKind, propertyId)) + 1;

    const rowsForInsert = [];
    for (const f of validated) {
      const ext = MIME_TO_EXT[f.detectedMime];
      const storedName = `${crypto.randomUUID()}.${ext}`;
      const fullPath = path.join(dir, storedName);
      await fsp.writeFile(fullPath, f.buffer);
      writtenPaths.push(fullPath);

      rowsForInsert.push({
        property_kind: propertyKind,
        property_id: propertyId,
        file_kind: fileKind,
        original_name: f.originalname.slice(0, 255),
        stored_name: `${propertyKind}/${storedName}`,
        mime_type: f.detectedMime,
        size_bytes: f.size,
        sort_order: nextSort++,
      });
    }

    await propertyFiles.insertMany(conn, rowsForInsert);
    await storageUsage.addBytes(conn, totalDelta);

    await conn.commit();
    return rowsForInsert.map((r, i) => ({
      // We don't have inserted IDs from a bulk insert without an extra query;
      // callers that need IDs should re-fetch from listForProperty.
      storedName: r.stored_name,
      originalName: r.original_name,
      mimeType: r.mime_type,
      sizeBytes: r.size_bytes,
      sortOrder: r.sort_order,
    }));
  } catch (err) {
    await conn.rollback().catch(() => {});
    // Cleanup any files written before the failure.
    await Promise.all(
      writtenPaths.map((p) => fsp.unlink(p).catch(() => {})),
    );
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Delete a single property image: row, file on disk, decrement usage.
 */
async function deleteImage({ fileId, propertyKind, propertyId }) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const file = await propertyFiles.findById(conn, fileId);
    if (!file || file.property_kind !== propertyKind || Number(file.property_id) !== Number(propertyId)) {
      throw new HttpError(404, 'NOT_FOUND', 'Image not found for this property');
    }

    // Lock storage_usage to keep counter consistent.
    await storageUsage.getUsedBytes(conn);

    await propertyFiles.deleteById(conn, fileId);
    await storageUsage.subtractBytes(conn, Number(file.size_bytes));

    await conn.commit();

    const absolutePath = path.join(appRoot(), PUBLIC_DIR, file.stored_name);
    await fsp.unlink(absolutePath).catch(() => {});
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Cascade cleanup when a property is being hard-deleted (or to free space
 * before soft delete). The PRD uses soft delete for properties, so we DO NOT
 * call this from soft-delete; images stay tied to soft-deleted properties
 * until an explicit purge.
 */
async function deleteAllForProperty({ propertyKind, propertyId }) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await storageUsage.getUsedBytes(conn);
    const removed = await propertyFiles.deleteAllForProperty(conn, propertyKind, propertyId);
    const total = removed.reduce((acc, r) => acc + Number(r.size_bytes), 0);
    await storageUsage.subtractBytes(conn, total);
    await conn.commit();

    await Promise.all(
      removed.map((r) =>
        fsp.unlink(path.join(appRoot(), PUBLIC_DIR, r.stored_name)).catch(() => {}),
      ),
    );
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { persistImages, deleteImage, deleteAllForProperty };
