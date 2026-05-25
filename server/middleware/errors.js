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

  // Include `details` on the response when the thrower provided them and the
  // status isn't 5xx (don't leak internal context on server errors). The
  // frontend axios interceptor already forwards `details` to callers, so
  // pages can use them — e.g. show a "Reactivate existing row" button when
  // a duplicate-create error returns the existing row's id.
  const body = { error: { code, message } };
  if (status < 500 && err.details !== undefined && err.details !== null) {
    body.error.details = err.details;
  }
  res.status(status).json(body);
}

module.exports = { HttpError, notFound, errorHandler };
