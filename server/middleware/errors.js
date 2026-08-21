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

// mysql2 attaches these when a query fails. Detect once so callers can rely
// on a stable shape regardless of driver version.
function isMysqlError(err) {
  return Boolean(err && (err.sqlState || err.sqlMessage || (typeof err.code === 'string' && err.code.startsWith('ER_'))));
}

// T-2026-081 exposes the MySQL code + first sqlMessage line on 500s so an
// OPERATOR gets "ER_NON_UNIQ_ERROR - Column 'pincode' in where clause is
// ambiguous" instead of a useless "Something went wrong". That is the right
// trade for the admin panel, but the same handler serves the public website
// and the seller forms, where it put raw driver text in front of a member of
// the public - a seller posting a property saw:
//
//   Database error (ER_DATA_TOO_LONG): Data too long for column 'property_code' at row 1
//
// which names an internal column, is not actionable, and reads as a broken
// site. Operators keep the detail; everyone else gets a plain message, and
// the full error still goes to the server log either way.
const INTERNAL_PREFIXES = ['/api/admin', '/api/auth', '/api/cron', '/api/google-calendar'];

function isOperatorSurface(req) {
  const url = String((req && (req.originalUrl || req.url)) || '');
  return INTERNAL_PREFIXES.some((p) => url === p || url.startsWith(`${p}/`) || url.startsWith(`${p}?`));
}

function errorHandler(err, req, res, _next) {
  const status = err.status && Number.isInteger(err.status) ? err.status : 500;
  // T-2026-081: on generic 500s we still return a sanitised message so we
  // don't leak SQL text — BUT MySQL driver errors (ER_*) now surface their
  // code + short message on the response so a client-side toast can render
  // "Search failed: ER_NON_UNIQ_ERROR — Column 'pincode' in where clause is
  // ambiguous" instead of the useless "Something went wrong". Full stack
  // still goes to the server log (below); we only expose the code + first
  // sqlMessage sentence to the caller.
  let code = err.code || (status === 500 ? 'INTERNAL_ERROR' : 'ERROR');
  let message;
  if (status < 500) {
    message = err.message || 'Request failed';
  } else if (isMysqlError(err) && isOperatorSurface(req)) {
    code = err.code || 'DB_ERROR';
    const sqlMsg = String(err.sqlMessage || err.message || 'Database error').split('\n')[0];
    message = `Database error (${code}): ${sqlMsg}`;
  } else if (isMysqlError(err)) {
    // A driver error on a public surface. Overwrite the code as well as the
    // message - leaving err.code alone would still put 'ER_DATA_TOO_LONG' on
    // a public response body.
    code = 'INTERNAL_ERROR';
    message = 'Something went wrong. Please try again.';
  } else {
    message = 'Something went wrong. Please try again.';
  }

  if (status >= 500) {
    // eslint-disable-next-line no-console
    // Log the ORIGINAL driver code, not the sanitised one that may have
    // replaced it for the response - the operator needs ER_DATA_TOO_LONG here
    // even when the caller was only told "Something went wrong".
    console.error('[error]', {
      code: err.code || code, status, msg: err.message,
      sqlMessage: err.sqlMessage, sqlState: err.sqlState,
      sentToClient: { code, message },
      stack: err.stack,
    });
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
