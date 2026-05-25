/**
 * Password reset flow (email OTP) for BOTH admins and sub-admins.
 *
 * Forgot password:
 *   - If the email matches an admin OR an active sub-admin → issue a
 *     6-digit OTP via the shared `otp` service (rate-limited, hashed,
 *     emailed through cPanel SMTP).
 *   - If no account matches → return success silently (no email sent) to
 *     prevent enumeration of registered admin emails.
 *
 * Reset password:
 *   - Caller provides email + 6-digit OTP + new password. We delegate the
 *     OTP check to `otp.verify` (consumes the row on success, increments
 *     attempts on failure, locks after 5 wrong tries). On success we hash
 *     the new password and write it to either the admin or sub-admin row,
 *     whichever the email matched.
 */

const bcrypt = require('bcrypt');

const { HttpError } = require('../../middleware/errors');
const admins = require('../../db/queries/admins');
const subAdmins = require('../../db/queries/sub_admins');
const otp = require('./otp');

const BCRYPT_COST = 12;
const PASSWORD_MIN_LEN = 8;
const PURPOSE = 'admin_password_reset';

async function requestReset(rawEmail) {
  const email = String(rawEmail || '').trim().toLowerCase();
  if (!email) throw new HttpError(400, 'VALIDATION_ERROR', 'Email is required');

  const admin = await admins.findActiveByEmail(email);
  const sub = admin ? null : await subAdmins.findActiveByEmail(email);

  if (admin || sub) {
    await otp.issue({
      purpose: PURPOSE,
      channel: 'email',
      email: admin ? admin.email : sub.email,
      label: 'password reset',
    });
    return { sent: true };
  }

  // Unknown / inactive / deleted account — return success silently so
  // attackers can't enumerate which addresses are registered.
  return { sent: true };
}

async function completeReset({ email: rawEmail, otp: code, password }) {
  const email = String(rawEmail || '').trim().toLowerCase();
  const newPassword = String(password || '');
  if (!email) throw new HttpError(400, 'VALIDATION_ERROR', 'Email is required');
  if (!code) throw new HttpError(400, 'VALIDATION_ERROR', 'Verification code is required');
  if (newPassword.length < PASSWORD_MIN_LEN) {
    throw new HttpError(400, 'VALIDATION_ERROR', `Password must be at least ${PASSWORD_MIN_LEN} characters`);
  }

  const admin = await admins.findActiveByEmail(email);
  const sub = admin ? null : await subAdmins.findActiveByEmail(email);

  // Always run verify() so an attacker can't distinguish "wrong email" from
  // "wrong code" by response shape — but with no issued OTP for an unknown
  // email, verify() will throw OTP_INVALID anyway.
  await otp.verify({ purpose: PURPOSE, channel: 'email', email, code });

  if (!admin && !sub) {
    // Should be unreachable — an unknown email cannot have a valid OTP — but
    // belt-and-braces: never write a password for a non-existent account.
    throw new HttpError(400, 'OTP_INVALID', 'Code is invalid or has expired.');
  }

  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_COST);
  if (admin) {
    await admins.updatePassword(admin.id, passwordHash);
    return { ok: true, email: admin.email };
  }
  await subAdmins.updatePassword(sub.id, passwordHash);
  return { ok: true, email: sub.email };
}

module.exports = { requestReset, completeReset };
