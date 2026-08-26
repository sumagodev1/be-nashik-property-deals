const crypto = require('crypto');
const bcrypt = require('bcrypt');

const otpQueries = require('../../db/queries/otp_codes');
const { trySendMail } = require('../email/transporter');
const { renderEmail, BRAND } = require('../email/emailTemplate');
const { trySendSms } = require('../sms/sender');
const { HttpError } = require('../../middleware/errors');

// Seller OTP validity is intentionally fixed at exactly 120 seconds. The
// browser displays the expiry timestamp returned by this service, while the
// database expiry remains the security boundary during verification.
const TTL_SECONDS = 120;
const TTL_MINUTES = TTL_SECONDS / 60;
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

// Always a CSPRNG-backed random 6-digit code. There is deliberately no
// fixed-code shortcut for development. The NODE_ENV check that used to sit
// here meant any deploy that lost its NODE_ENV would issue 123456 to every
// user AND echo it back in the API response - an authentication bypass, not
// a testing convenience.
function generateCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

function expiresAt() {
  return new Date(Date.now() + TTL_SECONDS * 1000);
}

function toIsoTimestamp(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const millis = Date.parse(String(value));
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
}

/**
 * Issue an OTP for (purpose, key) where the channel decides whether the key
 * is an email address ('email') or a mobile number ('sms').
 *
 * Rate-limited per (purpose, key) bucket. Throws HttpError on limit.
 *
 * The plaintext code never leaves this module: it is hashed into the row,
 * placed in the outgoing message, then dropped. Callers receive only
 * `{ sent: true, expiresAt }`, so no route can leak a code even by accident.
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
  const expiry = expiresAt();
  const otpId = await otpQueries.create({
    purpose,
    email: channel === 'email' ? email : null,
    mobileNumber: channel === 'sms' ? mobileNumber : mobileNumber || null,
    codeHash,
    expiresAt: expiry.toISOString().slice(0, 23).replace('T', ' '),
  });
  // Return the value read back from MySQL so the browser countdown and the
  // database verification boundary use the same exact timestamp.
  const persistedExpiry = typeof otpQueries.findExpiryById === 'function'
    ? toIsoTimestamp(await otpQueries.findExpiryById(otpId))
    : null;
  const expiresAtIso = persistedExpiry || expiry.toISOString();

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

  return { sent: true, expiresAt: expiresAtIso };
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

  const fallbackExpiryMillis = Date.parse(String(row.expires_at));
  const isExpired = row.is_expired === 1
    || row.is_expired === true
    || (row.is_expired == null
      && (!Number.isFinite(fallbackExpiryMillis) || fallbackExpiryMillis <= Date.now()));
  if (isExpired) {
    throw new HttpError(400, 'OTP_EXPIRED', 'OTP has expired. Please resend a new OTP.');
  }

  if (row.attempts >= MAX_ATTEMPTS) {
    throw new HttpError(429, 'OTP_LOCKED', 'Too many wrong attempts. Request a new code.');
  }

  const ok = await bcrypt.compare(String(code), row.code_hash);
  if (!ok) {
    await otpQueries.incrementAttempts(row.id);
    throw new HttpError(400, 'OTP_INVALID', 'Code is invalid or has expired.');
  }

  const consumed = await otpQueries.consumeIfUnexpired(row.id);
  if (!consumed) {
    throw new HttpError(400, 'OTP_EXPIRED', 'OTP has expired. Please resend a new OTP.');
  }
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
        <td align="center" style="background:#FDECEC;border:1px solid #F6B8B8;border-radius:10px;padding:22px 16px;">
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

module.exports = { issue, verify, TTL_MINUTES };
