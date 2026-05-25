const express = require('express');
const Joi = require('joi');
const rateLimit = require('express-rate-limit');

const { validate } = require('../middleware/validate');
const { requireAuth } = require('../middleware/auth');
const auth = require('../services/auth/login');
const passwordReset = require('../services/auth/password_reset');
const { verifyCaptcha } = require('../services/auth/captcha');
const refresh = require('../services/auth/refresh');

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many attempts. Try again later.' } },
});

// Forgot-password is more aggressively rate-limited because it also enqueues
// email — keep it well below the SMTP budget on cPanel.
const forgotLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many reset requests. Try again later.' } },
});

// /reset-password verifies an OTP + sets a new password. Without an IP-level
// cap, an attacker could keep retrying the 6-digit code across multiple
// freshly-issued OTPs. The OTP itself caps at 5 wrong attempts per row, but
// this stops the attacker from cycling — 10 attempts per 15 min mirrors the
// seller verify limiter for consistency.
const resetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many verification attempts. Try again later.' } },
});

const loginSchema = Joi.object({
  email: Joi.string().email({ tlds: { allow: false } }).max(255).required(),
  password: Joi.string().min(1).max(128).required(),
  captchaToken: Joi.string().allow('', null).optional(),
});

router.post('/login', loginLimiter, validate(loginSchema), async (req, res, next) => {
  try {
    await verifyCaptcha(req.body.captchaToken, req.ip);
    const { captchaToken, ...credentials } = req.body;
    const result = await auth.login(credentials);
    // Set the refresh-token cookie (httpOnly + secure in prod + path-scoped
    // to /api/auth). Strip the raw token from the JSON body so it never
    // touches client-side JS.
    refresh.setRefreshCookie(res, result.refreshToken);
    const { refreshToken, ...body } = result;
    res.json(body);
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

// Silent refresh — no auth required (the httpOnly cookie IS the auth).
// Rotates the refresh token (single-use) and returns a fresh short-lived
// access token + the current user profile. Frontend calls this on app boot
// and on any 401 response.
router.post('/refresh', async (req, res, next) => {
  try {
    const raw = refresh.readRefreshCookie(req);
    const result = await refresh.rotateAndReissue(raw);
    refresh.setRefreshCookie(res, result.refreshToken);
    res.json({ token: result.accessToken, user: result.user });
  } catch (err) {
    // Wipe the cookie on any failure so a stale/compromised one doesn't
    // sit in the browser indefinitely.
    refresh.clearRefreshCookie(res);
    next(err);
  }
});

router.post('/logout', async (req, res, next) => {
  try {
    // Revoke the refresh token on the server side so the cookie can't be
    // replayed even if it leaked. Then clear the client-side cookie.
    const raw = refresh.readRefreshCookie(req);
    await refresh.revoke(raw);
    refresh.clearRefreshCookie(res);
    res.json({ ok: true });
  } catch (err) {
    // Best-effort logout — never block the user from signing out.
    refresh.clearRefreshCookie(res);
    next(err);
  }
});

const forgotSchema = Joi.object({
  email: Joi.string().email({ tlds: { allow: false } }).max(255).required(),
});

router.post('/forgot-password', forgotLimiter, validate(forgotSchema), async (req, res, next) => {
  try {
    res.json(await passwordReset.requestReset(req.body.email));
  } catch (err) {
    next(err);
  }
});

const resetSchema = Joi.object({
  email: Joi.string().email({ tlds: { allow: false } }).max(255).required(),
  otp: Joi.string().pattern(/^\d{6}$/).required(),
  password: Joi.string().min(8).max(128).required(),
});

router.post('/reset-password', resetLimiter, validate(resetSchema), async (req, res, next) => {
  try {
    res.json(await passwordReset.completeReset(req.body));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
