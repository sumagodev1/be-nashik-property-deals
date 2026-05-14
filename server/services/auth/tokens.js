const jwt = require('jsonwebtoken');

function getSecret() {
  const secret = process.env.JWT_ACCESS_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('JWT_ACCESS_SECRET is missing or too short (≥32 chars required)');
  }
  return secret;
}

function signAccessToken({ subjectId, role, modules }) {
  return jwt.sign(
    { sub: String(subjectId), role, modules: modules || [] },
    getSecret(),
    { expiresIn: process.env.JWT_ACCESS_TTL || '8h' },
  );
}

function verifyAccessToken(token) {
  return jwt.verify(token, getSecret());
}

module.exports = { signAccessToken, verifyAccessToken };
