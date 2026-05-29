const crypto = require('crypto');
const bcrypt = require('bcrypt');

const otpQueries = require('../../db/queries/otp_codes');
const { trySendMail } = require('../email/transporter');
const { renderEmail, BRAND } = require('../email/emailTemplate');
const { trySendSms } = require('../sms/sender');
const { HttpError } = require('../../middleware/errors');

const TTL_MINUTES = Number(process.env.OTP_TTL_MINUTES) || 10;
const MAX_ATTEMPTS = Number(process.env.OTP_MAX_ATTEMPTS) || 5;
const RATE_PER_MINUTE = Number(process.env.OTP_RATE_PER_MINUTE) || 1;
const RATE_PER_HOUR = Number(process.env.OTP_RATE_PER_HOUR) || 5;
// Cost 12 matches the project's password-hashing standard (login.js,
// sub_admin/management.js, password_reset.js). The OTP space is small
// (10⁶ codes) so the marginal CPU cost per issue is negligible — a brute
// force is gated by MAX_ATTEMPTS=5 well before bcrypt cost matters. Kept
// at 12 anyway so a future bcrypt-rehash audit doesn't flag this row as
// the weakest link.
const BCRYPT_COST = 12;

// Static dev OTP — same code every time so manual testing doesn't require
// hunting through email/SMS during development. Override via env if you want
// a different fixed code for your local. In production we always generate a
// CSPRNG-backed random 6-digit code.
const DEV_STATIC_OTP = (process.env.DEV_STATIC_OTP || '123456').padStart(6, '0');

function generateCode() {
  if (process.env.NODE_ENV !== 'production') {
    return DEV_STATIC_OTP;
  }
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

function expiresAt() {
  const d = new Date(Date.now() + TTL_MINUTES * 60 * 1000);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Issue an OTP for (purpose, key) where the channel decides whether the key
 * is an email address ('email') or a mobile number ('sms').
 *
 * Rate-limited per (purpose, key) bucket. Throws HttpError on limit.
 *
 * In NODE_ENV !== 'production' the plain OTP code is logged to stdout AND
 * returned to the caller via `{ code }` so dev flows can complete without
 * a real SMTP/SMS provider. In production the caller MUST discard the code
 * before sending the response — see the `withDevCode` helpers in the
 * caller services.
 */
async function issue({
  purpose,
  channel = 'email',
  email,
  mobileNumber,
  label = 'verification',
}) {
  if (channel !== 'email' && channel !== 'sms') {
    throw new Error(`otp.issue: unknown channel ${channel}`);
  }

  if (channel === 'sms') {
    if (!mobileNumber) throw new Error('otp.issue: mobileNumber required for sms channel');
    await enforceRateLimitsMobile(purpose, mobileNumber);
  } else {
    if (!email) throw new Error('otp.issue: email required for email channel');
    await enforceRateLimitsEmail(purpose, email);
  }

  const code = generateCode();
  const codeHash = await bcrypt.hash(code, BCRYPT_COST);
  await otpQueries.create({
    purpose,
    email: channel === 'email' ? email : null,
    mobileNumber: channel === 'sms' ? mobileNumber : mobileNumber || null,
    codeHash,
    expiresAt: expiresAt(),
  });

  if (process.env.NODE_ENV !== 'production') {
    // eslint-disable-next-line no-console
    console.log(
      `[otp] purpose=${purpose} channel=${channel} ` +
        `${channel === 'sms' ? `mobile=${mobileNumber}` : `email=${email}`} ` +
        `code=${code} (DEV ONLY — never log in production)`,
    );
  }

  if (channel === 'sms') {
    await trySendSms({
      mobileNumber,
      body: buildSmsBody(code, label),
    });
  } else {
    await trySendMail({
      to: email,
      subject: `Your Nasik Property Deals ${label} code`,
      text: buildPlainBody(code, label),
      html: buildHtmlBody(code, label),
    });
  }

  return { code };
}

async function enforceRateLimitsEmail(purpose, email) {
  const lastMinute = await otpQueries.countRecentForEmail({ purpose, email, sinceSeconds: 60 });
  if (lastMinute >= RATE_PER_MINUTE) {
    throw new HttpError(429, 'OTP_RATE_LIMITED', 'Please wait before requesting another code.');
  }
  const lastHour = await otpQueries.countRecentForEmail({ purpose, email, sinceSeconds: 3600 });
  if (lastHour >= RATE_PER_HOUR) {
    throw new HttpError(429, 'OTP_RATE_LIMITED', 'Too many code requests. Try again later.');
  }
}

async function enforceRateLimitsMobile(purpose, mobileNumber) {
  const lastMinute = await otpQueries.countRecentForMobile({
    purpose,
    mobileNumber,
    sinceSeconds: 60,
  });
  if (lastMinute >= RATE_PER_MINUTE) {
    throw new HttpError(429, 'OTP_RATE_LIMITED', 'Please wait before requesting another code.');
  }
  const lastHour = await otpQueries.countRecentForMobile({
    purpose,
    mobileNumber,
    sinceSeconds: 3600,
  });
  if (lastHour >= RATE_PER_HOUR) {
    throw new HttpError(429, 'OTP_RATE_LIMITED', 'Too many code requests. Try again later.');
  }
}

/**
 * Verify a submitted code against the latest unconsumed OTP for (purpose, key).
 * `channel='email'` keys on `email`; `channel='sms'` keys on `mobileNumber`.
 * Increments attempts; marks consumed on success; rejects after MAX_ATTEMPTS.
 * Returns true on success; throws HttpError on every failure path.
 */
async function verify({ purpose, channel = 'email', email, mobileNumber, code }) {
  let row;
  if (channel === 'sms') {
    if (!mobileNumber) throw new Error('otp.verify: mobileNumber required for sms channel');
    row = await otpQueries.findLatestUnconsumedByMobile({ purpose, mobileNumber });
  } else {
    if (!email) throw new Error('otp.verify: email required for email channel');
    row = await otpQueries.findLatestUnconsumed({ purpose, email });
  }
  if (!row) throw new HttpError(400, 'OTP_INVALID', 'Code is invalid or has expired.');

  if (row.attempts >= MAX_ATTEMPTS) {
    throw new HttpError(429, 'OTP_LOCKED', 'Too many wrong attempts. Request a new code.');
  }

  const ok = await bcrypt.compare(String(code), row.code_hash);
  if (!ok) {
    await otpQueries.incrementAttempts(row.id);
    throw new HttpError(400, 'OTP_INVALID', 'Code is invalid or has expired.');
  }

  await otpQueries.consume(row.id);
  return true;
}

function buildPlainBody(code, label) {
  return `Your ${label} code is: ${code}

This code is valid for ${TTL_MINUTES} minutes.
If you did not request this, ignore this email.

— Nasik Property Deals`;
}

function buildHtmlBody(code, label) {
  // OTP code rendered as a big, monospace, letter-spaced block so it's
  // unmistakable in the inbox. Wrapped in the shared template so the OTP
  // email carries the same brand bar + footer as every other system mail.
  const otpBlock = `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:8px 0 0 0;">
      <tr>
        <td align="center" style="background:#f0f7ff;border:1px solid #d0e4f7;border-radius:10px;padding:22px 16px;">
          <div style="font-size:11px;font-weight:700;letter-spacing:1.6px;text-transform:uppercase;color:${BRAND.muted};margin-bottom:8px;">
            Your ${label} code
          </div>
          <div style="font-family:Menlo,Consolas,monospace;font-size:34px;font-weight:700;letter-spacing:10px;color:${BRAND.primary};">
            ${code}
          </div>
          <div style="margin-top:10px;font-size:12px;color:${BRAND.muted};">
            Expires in ${TTL_MINUTES} minutes
          </div>
        </td>
      </tr>
    </table>
  `;
  return renderEmail({
    preheader: `Your ${label} code: ${code} (valid ${TTL_MINUTES} min)`,
    title: `Your ${label} verification code`,
    intro: `Enter this 6-digit code in the app to complete your ${label}. It expires in ${TTL_MINUTES} minutes.`,
    bodyHtml: otpBlock + `
      <p style="margin:18px 0 0 0;font-size:13px;color:${BRAND.muted};line-height:1.6;">
        Didn't request this code? You can safely ignore this email — no action will be taken on your account.
        Never share this code with anyone, including someone claiming to be from our team.
      </p>
    `,
    accentColor: BRAND.primary,
    footerNote: 'For your security, this code expires shortly and cannot be reused.',
  });
}

function buildSmsBody(code, label) {
  return `Nasik Property Deals: your ${label} code is ${code}. Valid for ${TTL_MINUTES} min. Do not share.`;
}

module.exports = { issue, verify };
