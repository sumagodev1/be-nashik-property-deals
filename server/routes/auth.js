const express = require('express');
const Joi = require('joi');
const rateLimit = require('express-rate-limit');

const { validate } = require('../middleware/validate');
const { requireAuth } = require('../middleware/auth');
const auth = require('../services/auth/login');

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many attempts. Try again later.' } },
});

const loginSchema = Joi.object({
  email: Joi.string().email({ tlds: { allow: false } }).max(255).required(),
  password: Joi.string().min(1).max(128).required(),
});

router.post('/login', loginLimiter, validate(loginSchema), async (req, res, next) => {
  try {
    res.json(await auth.login(req.body));
  } catch (err) {
    next(err);
  }
});

router.get('/me', requireAuth, async (req, res, next) => {
  try {
    res.json({ user: await auth.me(req.auth) });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', requireAuth, (req, res) => {
  // Stateless JWT — client discards. Endpoint exists so the client has a single
  // logout surface; future refresh-token revocation hooks in here.
  res.json({ ok: true });
});

module.exports = router;
