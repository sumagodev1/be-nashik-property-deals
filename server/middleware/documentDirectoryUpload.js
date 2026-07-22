/**
 * Multer middleware for the Document Directory module.
 *
 * Accepts ANY file extension — the spec explicitly rules out extension
 * / MIME allowlists. A generous per-file byte limit is applied purely as
 * a defence-in-depth guard (default 200 MB, overridable via env). The
 * spec also disables frontend size validation, but leaving the server
 * completely uncapped would let a single upload exhaust the disk, so a
 * ceiling is kept here — set DOCUMENT_DIRECTORY_MAX_BYTES=0 to disable.
 */

const multer = require('multer');
const { HttpError } = require('./errors');

const MAX_BYTES = (() => {
  const raw = process.env.DOCUMENT_DIRECTORY_MAX_BYTES;
  if (raw === undefined || raw === '') return 200 * 1024 * 1024;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 200 * 1024 * 1024;
  return n; // 0 means "no limit"
})();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: MAX_BYTES > 0 ? { fileSize: MAX_BYTES, files: 1 } : { files: 1 },
});

const singleFieldHandler = upload.single('file');

function documentDirectoryUpload(req, res, next) {
  singleFieldHandler(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return next(new HttpError(
        400,
        'FILE_TOO_LARGE',
        `File exceeds the ${MAX_BYTES}-byte server upload limit.`,
      ));
    }
    if (err.code === 'LIMIT_FILE_COUNT') {
      return next(new HttpError(400, 'TOO_MANY_FILES', 'Only one file is allowed per upload.'));
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      return next(new HttpError(400, 'UNEXPECTED_FIELD', 'Upload field must be named "file".'));
    }
    return next(new HttpError(400, 'UPLOAD_FAILED', err.message || 'Upload failed.'));
  });
}

module.exports = { documentDirectoryUpload };
