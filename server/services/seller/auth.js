const { HttpError } = require('../../middleware/errors');
const sellers = require('../../db/queries/sellers');
const otp = require('../auth/otp');
const { signAccessToken } = require('../auth/tokens');

/**
 * Start registration: validate uniqueness, upsert an unverified seller record,
 * issue an EMAIL OTP. Same mobile re-attempt updates the pending record.
 *
 * Per CLAUDE.md the OTP delivery channel is SMTP (email), not SMS. Mobile
 * stays the unique key for the seller account — email is just the OTP
 * delivery address. Email is REQUIRED for registration.
 */
async function registerStart(payload) {
  if (!payload.email || !String(payload.email).trim()) {
    throw new HttpError(
      400,
      'EMAIL_REQUIRED',
      'Email is required so we can send your verification code.',
    );
  }
  const email = String(payload.email).trim().toLowerCase();

  const existingByMobile = await sellers.findByMobile(payload.mobileNumber);

  if (existingByMobile && existingByMobile.is_verified) {
    throw new HttpError(
      409,
      'MOBILE_TAKEN',
      'An account already exists with this mobile number. Please sign in.',
    );
  }

  const existingByEmail = await sellers.findByEmail(email);
  if (
    existingByEmail &&
    existingByEmail.is_verified &&
    (!existingByMobile || existingByEmail.id !== existingByMobile.id)
  ) {
    throw new HttpError(
      409,
      'EMAIL_TAKEN',
      'This email is already linked to another account.',
    );
  }

  let sellerId;
  if (existingByMobile) {
    await sellers.updateRegistrationDraft(existingByMobile.id, { ...payload, email });
    sellerId = existingByMobile.id;
  } else {
    // A previously-deleted seller may still own the mobile_number slot in
    // the unique index even though `findByMobile` (which filters out
    // soft-deleted rows) returned nothing. Release it before INSERT so the
    // signup doesn't trip ER_DUP_ENTRY for a row the admin already removed.
    await sellers.releaseSoftDeletedMobile(payload.mobileNumber);
    sellerId = await sellers.create({ ...payload, email });
  }

  const issued = await otp.issue({
    purpose: 'seller_register',
    channel: 'email',
    email,
    mobileNumber: payload.mobileNumber, // stored on the OTP row for traceability
    label: 'registration',
  });

  return withDevCode(
    { mobileNumber: payload.mobileNumber, email, sellerId },
    issued,
  );
}

async function registerVerify({ mobileNumber, code }) {
  const seller = await sellers.findByMobile(mobileNumber);
  if (!seller) {
    throw new HttpError(
      400,
      'NO_DRAFT',
      'No registration in progress for this mobile number.',
    );
  }
  if (!seller.email) {
    // Shouldn't happen now that registerStart enforces email, but defend in
    // depth — without an email there's no way the user could have received
    // an OTP to verify.
    throw new HttpError(
      400,
      'NO_EMAIL',
      'This registration is missing an email address. Please start over.',
    );
  }

  await otp.verify({
    purpose: 'seller_register',
    channel: 'email',
    email: String(seller.email).toLowerCase(),
    code,
  });

  if (seller.is_verified) {
    return issueToken(seller);
  }

  await sellers.markVerified(seller.id);
  const fresh = await sellers.findById(seller.id);
  return issueToken(fresh);
}

async function loginStart({ mobileNumber }) {
  // Distinguish three cases up-front so the user gets an actionable message
  // instead of a generic "not found" when their account was just deactivated.
  //
  //   1. Verified but inactive → ACCOUNT_DEACTIVATED (403)
  //   2. No verified account   → NOT_FOUND (dev) / silent OK (prod, anti-enum)
  //   3. Verified + active     → issue OTP to their stored email
  const verified = await sellers.findVerifiedByMobile(mobileNumber);
  if (verified && !verified.is_active) {
    throw new HttpError(
      403,
      'ACCOUNT_DEACTIVATED',
      'Your account has been deactivated by the admin. Please contact support to restore access.',
    );
  }
  const seller = await sellers.findActiveVerifiedByMobile(mobileNumber);
  if (!seller) {
    // In production, don't reveal whether the mobile is registered — silently
    // claim "OTP sent" so attackers can't enumerate which numbers exist.
    // In dev/staging, return a clear 404 so the developer gets fast feedback
    // instead of advancing to an OTP step that's guaranteed to fail.
    if (process.env.NODE_ENV === 'production') {
      return { ok: true };
    }
    throw new HttpError(404, 'NOT_FOUND', 'No account found for this mobile number.');
  }
  if (!seller.email) {
    // Edge case — a legacy seller record predating the email requirement.
    // Without an email we can't deliver the OTP. Surface a clear message.
    throw new HttpError(
      409,
      'NO_EMAIL_ON_FILE',
      'Your account has no email on file. Please contact support to update it.',
    );
  }
  const issued = await otp.issue({
    purpose: 'seller_login',
    channel: 'email',
    email: String(seller.email).toLowerCase(),
    mobileNumber,
    label: 'sign-in',
  });
  // Return a masked email hint so the UI can tell the user where the OTP went
  // ("o***@gmail.com") without leaking the full address.
  return withDevCode({ ok: true, emailHint: maskEmail(seller.email) }, issued);
}

async function loginVerify({ mobileNumber, code }) {
  // Same deactivation guard — somebody who already had a session start
  // (OTP requested before deactivation) shouldn't slip through the verify
  // step afterwards either.
  const verified = await sellers.findVerifiedByMobile(mobileNumber);
  if (verified && !verified.is_active) {
    throw new HttpError(
      403,
      'ACCOUNT_DEACTIVATED',
      'Your account has been deactivated by the admin. Please contact support to restore access.',
    );
  }
  const seller = await sellers.findActiveVerifiedByMobile(mobileNumber);
  if (!seller) throw new HttpError(400, 'OTP_INVALID', 'Code is invalid or has expired.');
  if (!seller.email) throw new HttpError(409, 'NO_EMAIL_ON_FILE', 'Your account has no email on file.');
  await otp.verify({
    purpose: 'seller_login',
    channel: 'email',
    email: String(seller.email).toLowerCase(),
    code,
  });
  return issueToken(seller);
}

// Mask the local part of an email so we can hint at the OTP destination
// without revealing the full address. "sakshi@gmail.com" → "s****i@gmail.com".
function maskEmail(email) {
  if (!email || typeof email !== 'string' || !email.includes('@')) return '';
  const [local, domain] = email.split('@');
  if (local.length <= 2) return `${local[0] || ''}***@${domain}`;
  return `${local[0]}${'*'.repeat(Math.max(1, local.length - 2))}${local[local.length - 1]}@${domain}`;
}

function issueToken(seller) {
  const token = signAccessToken({ subjectId: seller.id, role: 'seller', modules: [] });
  return {
    token,
    user: toUser(seller),
  };
}

function withDevCode(payload, issued) {
  if (process.env.NODE_ENV !== 'production' && issued && issued.code) {
    return { ...payload, devOtpCode: issued.code };
  }
  return payload;
}

function toUser(seller) {
  return {
    id: seller.id,
    role: 'seller',
    userType: seller.user_type,
    fullName: seller.full_name,
    email: seller.email,
    mobile: seller.mobile_number,
    isActive: Boolean(seller.is_active),
    isVerified: Boolean(seller.is_verified),
    modules: [],
  };
}

module.exports = { registerStart, registerVerify, loginStart, loginVerify, toUser };
