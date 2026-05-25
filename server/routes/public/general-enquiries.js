const express = require('express');
const Joi = require('joi');
const rateLimit = require('express-rate-limit');

const { validate } = require('../../middleware/validate');
const idempotency = require('../../middleware/idempotency');
const service = require('../../services/public/general_enquiries');
const { verifyCaptcha } = require('../../services/auth/captcha');
const { TRANSACTION_TYPES } = require('../../constants/property');

const router = express.Router();

const limiter = rateLimit({
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
const categoryField = Joi.string().valid(...TRANSACTION_TYPES);

const startBody = Joi.object({
  name: nameField.required(),
  mobile: mobileField.required(),
  // OTP delivery is email per CLAUDE.md, so email is required.
  email: emailField.required(),
  captchaToken: Joi.string().allow('', null).optional(),
});

const verifyBody = Joi.object({
  name: nameField.required(),
  mobile: mobileField.required(),
  email: emailField.required(),
  code: codeField.required(),
  message: Joi.string().trim().max(2000).allow('', null).optional(),
  categories: Joi.array().items(categoryField).unique().max(3).optional(),
});

router.post('/start', limiter, idempotency(), validate(startBody), async (req, res, next) => {
  try {
    await verifyCaptcha(req.body.captchaToken, req.ip);
    const { captchaToken, ...payload } = req.body;
    res.json(await service.start(payload));
  } catch (e) { next(e); }
});

// /verify is intentionally not captcha-gated — the OTP code is the gate at
// this stage, and the user already solved the captcha at /start.
router.post('/verify', limiter, idempotency(), validate(verifyBody), async (req, res, next) => {
  try { res.json(await service.verify(req.body)); } catch (e) { next(e); }
});

module.exports = router;
