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

const LETTERS_ONLY = /^[A-Za-z\s]+$/;
const emailField = Joi.string().email({ tlds: { allow: false } }).max(255);
const mobileField = Joi.string().trim().pattern(/^\d{10}$/)
  .messages({ 'string.pattern.base': 'Enter a valid 10-digit mobile number' });
const nameField = Joi.string().trim().min(3).max(50).pattern(LETTERS_ONLY)
  .messages({ 'string.pattern.base': 'Name can only contain letters and spaces' });
const codeField = Joi.string().pattern(/^\d{6}$/);

const startBody = Joi.object({
  propertyId: Joi.number().integer().positive().required(),
  actionType: Joi.string().valid('contact_seller', 'view_location').required(),
  name: nameField.required(),
  mobile: mobileField.required(),
  // OTP delivery is email per CLAUDE.md, so email is required.
  email: emailField.required(),
  captchaToken: Joi.string().allow('', null).optional(),
});

const verifyBody = Joi.object({
  propertyId: Joi.number().integer().positive().required(),
  actionType: Joi.string().valid('contact_seller', 'view_location').required(),
  name: nameField.required(),
  mobile: mobileField.required(),
  email: emailField.required(),
  code: codeField.required(),
  message: Joi.string().trim().max(2000).allow('', null).optional(),
});

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
