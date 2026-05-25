const jwt = require('jsonwebtoken');

function getAccessSecret() {
  const secret = process.env.JWT_ACCESS_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('JWT_ACCESS_SECRET is missing or too short (≥32 chars required)');
  }
  return secret;
}

// Short-lived access token: 15 min default for admin / sub_admin (was 8h).
// Per CLAUDE.md "JWT access token (short TTL, e.g. 15 min) + refresh token
// (longer TTL, rotated on use, stored as httpOnly secure cookie)". The
// refresh-token rotation flow in services/auth/refresh.js provides the
// long-lived session for those roles.
//
// Seller tokens don't have a refresh-token rotation path yet (the
// refresh_tokens.subject_kind ENUM only covers admin / sub_admin), so they
// get a longer TTL — otherwise the seller would silently lose their session
// 15 min into a browsing session with no way to renew it. When seller
// refresh tokens get implemented, drop this carve-out and use the env
// default everywhere.
function signAccessToken({ subjectId, role, modules, expiresIn }) {
  const defaultTtl = role === 'seller'
    ? (process.env.JWT_SELLER_ACCESS_TTL || '8h')
    : (process.env.JWT_ACCESS_TTL || '15m');
  return jwt.sign(
    { sub: String(subjectId), role, modules: modules || [] },
    getAccessSecret(),
    { expiresIn: expiresIn || defaultTtl },
  );
}

function verifyAccessToken(token) {
  return jwt.verify(token, getAccessSecret());
}

module.exports = { signAccessToken, verifyAccessToken, getAccessSecret };
