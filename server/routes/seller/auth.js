const express = require('express');
const Joi = require('joi');
const rateLimit = require('express-rate-limit');

const { validate } = require('../../middleware/validate');
const idempotency = require('../../middleware/idempotency');
const auth = require('../../services/seller/auth');
const { verifyCaptcha } = require('../../services/auth/captcha');
const refresh = require('../../services/auth/refresh');

/**
 * Some seller auth endpoints (register/verify, login/verify) hand back a
 * { token, user, refreshToken? } triple. The raw refresh token must land
 * in an httpOnly cookie — never in the JSON body — so the front end can
 * silent-refresh after a reload but JS code can't lift it.
 */
function respondWithSession(res, result) {
  if (result && result.refreshToken) {
    refresh.setRefreshCookie(res, result.refreshToken);
    const { refreshToken, ...body } = result;
    return res.json(body);
  }
  return res.json(result);
}

const router = express.Router();

const startLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again later.' } },
});

// /verify is hit once per OTP submission. We allow 10 per 15 min per IP —
// roomy enough for a fat-fingered user to keep trying without locking
// themselves out, tight enough to stop an attacker from cycling through
// fresh OTPs to brute-force a 6-digit code. The OTP itself also enforces
// MAX_ATTEMPTS = 5 per row, so this IS in addition to that per-OTP cap.
const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many verification attempts. Try again later.' } },
});

const LETTERS_ONLY = /^[A-Za-z\s]+$/;
const emailField = Joi.string().email({ tlds: { allow: false } }).max(255);
const mobileField = Joi.string().trim().pattern(/^\d{10}$/)
  .messages({ 'string.pattern.base': 'Enter a valid 10-digit mobile number' });
const nameField = Joi.string().trim().min(3).max(50).pattern(LETTERS_ONLY)
  .messages({ 'string.pattern.base': 'Name can only contain letters and spaces' });
const codeField = Joi.string().pattern(/^\d{6}$/);

const registerStart = Joi.object({
  userType: Joi.string().valid('owner', 'agent').required(),
  fullName: nameField.required(),
  mobileNumber: mobileField.required(),
  // Email is required: OTP delivery channel is SMTP per CLAUDE.md, so the
  // seller must have an email address to receive the verification code.
  email: emailField.required(),
  agencyName: Joi.string().trim().max(255).allow('', null).optional(),
  businessAddress: Joi.string().trim().max(1000).allow('', null).optional(),
  area: Joi.string().trim().max(255).allow('', null).optional(),
  captchaToken: Joi.string().allow('', null).optional(),
})
  .custom((value, helpers) => {
    if (value.userType === 'agent' && (!value.agencyName || !value.agencyName.trim())) {
      return helpers.error('any.invalid', { message: 'Agency name is required for agents' });
    }
    return value;
  });

const registerVerify = Joi.object({
  mobileNumber: mobileField.required(),
  code: codeField.required(),
});

const loginStart = Joi.object({
  email: emailField.required(),
  captchaToken: Joi.string().allow('', null).optional(),
});
const loginVerify = Joi.object({
  email: emailField.required(),
  code: codeField.required(),
});
// Registration resend still keys on the mobile number captured at signup
// (the user hasn't typed an email since registering, so we look them up
// the same way the registration flow does).
const registerResend = Joi.object({
  mobileNumber: mobileField.required(),
  captchaToken: Joi.string().allow('', null).optional(),
});

router.post('/register/start', startLimiter, idempotency(), validate(registerStart), async (req, res, next) => {
  try {
    await verifyCaptcha(req.body.captchaToken, req.ip);
    const { captchaToken, ...payload } = req.body;
    res.json(await auth.registerStart(payload));
  } catch (e) { next(e); }
});

router.post('/register/verify', verifyLimiter, idempotency(), validate(registerVerify), async (req, res, next) => {
  try { respondWithSession(res, await auth.registerVerify(req.body)); } catch (e) { next(e); }
});

router.post('/register/resend', startLimiter, validate(registerResend), async (req, res, next) => {
  try {
    const sellers = require('../../db/queries/sellers');
    const otp = require('../../services/auth/otp');
    const seller = await sellers.findByMobile(req.body.mobileNumber);
    if (!seller || seller.is_verified || !seller.email) {
      return res.json({ ok: true });
    }
    const issued = await otp.issue({
      purpose: 'seller_register',
      channel: 'email',
      email: String(seller.email).toLowerCase(),
      mobileNumber: req.body.mobileNumber,
      label: 'registration',
    });
    const payload = { ok: true };
    if (process.env.NODE_ENV !== 'production' && issued && issued.code) {
      payload.devOtpCode = issued.code;
    }
    res.json(payload);
  } catch (e) { next(e); }
});

router.post('/login/start', startLimiter, validate(loginStart), async (req, res, next) => {
  try {
    await verifyCaptcha(req.body.captchaToken, req.ip);
    const { captchaToken, ...payload } = req.body;
    res.json(await auth.loginStart(payload));
  } catch (e) { next(e); }
});

router.post('/login/verify', verifyLimiter, validate(loginVerify), async (req, res, next) => {
  try { respondWithSession(res, await auth.loginVerify(req.body)); } catch (e) { next(e); }
});

module.exports = router;
