const crypto = require('crypto');
const { HttpError } = require('../../middleware/errors');
const refreshTokensRepo = require('../../db/queries/refresh_tokens');
const admins = require('../../db/queries/admins');
const subAdmins = require('../../db/queries/sub_admins');
const subAdminModules = require('../../db/queries/sub_admin_modules');
const sellers = require('../../db/queries/sellers');
const { signAccessToken } = require('./tokens');

// Refresh token TTL — 30 days unless overridden by env. The refresh cookie
// is httpOnly + Secure + SameSite=Strict so it can't be lifted by client
// JS; rotation on every use means a stolen token is single-use.
const REFRESH_TTL_DAYS = Number(process.env.JWT_REFRESH_TTL_DAYS) || 30;
const REFRESH_COOKIE_NAME = 'npd_refresh';

// 256 bits of CSPRNG-backed entropy, URL-safe base64. The token NEVER
// touches disk — only its SHA-256 hash does (so a DB dump can't be replayed
// as a valid cookie).
function generateRandomToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashToken(rawToken) {
  return crypto.createHash('sha256').update(String(rawToken)).digest('hex');
}

function expiresAtSql(days = REFRESH_TTL_DAYS) {
  const d = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Issue a refresh token for an authenticated subject. Returns the RAW token
 * string (to set as a cookie on the response) — the hash is what gets stored.
 */
async function issue({ subjectKind, subjectId }) {
  if (subjectKind !== 'admin' && subjectKind !== 'sub_admin' && subjectKind !== 'seller') {
    throw new Error(`refresh.issue: unsupported subjectKind ${subjectKind}`);
  }
  const raw = generateRandomToken();
  await refreshTokensRepo.create({
    subjectKind,
    subjectId,
    tokenHash: hashToken(raw),
    expiresAt: expiresAtSql(),
  });
  return raw;
}

/**
 * Rotate a refresh token. Caller hands us the cookie value; we verify it,
 * revoke the existing row, issue a fresh row, and return both the new raw
 * token (to set as a cookie) AND a freshly-signed access token + user
 * profile (so the client can use the response directly).
 *
 * Compromise detection: if the token is found BUT already revoked, the most
 * likely explanation is that the cookie was stolen and replayed after the
 * legitimate user already rotated past it. We revoke every active token for
 * that subject and reject the request.
 */
async function rotateAndReissue(rawToken) {
  if (!rawToken) {
    throw new HttpError(401, 'REFRESH_INVALID', 'Refresh token missing.');
  }

  const tokenHash = hashToken(rawToken);
  const row = await refreshTokensRepo.findByHash(tokenHash);
  if (!row) {
    throw new HttpError(401, 'REFRESH_INVALID', 'Refresh token invalid.');
  }

  // Replay of an already-rotated token → revoke the whole family for safety.
  if (row.revoked_at) {
    await refreshTokensRepo.revokeAllForSubject(row.subject_kind, row.subject_id);
    throw new HttpError(401, 'REFRESH_REUSED', 'Session compromised. Please sign in again.');
  }

  const expiresAt = new Date(row.expires_at).getTime();
  if (Number.isFinite(expiresAt) && expiresAt < Date.now()) {
    throw new HttpError(401, 'REFRESH_EXPIRED', 'Session expired. Please sign in again.');
  }

  // Resolve the subject row + roles so the new access token has fresh modules
  // (e.g. admin changed the sub-admin's module list since last refresh).
  const subject = await loadSubject(row.subject_kind, row.subject_id);
  if (!subject) {
    // Subject was deleted / deactivated — revoke and reject.
    await refreshTokensRepo.revoke(row.id);
    throw new HttpError(401, 'REFRESH_INVALID', 'Account is no longer active.');
  }

  // Issue the NEW refresh row first so we can point the old one at it.
  const newRaw = generateRandomToken();
  const newId = await refreshTokensRepo.create({
    subjectKind: row.subject_kind,
    subjectId: row.subject_id,
    tokenHash: hashToken(newRaw),
    expiresAt: expiresAtSql(),
  });
  await refreshTokensRepo.revoke(row.id, newId);

  const accessToken = signAccessToken({
    subjectId: subject.id,
    role: subject.role,
    modules: subject.modules,
  });

  return {
    refreshToken: newRaw,
    accessToken,
    user: subject.toUser(),
  };
}

/**
 * Explicit revoke — for logout. Idempotent: if the token's already revoked or
 * unknown, returns silently.
 */
async function revoke(rawToken) {
  if (!rawToken) return;
  const row = await refreshTokensRepo.findByHash(hashToken(rawToken));
  if (row && !row.revoked_at) await refreshTokensRepo.revoke(row.id);
}

async function loadSubject(subjectKind, subjectId) {
  if (subjectKind === 'admin') {
    const admin = await admins.findActiveById(Number(subjectId));
    if (!admin) return null;
    return {
      id: admin.id,
      role: 'admin',
      modules: [],
      toUser: () => ({
        id: admin.id,
        email: admin.email,
        fullName: admin.full_name,
        role: 'admin',
        modules: [],
      }),
    };
  }
  if (subjectKind === 'sub_admin') {
    const sub = await subAdmins.findActiveById(Number(subjectId));
    if (!sub) return null;
    const modules = await subAdminModules.listForSubAdmin(sub.id);
    return {
      id: sub.id,
      role: 'sub_admin',
      modules,
      toUser: () => ({
        id: sub.id,
        email: sub.email,
        fullName: sub.full_name,
        role: 'sub_admin',
        modules,
      }),
    };
  }
  if (subjectKind === 'seller') {
    const seller = await sellers.findActiveById(Number(subjectId));
    // Seller must still be verified — an unverified or deactivated seller
    // shouldn't ride a stale refresh cookie back into the app.
    if (!seller || !seller.is_verified) return null;
    return {
      id: seller.id,
      role: 'seller',
      modules: [],
      toUser: () => ({
        id: seller.id,
        email: seller.email,
        mobile: seller.mobile_number,
        fullName: seller.full_name,
        userType: seller.user_type,
        role: 'seller',
        modules: [],
      }),
    };
  }
  return null;
}

// Cookie attributes — centralised so login / refresh / logout always agree.
// httpOnly  — JS can't read the cookie (XSS-resistant).
// secure    — HTTPS only. We disable this in NODE_ENV=development so local
//             non-HTTPS dev still works; production cPanel deploys are
//             behind AutoSSL so secure stays on.
// sameSite  — 'lax' so login-redirect (top-level navigation) still carries
//             the cookie; cross-site XHR can't replay it (CSRF baseline).
// path      — '/api/auth' so the cookie is only sent to refresh / logout,
//             reducing the attack surface vs sending it on every API call.
function cookieOptions() {
  const maxAgeMs = REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000;
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/api/auth',
    maxAge: maxAgeMs,
  };
}

function setRefreshCookie(res, rawToken) {
  res.cookie(REFRESH_COOKIE_NAME, rawToken, cookieOptions());
}

function clearRefreshCookie(res) {
  // Clearing must match the original path + options so the browser deletes
  // the right cookie.
  res.clearCookie(REFRESH_COOKIE_NAME, { ...cookieOptions(), maxAge: 0 });
}

// Manual cookie extraction — keeps us off the cookie-parser dependency for
// the single cookie we actually need.
function readRefreshCookie(req) {
  const header = req.headers.cookie || '';
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === REFRESH_COOKIE_NAME) return decodeURIComponent(rest.join('='));
  }
  return null;
}

module.exports = {
  issue,
  rotateAndReissue,
  revoke,
  setRefreshCookie,
  clearRefreshCookie,
  readRefreshCookie,
  REFRESH_COOKIE_NAME,
};
