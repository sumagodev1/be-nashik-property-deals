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
 *
 * Length-leak fix: the previous version returned 401 immediately if the
 * provided token's length didn't match the expected length. That early-exit
 * IS itself a timing oracle — an attacker can probe lengths and learn the
 * exact token length by observing which requests round-trip faster. We now
 * always hash both sides to a fixed-width SHA-256 digest before comparing,
 * so the comparison time depends only on the digest size (constant) and the
 * length check is moot.
 */
function requireCronToken(req, res, next) {
  const expected = process.env.CRON_TOKEN;
  if (!expected || expected.length < 16) {
    return next(new HttpError(503, 'CRON_DISABLED', 'CRON_TOKEN is not configured on this server.'));
  }
  const provided = req.headers['x-cron-token'];
  if (typeof provided !== 'string' || provided.length === 0) {
    return next(new HttpError(401, 'BAD_CRON_TOKEN', 'Invalid cron token.'));
  }
  // Hash both sides to fixed-width buffers so timingSafeEqual operates on
  // equal-length inputs regardless of what was supplied. The digests are
  // unique to each input (SHA-256 collision resistance), so an equal digest
  // means equal input.
  const providedDigest = crypto.createHash('sha256').update(provided).digest();
  const expectedDigest = crypto.createHash('sha256').update(expected).digest();
  if (!crypto.timingSafeEqual(providedDigest, expectedDigest)) {
    return next(new HttpError(401, 'BAD_CRON_TOKEN', 'Invalid cron token.'));
  }
  next();
}

module.exports = { requireCronToken };
