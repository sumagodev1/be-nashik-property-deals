class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function notFound(req, res, next) {
  next(new HttpError(404, 'NOT_FOUND', 'Resource not found'));
}

function errorHandler(err, req, res, _next) {
  const status = err.status && Number.isInteger(err.status) ? err.status : 500;
  const code = err.code || (status === 500 ? 'INTERNAL_ERROR' : 'ERROR');
  const message = status === 500 ? 'Something went wrong. Please try again.' : err.message || 'Request failed';

  if (status >= 500) {
    // eslint-disable-next-line no-console
    console.error('[error]', { code, status, msg: err.message, stack: err.stack });
  }

  res.status(status).json({ error: { code, message } });
}

module.exports = { HttpError, notFound, errorHandler };
