const express = require('express');
const Joi = require('joi');
const rateLimit = require('express-rate-limit');

const { validate } = require('../../middleware/validate');
const auth = require('../../services/seller/auth');

const router = express.Router();

const startLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again later.' } },
});

const emailField = Joi.string().email({ tlds: { allow: false } }).max(255);
const mobileField = Joi.string().trim().pattern(/^[+\-0-9 ()]{6,20}$/);
const nameField = Joi.string().trim().min(1).max(255);
const codeField = Joi.string().pattern(/^\d{6}$/);

const registerStart = Joi.object({
  userType: Joi.string().valid('owner', 'agent').required(),
  fullName: nameField.required(),
  mobileNumber: mobileField.required(),
  email: emailField.optional().allow('', null),
  agencyName: Joi.string().trim().max(255).allow('', null).optional(),
  businessAddress: Joi.string().trim().max(1000).allow('', null).optional(),
  area: Joi.string().trim().max(255).allow('', null).optional(),
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

const loginStart = Joi.object({ mobileNumber: mobileField.required() });
const loginVerify = Joi.object({
  mobileNumber: mobileField.required(),
  code: codeField.required(),
});

router.post('/register/start', startLimiter, validate(registerStart), async (req, res, next) => {
  try {
    const body = { ...req.body };
    if (typeof body.email === 'string' && body.email.trim() === '') delete body.email;
    res.json(await auth.registerStart(body));
  } catch (e) { next(e); }
});

router.post('/register/verify', validate(registerVerify), async (req, res, next) => {
  try { res.json(await auth.registerVerify(req.body)); } catch (e) { next(e); }
});

router.post('/register/resend', startLimiter, validate(loginStart), async (req, res, next) => {
  try {
    const sellers = require('../../db/queries/sellers');
    const otp = require('../../services/auth/otp');
    const seller = await sellers.findByMobile(req.body.mobileNumber);
    if (!seller || seller.is_verified) {
      return res.json({ ok: true });
    }
    const issued = await otp.issue({
      purpose: 'seller_register',
      channel: 'sms',
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
  try { res.json(await auth.loginStart(req.body)); } catch (e) { next(e); }
});

router.post('/login/verify', validate(loginVerify), async (req, res, next) => {
  try { res.json(await auth.loginVerify(req.body)); } catch (e) { next(e); }
});

module.exports = router;
