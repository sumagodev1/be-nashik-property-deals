const jwt = require('jsonwebtoken');
const { HttpError } = require('./errors');

function extractBearer(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length).trim();
}

function requireAuth(req, res, next) {
  const token = extractBearer(req);
  if (!token) return next(new HttpError(401, 'UNAUTHENTICATED', 'Authentication required'));

  try {
    const payload = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
    req.auth = payload;
    next();
  } catch (err) {
    next(new HttpError(401, 'INVALID_TOKEN', 'Invalid or expired token'));
  }
}

function requireRole(...allowed) {
  return (req, res, next) => {
    if (!req.auth) return next(new HttpError(401, 'UNAUTHENTICATED', 'Authentication required'));
    if (!allowed.includes(req.auth.role)) return next(new HttpError(403, 'FORBIDDEN', 'Insufficient permissions'));
    next();
  };
}

function requireModule(moduleKey) {
  return (req, res, next) => {
    if (!req.auth) return next(new HttpError(401, 'UNAUTHENTICATED', 'Authentication required'));
    if (req.auth.role === 'admin') return next();
    if (req.auth.role === 'sub_admin' && Array.isArray(req.auth.modules) && req.auth.modules.includes(moduleKey)) {
      return next();
    }
    next(new HttpError(403, 'FORBIDDEN', 'Module access denied'));
  };
}

module.exports = { requireAuth, requireRole, requireModule };
