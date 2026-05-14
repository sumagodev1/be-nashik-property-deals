const express = require('express');
const Joi = require('joi');
const rateLimit = require('express-rate-limit');

const { validate } = require('../../middleware/validate');
const service = require('../../services/public/general_enquiries');
const { TRANSACTION_TYPES } = require('../../constants/property');

const router = express.Router();

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again later.' } },
});

const emailField = Joi.string().email({ tlds: { allow: false } }).max(255);
const mobileField = Joi.string().trim().pattern(/^[+\-0-9 ()]{6,20}$/);
const nameField = Joi.string().trim().min(1).max(255);
const codeField = Joi.string().pattern(/^\d{6}$/);
const categoryField = Joi.string().valid(...TRANSACTION_TYPES);

const startBody = Joi.object({
  name: nameField.required(),
  mobile: mobileField.required(),
  email: emailField.optional().allow('', null),
});

const verifyBody = Joi.object({
  name: nameField.required(),
  mobile: mobileField.required(),
  email: emailField.optional().allow('', null),
  code: codeField.required(),
  message: Joi.string().trim().max(2000).allow('', null).optional(),
  categories: Joi.array().items(categoryField).unique().max(3).optional(),
});

router.post('/start', limiter, validate(startBody), async (req, res, next) => {
  try { res.json(await service.start(req.body)); } catch (e) { next(e); }
});

router.post('/verify', limiter, validate(verifyBody), async (req, res, next) => {
  try { res.json(await service.verify(req.body)); } catch (e) { next(e); }
});

module.exports = router;
