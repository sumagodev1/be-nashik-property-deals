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

// Public general enquiries. All content fields are format-relaxed and
// optional. The OTP flow still needs `email` on /start (OTP delivery) and
// `code` on /verify (the OTP itself).
const emailField = Joi.string().max(255).allow('', null);
const mobileField = Joi.string().trim().max(20).allow('', null);
const nameField = Joi.string().trim().max(255).allow('', null);
const codeField = Joi.string().pattern(/^\d{6}$/);
const categoryField = Joi.string().max(255);

const startBody = Joi.object({
  name: nameField.optional(),
  mobile: mobileField.optional(),
  email: Joi.string().max(255).allow(null).required(),
  captchaToken: Joi.string().allow('', null).optional(),
}).unknown(true);

const verifyBody = Joi.object({
  name: nameField.optional(),
  mobile: mobileField.optional(),
  email: emailField.optional(),
  code: codeField.required(),
  message: Joi.string().trim().max(2000).allow('', null).optional(),
  categories: Joi.array().items(categoryField).max(10).optional(),
}).unknown(true);

// One-step submit for the public Contact Us form. Captcha gates spam; no OTP.
const submitBody = Joi.object({
  name: nameField.optional(),
  mobile: mobileField.optional(),
  email: emailField.optional(),
  message: Joi.string().trim().max(2000).allow('', null).optional(),
  categories: Joi.array().items(categoryField).max(10).optional(),
  captchaToken: Joi.string().allow('', null).optional(),
}).unknown(true);

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

// /submit is the no-OTP path used by the public Contact Us form. Captcha is
// the spam gate (same widget as /start). Property-specific lead capture
// (Contact Seller / View Location) keeps the OTP flow above.
router.post('/submit', limiter, idempotency(), validate(submitBody), async (req, res, next) => {
  try {
    await verifyCaptcha(req.body.captchaToken, req.ip);
    const { captchaToken, ...payload } = req.body;
    res.json(await service.submit(payload));
  } catch (e) { next(e); }
});

module.exports = router;
