const { HttpError } = require('../../middleware/errors');
const sellers = require('../../db/queries/sellers');
const otp = require('../auth/otp');
const { signAccessToken } = require('../auth/tokens');

/**
 * Start registration: validate uniqueness, upsert an unverified seller record,
 * issue a mobile (SMS) OTP. Same mobile re-attempt updates the pending record.
 *
 * Email is optional. When provided, we still guard against collisions with a
 * different verified seller's email.
 */
async function registerStart(payload) {
  const existingByMobile = await sellers.findByMobile(payload.mobileNumber);

  if (existingByMobile && existingByMobile.is_verified) {
    throw new HttpError(
      409,
      'MOBILE_TAKEN',
      'An account already exists with this mobile number. Please sign in.',
    );
  }

  if (payload.email) {
    const existingByEmail = await sellers.findByEmail(payload.email);
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
  }

  let sellerId;
  if (existingByMobile) {
    await sellers.updateRegistrationDraft(existingByMobile.id, payload);
    sellerId = existingByMobile.id;
  } else {
    // A previously-deleted seller may still own the mobile_number slot in
    // the unique index even though `findByMobile` (which filters out
    // soft-deleted rows) returned nothing. Release it before INSERT so the
    // signup doesn't trip ER_DUP_ENTRY for a row the admin already removed.
    await sellers.releaseSoftDeletedMobile(payload.mobileNumber);
    sellerId = await sellers.create(payload);
  }

  const issued = await otp.issue({
    purpose: 'seller_register',
    channel: 'sms',
    mobileNumber: payload.mobileNumber,
    label: 'registration',
  });

  return withDevCode({ mobileNumber: payload.mobileNumber, sellerId }, issued);
}

async function registerVerify({ mobileNumber, code }) {
  await otp.verify({
    purpose: 'seller_register',
    channel: 'sms',
    mobileNumber,
    code,
  });

  const seller = await sellers.findByMobile(mobileNumber);
  if (!seller) {
    throw new HttpError(
      400,
      'NO_DRAFT',
      'No registration in progress for this mobile number.',
    );
  }
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
  //   3. Verified + active     → issue OTP normally
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
  const issued = await otp.issue({
    purpose: 'seller_login',
    channel: 'sms',
    mobileNumber,
    label: 'sign-in',
  });
  return withDevCode({ ok: true }, issued);
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
  await otp.verify({
    purpose: 'seller_login',
    channel: 'sms',
    mobileNumber,
    code,
  });
  return issueToken(seller);
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
