const express = require('express');
const Joi = require('joi');
const rateLimit = require('express-rate-limit');

const { validate } = require('../../middleware/validate');
const idempotency = require('../../middleware/idempotency');
const leadService = require('../../services/public/leads');
const { verifyCaptcha } = require('../../services/auth/captcha');

const router = express.Router();

const captureLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again later.' } },
});

// Public enquiry / lead capture. Property-data fields (name, mobile, email,
// message) are format-relaxed — no min length, no pattern check. Only the
// system contract stays required: which property, which action, and the
// OTP code on /verify. `email` still needs to be present on /start so the
// OTP has somewhere to be delivered.
const emailField = Joi.string().max(255).allow('', null);
const mobileField = Joi.string().trim().max(20).allow('', null);
const nameField = Joi.string().trim().max(255).allow('', null);
const codeField = Joi.string().pattern(/^\d{6}$/);

const startBody = Joi.object({
  propertyId: Joi.number().integer().positive().required(),
  actionType: Joi.string().valid('contact_seller', 'view_location').required(),
  name: nameField.optional(),
  mobile: mobileField.optional(),
  email: Joi.string().max(255).allow(null).required(),
  captchaToken: Joi.string().allow('', null).optional(),
}).unknown(true);

const verifyBody = Joi.object({
  propertyId: Joi.number().integer().positive().required(),
  actionType: Joi.string().valid('contact_seller', 'view_location').required(),
  name: nameField.optional(),
  mobile: mobileField.optional(),
  email: emailField.optional(),
  code: codeField.required(),
  message: Joi.string().trim().max(2000).allow('', null).optional(),
}).unknown(true);

router.post('/start', captureLimiter, idempotency(), validate(startBody), async (req, res, next) => {
  try {
    await verifyCaptcha(req.body.captchaToken, req.ip);
    const { captchaToken, ...payload } = req.body;
    res.json(await leadService.start(payload));
  } catch (e) { next(e); }
});

// /verify is intentionally not captcha-gated — the 6-digit OTP code is the
// gate at this stage, and the user already passed captcha at /start. Adding
// a second captcha here would force a re-solve mid-flow with no security gain.
router.post('/verify', captureLimiter, idempotency(), validate(verifyBody), async (req, res, next) => {
  try { res.json(await leadService.verify(req.body)); } catch (e) { next(e); }
});

module.exports = router;
