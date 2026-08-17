/**
 * Admin routes for the Global / Email master.
 *
 * Endpoints (all mounted at /api/admin/email-settings, all require an
 * authenticated admin with MASTER_MANAGEMENT):
 *   GET    /                 — list (paginated)
 *   GET    /:id              — single (password never exposed)
 *   POST   /                 — create
 *   PUT    /:id              — update
 *   DELETE /:id              — soft-delete
 *   POST   /:id/activate     — flip is_active to 1 exclusively
 *   POST   /:id/test         — send a test email using this config
 *
 * The plaintext SMTP password is accepted only on POST/PUT (as `password`
 * in the body) and is never returned by any endpoint. Responses carry a
 * `hasPassword` boolean instead.
 */

const express = require('express');
const Joi = require('joi');
const rateLimit = require('express-rate-limit');

const { validate } = require('../../middleware/validate');
const { requireAuth, requireModule, requireModuleWriteOnMutation } = require('../../middleware/auth');
const { MODULES } = require('../../constants/modules');
const service = require('../../services/email/email_settings');

const router = express.Router();

// -----------------------------------------------------------------------
// Validation schemas
// -----------------------------------------------------------------------
const idParam = Joi.object({
  id: Joi.number().integer().positive().required(),
});

const listQuery = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(100).default(20),
});

// Fine-grained field validation lives in the service so error messages
// stay human-readable. Joi's job here is coarse shape validation.
const createBody = Joi.object({
  smtp_host: Joi.string().max(255).required(),
  smtp_port: Joi.number().integer().min(1).max(65535).default(587),
  smtp_username: Joi.string().allow('', null).max(255).optional(),
  password: Joi.string().allow('', null).max(500).optional(),
  sender_email: Joi.string().email().required(),
  sender_name: Joi.string().max(255).required(),
  encryption: Joi.string().valid('none', 'ssl', 'tls').default('tls'),
  reply_to_email: Joi.string().email().allow('', null).optional(),
  admin_email: Joi.string().email().required(),
  is_active: Joi.boolean().optional(),
});

const updateBody = Joi.object({
  smtp_host: Joi.string().max(255).optional(),
  smtp_port: Joi.number().integer().min(1).max(65535).optional(),
  smtp_username: Joi.string().allow('', null).max(255).optional(),
  password: Joi.string().allow('', null).max(500).optional(),
  sender_email: Joi.string().email().optional(),
  sender_name: Joi.string().max(255).optional(),
  encryption: Joi.string().valid('none', 'ssl', 'tls').optional(),
  reply_to_email: Joi.string().email().allow('', null).optional(),
  admin_email: Joi.string().email().optional(),
  is_active: Joi.boolean().optional(),
}).min(1);

const testBody = Joi.object({
  recipient: Joi.string().email().optional(),
});

// -----------------------------------------------------------------------
// Test-email rate limiter: cap at 10 sends per hour per IP. Prevents an
// admin (or a stolen session) from abusing the endpoint as an open relay.
// -----------------------------------------------------------------------
const testLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many test emails. Try again in an hour.' } },
});

router.use(requireAuth, requireModule(MODULES.MASTER_MANAGEMENT));
// T-2026-173 Phase 2: sub-admins with only Read access get 403 on mutation.
// This also gates the POST /:id/activate + POST /:id/test endpoints which
// technically mutate state (activate flips is_active; test sends an email).
router.use(requireModuleWriteOnMutation(MODULES.MASTER_MANAGEMENT));

router.get('/', validate(listQuery, 'query'), async (req, res, next) => {
  try { res.json(await service.list(req.query)); }
  catch (e) { next(e); }
});

router.get('/:id', validate(idParam, 'params'), async (req, res, next) => {
  try { res.json(await service.getOne(req.params.id)); }
  catch (e) { next(e); }
});

router.post('/', validate(createBody), async (req, res, next) => {
  try {
    const created = await service.create(req.body, req);
    res.status(201).json(created);
  } catch (e) { next(e); }
});

router.put('/:id', validate(idParam, 'params'), validate(updateBody), async (req, res, next) => {
  try { res.json(await service.update(req.params.id, req.body, req)); }
  catch (e) { next(e); }
});

router.delete('/:id', validate(idParam, 'params'), async (req, res, next) => {
  try {
    await service.remove(req.params.id, req);
    res.status(204).end();
  } catch (e) { next(e); }
});

router.post('/:id/activate', validate(idParam, 'params'), async (req, res, next) => {
  try { res.json(await service.activate(req.params.id, req)); }
  catch (e) { next(e); }
});

router.post(
  '/:id/test',
  validate(idParam, 'params'),
  validate(testBody),
  testLimiter,
  async (req, res, next) => {
    try { res.json(await service.sendTestEmail(req.params.id, req.body || {})); }
    catch (e) { next(e); }
  },
);

module.exports = router;
