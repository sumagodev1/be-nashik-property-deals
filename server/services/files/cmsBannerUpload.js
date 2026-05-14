const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const { pool } = require('../../db/pool');
const storageUsage = require('../../db/queries/storage_usage');
const { HttpError } = require('../../middleware/errors');
const { detectImageMime, ALLOWED_IMAGE_MIMES } = require('../../constants/property');

const MAX_FILE_BYTES = Number(process.env.UPLOAD_MAX_FILE_BYTES) || 1024 * 1024;
const TOTAL_QUOTA_BYTES = Number(process.env.UPLOAD_TOTAL_QUOTA_BYTES) || 500 * 1024 * 1024;
const PUBLIC_DIR = process.env.UPLOAD_PUBLIC_DIR || 'uploads/public';
const CMS_SUBDIR = 'cms';

const MIME_TO_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

function appRoot() {
  return path.resolve(__dirname, '..', '..', '..');
}

function cmsDir() {
  return path.join(appRoot(), PUBLIC_DIR, CMS_SUBDIR);
}

function ensureDirSync(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Save a single banner image: validate magic bytes + size, reserve quota,
 * write to disk, return the public URL.
 *
 * If the caller's surrounding work (i.e. the cms_banners INSERT) fails,
 * call deleteBannerImage(storedName, sizeBytes) to roll back disk + quota.
 */
async function persistBannerImage({ originalName, mimetype, buffer, size }) {
  if (size > MAX_FILE_BYTES) {
    throw new HttpError(400, 'FILE_TOO_LARGE', `"${originalName}" exceeds the ${MAX_FILE_BYTES}-byte limit`);
  }
  const detected = detectImageMime(buffer);
  if (!detected || !ALLOWED_IMAGE_MIMES.includes(detected)) {
    throw new HttpError(400, 'UNSUPPORTED_FORMAT', `"${originalName}" is not a supported image (jpg, png, webp)`);
  }

  ensureDirSync(cmsDir());
  const ext = MIME_TO_EXT[detected];
  const storedName = `${crypto.randomUUID()}.${ext}`;
  const fullPath = path.join(cmsDir(), storedName);

  let written = false;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const used = await storageUsage.getUsedBytes(conn);
    if (used + size > TOTAL_QUOTA_BYTES) {
      throw new HttpError(
        413,
        'QUOTA_EXCEEDED',
        `Upload would exceed the ${TOTAL_QUOTA_BYTES}-byte total storage quota`,
      );
    }
    await fsp.writeFile(fullPath, buffer);
    written = true;
    await storageUsage.addBytes(conn, size);
    await conn.commit();
  } catch (err) {
    await conn.rollback().catch(() => {});
    if (written) {
      await fsp.unlink(fullPath).catch(() => {});
    }
    throw err;
  } finally {
    conn.release();
  }

  return {
    storedName,
    publicUrl: `/uploads/public/${CMS_SUBDIR}/${storedName}`,
    mimeType: detected,
    sizeBytes: size,
  };
}

/**
 * Delete a banner image from disk and decrement the quota counter.
 * cms_banners doesn't store size_bytes, so we stat the file to get its size
 * before unlinking. Best-effort: never throws; logs and continues.
 */
async function deleteBannerImage(publicUrlOrStoredName) {
  const storedName = publicUrlOrStoredName.startsWith(`/uploads/public/${CMS_SUBDIR}/`)
    ? publicUrlOrStoredName.replace(`/uploads/public/${CMS_SUBDIR}/`, '')
    : publicUrlOrStoredName;
  const fullPath = path.join(cmsDir(), storedName);

  let sizeBytes = 0;
  try {
    const st = await fsp.stat(fullPath);
    sizeBytes = Number(st.size) || 0;
  } catch {
    // File missing — nothing to delete on disk, but we still try to decrement
    // the counter at 0 (no-op). Worst case the counter drifts by this row's
    // original size; not a correctness bug, just slight inaccuracy.
  }

  if (sizeBytes > 0) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await storageUsage.getUsedBytes(conn);
      await storageUsage.subtractBytes(conn, sizeBytes);
      await conn.commit();
    } catch (err) {
      await conn.rollback().catch(() => {});
      // eslint-disable-next-line no-console
      console.warn('[cms] quota decrement failed:', err.message);
    } finally {
      conn.release();
    }
  }

  await fsp.unlink(fullPath).catch(() => {});
}

module.exports = { persistBannerImage, deleteBannerImage };
