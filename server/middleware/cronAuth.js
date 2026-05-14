const crypto = require('crypto');
const { HttpError } = require('./errors');

/**
 * Cron auth: caller must present a matching CRON_TOKEN header. Designed for
 * cPanel cron entries like:
 *   curl -fsS -H "X-Cron-Token: $TOKEN" -X POST https://.../api/cron/...
 *
 * Token must be configured in env. If unset, every request is rejected (don't
 * accidentally leave the endpoint open).
 *
 * Constant-time compare so the token isn't leakable by timing differences.
 */
function requireCronToken(req, res, next) {
  const expected = process.env.CRON_TOKEN;
  if (!expected || expected.length < 16) {
    return next(new HttpError(503, 'CRON_DISABLED', 'CRON_TOKEN is not configured on this server.'));
  }
  const provided = req.headers['x-cron-token'];
  if (!provided || typeof provided !== 'string' || provided.length !== expected.length) {
    return next(new HttpError(401, 'BAD_CRON_TOKEN', 'Invalid cron token.'));
  }
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (!crypto.timingSafeEqual(a, b)) {
    return next(new HttpError(401, 'BAD_CRON_TOKEN', 'Invalid cron token.'));
  }
  next();
}

module.exports = { requireCronToken };
