/**
 * Secure Key PIN change / reset flows.
 *
 * Two distinct paths, both landing in the same audited "PIN updated"
 * end state:
 *
 *  1. changeInline(id, { currentPin, newPin, confirmPin }) — the
 *     admin knows the current PIN. Validates old + new inline and
 *     writes the new hash. No email step. Sends a confirmation email.
 *
 *  2. requestReset(id) → verifyReset({ otp | token }) →
 *     completeReset({ requestId, newPin, confirmPin }) — the admin
 *     forgot the current PIN. An OTP + verification link is emailed
 *     to the address on the active Email Master. Only after successful
 *     verification can completeReset() install a new PIN.
 *
 * Both paths:
 *  - Never expose the PIN in any response, log, or email.
 *  - Update the same key_pins row via keyPins.update() so the
 *    existing hash/timing-attack invariants are preserved.
 *  - Append an entry to key_pin_audit_log with IP + user agent.
 *
 * Restrictions:
 *  - requestReset / completeReset are gated to role === 'admin' at the
 *    route layer (feature is admin-only per spec).
 */

const bcrypt = require('bcrypt');
const crypto = require('crypto');

const { HttpError } = require('../../middleware/errors');
const keyPins = require('../../db/queries/key_pins');
const resets = require('../../db/queries/key_pin_resets');
const admins = require('../../db/queries/admins');
const subAdmins = require('../../db/queries/sub_admins');
const emailer = require('../email/transporter');

const BCRYPT_ROUNDS = 12;
const PIN_REGEX = /^[0-9]{6}$/;
const OTP_TTL_MINUTES = 15;
const MAX_REQUESTS_PER_ADMIN_15MIN = 3;
const MAX_REQUESTS_PER_PIN_15MIN = 5;

function assertPinShape(pin, field = 'PIN') {
  if (typeof pin !== 'string' || !PIN_REGEX.test(pin)) {
    throw new HttpError(400, 'INVALID_PIN', `${field} must be exactly 6 numeric digits.`);
  }
}

async function resolveActor(req) {
  const role = req?.auth?.role || null;
  const rawSub = req?.auth?.sub;
  const subjectId = rawSub != null ? Number(rawSub) : null;
  if (!subjectId || Number.isNaN(subjectId)) {
    return { adminId: null, actorName: null, role };
  }
  if (role === 'admin') {
    const found = await admins.findActiveById(subjectId);
    return { adminId: subjectId, actorName: found?.full_name || null, role };
  }
  if (role === 'sub_admin') {
    const found = await subAdmins.findById(subjectId);
    return { adminId: null, actorName: found?.full_name || null, role };
  }
  return { adminId: null, actorName: null, role };
}

function requestMeta(req) {
  const ip = (req?.headers?.['x-forwarded-for']?.split(',')[0].trim())
    || req?.ip || req?.connection?.remoteAddress || null;
  const ua = req?.headers?.['user-agent'] || null;
  return {
    ipAddress: ip ? String(ip).slice(0, 64) : null,
    userAgent: ua ? String(ua).slice(0, 500) : null,
  };
}

/**
 * Inline change flow: admin proves knowledge of the current PIN and
 * atomically installs a new one. No email round-trip.
 */
async function changeInline(id, body, req) {
  const { currentPin, newPin, confirmPin } = body || {};
  assertPinShape(currentPin, 'Current PIN');
  assertPinShape(newPin, 'New PIN');
  if (newPin !== confirmPin) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'The two New PIN entries do not match.');
  }
  if (newPin === currentPin) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'New PIN must be different from the current PIN.');
  }

  const existing = await keyPins.getById(id);
  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Key PIN not found.');

  // Verify current PIN against THIS row's hash. We cannot use the query
  // layer's public getById (omits hash) — read the row directly.
  const rowWithHash = await readHashedPin(id);
  if (!rowWithHash) throw new HttpError(404, 'NOT_FOUND', 'Key PIN not found.');

  const ok = await bcrypt.compare(currentPin, rowWithHash.hashed_pin);
  if (!ok) {
    throw new HttpError(400, 'INVALID_CURRENT_PIN', 'Current PIN is incorrect.');
  }

  const { adminId, actorName, role } = await resolveActor(req);
  const meta = requestMeta(req);
  const hashedPin = await bcrypt.hash(newPin, BCRYPT_ROUNDS);

  await keyPins.update(id, {
    hashedPin,
    username: undefined,
    status: null,
    adminId,
    actorName,
  });

  await resets.appendAudit({
    keyPinId: id, adminId, role, actorName,
    action: 'pin_changed_inline',
    ...meta,
  });

  // Fire-and-forget confirmation email — do not throw if email fails,
  // the PIN change itself was successful and must not be rolled back.
  const usernameForEmail = existing.username || null;
  sendPinChangedEmail({ usernameForEmail, meta }).catch(() => {});

  return { ok: true };
}

/**
 * Request a Forget-PIN reset. Generates a 6-digit OTP + a 32-byte hex
 * verification token, stores the bcrypt hash of the OTP, and emails
 * both to the Email Master's admin_email.
 */
async function requestReset(id, req) {
  const existing = await keyPins.getById(id);
  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Key PIN not found.');

  const { adminId, actorName, role } = await resolveActor(req);
  if (role !== 'admin' || !adminId) {
    throw new HttpError(403, 'FORBIDDEN', 'Only administrators can request a PIN reset.');
  }

  // Rate limit: cap generation per admin and per PIN over a 15-min window.
  const [byAdmin, byPin] = await Promise.all([
    resets.countRecentByAdmin(adminId, 15),
    resets.countRecentByPin(id, 15),
  ]);
  if (byAdmin >= MAX_REQUESTS_PER_ADMIN_15MIN) {
    throw new HttpError(429, 'RATE_LIMITED', 'Too many reset requests. Please try again in 15 minutes.');
  }
  if (byPin >= MAX_REQUESTS_PER_PIN_15MIN) {
    throw new HttpError(429, 'RATE_LIMITED', 'Too many reset attempts for this PIN. Please try again later.');
  }

  const adminEmail = await emailer.getAdminEmail();
  if (!adminEmail) {
    throw new HttpError(
      412,
      'NO_ADMIN_EMAIL',
      'No administrator email is configured. Please set up the Global / Email master first.',
    );
  }

  // Supersede any prior pending request for this PIN.
  await resets.invalidatePendingForPin(id);

  const otp = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const otpHash = await bcrypt.hash(otp, BCRYPT_ROUNDS);
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);
  const meta = requestMeta(req);

  const created = await resets.createResetRequest({
    keyPinId: id, adminId, role, actorName,
    otpHash, token,
    recipientEmail: adminEmail,
    expiresAt,
    ...meta,
  });

  await resets.appendAudit({
    keyPinId: id, adminId, role, actorName,
    action: 'reset_requested',
    ...meta,
  });

  // Send OTP + link email. If it fails, throw so the UI can tell the
  // admin the email didn't go out.
  const verifyUrl = buildVerifyUrl(req, token);
  await sendOtpEmail({
    to: adminEmail,
    usernameForEmail: existing.username || null,
    otp,
    verifyUrl,
    expiresInMinutes: OTP_TTL_MINUTES,
  });

  return {
    ok: true,
    requestId: created.id,
    recipient: maskEmail(adminEmail),
    expiresAt: created.expires_at,
    // Never include otp or token in the response.
  };
}

/**
 * Verify a reset attempt — via OTP (requires the key_pin_id since one
 * admin might have started reset flows on multiple PINs) or via token
 * (self-identifying). Returns the requestId which the frontend must
 * pass to completeReset.
 */
async function verifyReset(body, req) {
  const { keyPinId, otp, token } = body || {};
  let request = null;

  if (token) {
    request = await resets.findPendingByToken(String(token));
    if (!request) throw new HttpError(400, 'INVALID_OR_EXPIRED', 'This verification link is invalid or has expired.');
  } else if (otp && keyPinId) {
    assertPinShape(otp, 'OTP');
    request = await resets.findPendingByPinId(Number(keyPinId));
    if (!request) throw new HttpError(400, 'INVALID_OR_EXPIRED', 'This OTP is invalid or has expired.');
    const ok = await bcrypt.compare(String(otp), request.otp_hash);
    if (!ok) throw new HttpError(400, 'INVALID_OR_EXPIRED', 'This OTP is invalid or has expired.');
  } else {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Provide either a verification token or a key PIN ID with OTP.');
  }

  const { adminId, actorName, role } = await resolveActor(req);
  if (role !== 'admin' || !adminId) {
    throw new HttpError(403, 'FORBIDDEN', 'Only administrators can verify a PIN reset.');
  }

  // The admin verifying must be the same admin who requested. This
  // prevents Admin B from picking up Admin A's mailbox link.
  if (request.requested_by_admin_id && Number(request.requested_by_admin_id) !== Number(adminId)) {
    throw new HttpError(403, 'FORBIDDEN', 'This reset request belongs to a different administrator.');
  }

  await resets.markVerified(request.id);
  const meta = requestMeta(req);
  await resets.appendAudit({
    keyPinId: request.key_pin_id, adminId, role, actorName,
    action: token ? 'reset_verified_link' : 'reset_verified_otp',
    ...meta,
  });

  return {
    ok: true,
    requestId: request.id,
    keyPinId: request.key_pin_id,
    expiresAt: request.expires_at,
  };
}

/**
 * Complete a reset after successful verification. Requires the requestId
 * returned by verifyReset (or the token/OTP again for safety).
 */
async function completeReset(body, req) {
  const { requestId, newPin, confirmPin } = body || {};
  assertPinShape(newPin, 'New PIN');
  if (newPin !== confirmPin) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'The two New PIN entries do not match.');
  }
  if (!requestId) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Missing verification request ID.');
  }

  const { pool } = require('../../db/pool');
  const [rows] = await pool.query(
    `SELECT id, key_pin_id, requested_by_admin_id, verified_at, used_at, expires_at
       FROM key_pin_reset_requests WHERE id = ?`,
    [Number(requestId)],
  );
  const request = rows[0] || null;
  if (!request) throw new HttpError(400, 'INVALID_OR_EXPIRED', 'Reset request not found.');
  if (request.used_at) throw new HttpError(400, 'INVALID_OR_EXPIRED', 'This reset request has already been used.');
  if (!request.verified_at) throw new HttpError(400, 'NOT_VERIFIED', 'Please verify the OTP or email link first.');
  if (new Date(request.expires_at).getTime() < Date.now()) {
    throw new HttpError(400, 'INVALID_OR_EXPIRED', 'This reset request has expired.');
  }

  const { adminId, actorName, role } = await resolveActor(req);
  if (role !== 'admin' || !adminId) {
    throw new HttpError(403, 'FORBIDDEN', 'Only administrators can complete a PIN reset.');
  }
  if (request.requested_by_admin_id && Number(request.requested_by_admin_id) !== Number(adminId)) {
    throw new HttpError(403, 'FORBIDDEN', 'This reset request belongs to a different administrator.');
  }

  const keyPinRow = await readHashedPin(request.key_pin_id);
  if (!keyPinRow) throw new HttpError(404, 'NOT_FOUND', 'Key PIN not found.');

  // Enforce "new PIN cannot equal old PIN".
  const same = await bcrypt.compare(newPin, keyPinRow.hashed_pin);
  if (same) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'New PIN must be different from the current PIN.');
  }

  const hashedPin = await bcrypt.hash(newPin, BCRYPT_ROUNDS);
  await keyPins.update(request.key_pin_id, {
    hashedPin,
    username: undefined,
    status: null,
    adminId,
    actorName,
  });
  await resets.markUsed(request.id);

  const existing = await keyPins.getById(request.key_pin_id);
  const meta = requestMeta(req);
  await resets.appendAudit({
    keyPinId: request.key_pin_id, adminId, role, actorName,
    action: 'pin_reset_completed',
    ...meta,
  });

  sendPinChangedEmail({
    usernameForEmail: existing?.username || null,
    meta,
  }).catch(() => {});

  return { ok: true };
}

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

async function readHashedPin(id) {
  const { pool } = require('../../db/pool');
  const [rows] = await pool.query(
    `SELECT id, hashed_pin FROM key_pins
     WHERE id = ? AND deleted_at IS NULL`,
    [id],
  );
  return rows[0] || null;
}

function buildVerifyUrl(req, token) {
  // Prefer explicit APP_URL, fall back to Origin/Referer, then localhost.
  const base = (process.env.APP_URL || req?.headers?.origin || '').replace(/\/$/, '');
  const path = `/admin/masters/key-pin/reset?token=${encodeURIComponent(token)}`;
  if (base) return `${base}${path}`;
  return `http://localhost:5173${path}`;
}

function maskEmail(email) {
  if (!email || !email.includes('@')) return email;
  const [local, domain] = email.split('@');
  const shownLocal = local.length <= 2 ? local[0] || '' : `${local.slice(0, 2)}${'*'.repeat(Math.max(0, local.length - 2))}`;
  return `${shownLocal}@${domain}`;
}

async function sendOtpEmail({ to, usernameForEmail, otp, verifyUrl, expiresInMinutes }) {
  const displayName = usernameForEmail || 'Administrator';
  const subject = 'Key PIN Recovery';
  const text = `Hello ${displayName},

A request was received to reset your Key PIN.

Your verification OTP is:

    ${otp}

Or click the Verify Email link below:

    ${verifyUrl}

This OTP and link expire in ${expiresInMinutes} minutes.

If you did not request this, please ignore this email.
`;
  const html = `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; max-width: 560px; margin: 0 auto; color: #222;">
  <h2 style="color: #0f172a; margin: 0 0 12px 0;">Key PIN Recovery</h2>
  <p>Hello ${escapeHtml(displayName)},</p>
  <p>A request was received to reset your Key PIN.</p>
  <p style="margin-top: 24px;">Your verification OTP is:</p>
  <p style="font-size: 28px; font-weight: 700; letter-spacing: 6px; color: #0f172a; background: #f1f5f9; padding: 14px 18px; border-radius: 8px; text-align: center; margin: 8px 0;">${otp}</p>
  <p style="margin-top: 24px;">Or click the button below to verify:</p>
  <p style="margin: 12px 0;"><a href="${verifyUrl}" style="display: inline-block; background: #0f172a; color: #fff; text-decoration: none; padding: 12px 24px; border-radius: 6px; font-weight: 600;">Verify Email</a></p>
  <p style="color: #64748b; font-size: 13px; margin-top: 24px;">This OTP and link expire in ${expiresInMinutes} minutes.</p>
  <p style="color: #64748b; font-size: 13px;">If you did not request this, please ignore this email.</p>
</div>`;
  await emailer.sendMail({ to, subject, text, html });
}

async function sendPinChangedEmail({ usernameForEmail, meta }) {
  const to = await emailer.getAdminEmail();
  if (!to) return; // no admin email configured — silently skip
  const displayName = usernameForEmail || 'Administrator';
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-IN', { year: 'numeric', month: 'long', day: 'numeric' });
  const timeStr = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  const ip = meta?.ipAddress || '—';
  const subject = 'Key PIN Changed Successfully';
  const text = `Hello ${displayName},

Your Key PIN has been changed successfully.

Changed On: ${dateStr}
Time: ${timeStr}
IP Address: ${ip}

If this was not you, please contact the administrator immediately.
`;
  const html = `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; max-width: 560px; margin: 0 auto; color: #222;">
  <h2 style="color: #0f172a; margin: 0 0 12px 0;">Key PIN Changed Successfully</h2>
  <p>Hello ${escapeHtml(displayName)},</p>
  <p>Your Key PIN has been changed successfully.</p>
  <table style="border-collapse: collapse; margin: 16px 0;">
    <tr><td style="padding: 4px 12px 4px 0; color: #64748b;">Changed On:</td><td style="padding: 4px 0;"><strong>${escapeHtml(dateStr)}</strong></td></tr>
    <tr><td style="padding: 4px 12px 4px 0; color: #64748b;">Time:</td><td style="padding: 4px 0;"><strong>${escapeHtml(timeStr)}</strong></td></tr>
    <tr><td style="padding: 4px 12px 4px 0; color: #64748b;">IP Address:</td><td style="padding: 4px 0;"><strong>${escapeHtml(ip)}</strong></td></tr>
  </table>
  <p style="color: #b91c1c; font-size: 14px;">If this was not you, please contact the administrator immediately.</p>
</div>`;
  // Use trySendMail (best-effort) so a failed confirmation doesn't roll
  // back the PIN change itself.
  await emailer.trySendMail({ to, subject, text, html });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

module.exports = {
  changeInline,
  requestReset,
  verifyReset,
  completeReset,
};
