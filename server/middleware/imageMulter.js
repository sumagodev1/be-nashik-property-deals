const multer = require('multer');
const { HttpError } = require('./errors');

// T-2026-048: default raised to 5 MB (aligns with imageUpload / documentUpload).
// Env override still applies.
const MAX_FILE_BYTES = Number(process.env.UPLOAD_MAX_FILE_BYTES) || 5 * 1024 * 1024;
const MAX_FILES_PER_REQUEST = 10;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_BYTES,
    files: MAX_FILES_PER_REQUEST,
  },
});

// Use field name 'images' for multipart uploads.
const imagesFieldHandler = upload.array('images', MAX_FILES_PER_REQUEST);

function imageUploadMiddleware(req, res, next) {
  imagesFieldHandler(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return next(new HttpError(400, 'FILE_TOO_LARGE', `One or more files exceed the ${MAX_FILE_BYTES}-byte limit`));
    }
    if (err.code === 'LIMIT_FILE_COUNT') {
      return next(new HttpError(400, 'TOO_MANY_FILES', `Max ${MAX_FILES_PER_REQUEST} files per upload`));
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      return next(new HttpError(400, 'UNEXPECTED_FIELD', 'Upload field must be named "images"'));
    }
    return next(new HttpError(400, 'UPLOAD_FAILED', err.message || 'Upload failed'));
  });
}

// Documents field handler — accepts a different field name so a single
// multipart request can carry images and docs without colliding.
const docsFieldHandler = upload.array('documents', MAX_FILES_PER_REQUEST);

function documentUploadMiddleware(req, res, next) {
  docsFieldHandler(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return next(new HttpError(400, 'FILE_TOO_LARGE', `One or more files exceed the ${MAX_FILE_BYTES}-byte limit`));
    }
    if (err.code === 'LIMIT_FILE_COUNT') {
      return next(new HttpError(400, 'TOO_MANY_FILES', `Max ${MAX_FILES_PER_REQUEST} files per upload`));
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      return next(new HttpError(400, 'UNEXPECTED_FIELD', 'Upload field must be named "documents"'));
    }
    return next(new HttpError(400, 'UPLOAD_FAILED', err.message || 'Upload failed'));
  });
}

module.exports = { imageUploadMiddleware, documentUploadMiddleware };
