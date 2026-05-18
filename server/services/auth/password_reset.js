/**
 * Admin-only password reset flow (email OTP).
 *
 * Forgot password:
 *   - If the email matches an admin → issue a 6-digit OTP via the shared
 *     `otp` service (rate-limited, hashed, emailed through cPanel SMTP).
 *   - If the email matches a sub admin → throw ACCOUNT_TYPE_RESTRICTED so
 *     the UI can show the "contact your administrator" message.
 *   - If no account matches → return success silently (no email sent) to
 *     prevent enumeration of registered admin emails.
 *
 * Reset password:
 *   - Caller provides email + 6-digit OTP + new password. We delegate the
 *     OTP check to `otp.verify` (consumes the row on success, increments
 *     attempts on failure, locks after 5 wrong tries). On success we hash
 *     the new password and write it to the admin row.
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
  if (admin) {
    await otp.issue({
      purpose: PURPOSE,
      channel: 'email',
      email: admin.email,
      label: 'password reset',
    });
    return { sent: true };
  }

  const sub = await subAdmins.findByEmail(email);
  if (sub) {
    throw new HttpError(
      403,
      'ACCOUNT_TYPE_RESTRICTED',
      'Sub admin accounts cannot self-reset. Please contact your site administrator — they can set a new password from the Sub Admins screen.',
    );
  }

  // Unknown email — return success silently so attackers can't enumerate
  // which addresses are admins.
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
  // If no admin matches we still go through verify() so an attacker can't
  // distinguish "wrong email" from "wrong code" by response shape — but with
  // no issued OTP for this email, verify() will throw OTP_INVALID anyway.
  await otp.verify({ purpose: PURPOSE, channel: 'email', email, code });

  if (!admin) {
    // Should be unreachable — an unknown email cannot have a valid OTP — but
    // belt-and-braces: never write a password for a non-existent account.
    throw new HttpError(400, 'OTP_INVALID', 'Code is invalid or has expired.');
  }

  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_COST);
  await admins.updatePassword(admin.id, passwordHash);
  return { ok: true, email: admin.email };
}

module.exports = { requestReset, completeReset };
