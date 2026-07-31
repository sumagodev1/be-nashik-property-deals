/**
 * Admin routes for the Key PIN master.
 *
 * Endpoints:
 *   GET    /api/admin/key-pins             — list (masked, no hash)
 *   GET    /api/admin/key-pins/:id         — single (masked, no hash)
 *   POST   /api/admin/key-pins             — create { pin, status? }
 *   PUT    /api/admin/key-pins/:id         — update { pin?, status? }
 *   DELETE /api/admin/key-pins/:id         — soft-delete
 *   POST   /api/admin/key-pins/verify      — verify { pin } → { ok:true } or 401
 *
 * Auth: all endpoints require an authenticated admin session. CRUD is
 * further gated behind the MASTER_MANAGEMENT module; /verify is available
 * to any authenticated admin/sub_admin because the PIN itself is the
 * secondary factor being checked.
 *
 * Rate limit: /verify has its own limiter to blunt brute-force. CRUD
 * endpoints rely on the module ACL.
 */

const express = require('express');
const Joi = require('joi');
const rateLimit = require('express-rate-limit');

const { validate } = require('../../middleware/validate');
const { requireAuth, requireModule } = require('../../middleware/auth');
const { MODULES } = require('../../constants/modules');
const service = require('../../services/security/key_pins');

const router = express.Router();

// -----------------------------------------------------------------------
// Validation schemas
// -----------------------------------------------------------------------
const pinField = Joi.string().pattern(/^[0-9]{6}$/, '6-digit-numeric').messages({
  'string.pattern.name': 'PIN must be exactly 6 numeric digits.',
  'string.empty': 'PIN is required.',
});

const statusField = Joi.string().valid('active', 'inactive');

const idParam = Joi.object({
  id: Joi.number().integer().positive().required(),
});

const listQuery = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(100).default(10),
  status: statusField.optional(),
});

const createBody = Joi.object({
  pin: pinField.required(),
  status: statusField.default('active'),
});

const updateBody = Joi.object({
  pin: pinField.optional(),
  status: statusField.optional(),
}).min(1);

const verifyBody = Joi.object({
  pin: pinField.required(),
});

// -----------------------------------------------------------------------
// Rate limiter for the /verify endpoint (per IP).
// 20 attempts per 5 minutes — enough for legitimate misfires, tight
// enough to make brute-force impractical against a 6-digit space.
// -----------------------------------------------------------------------
const verifyLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many PIN attempts. Please wait a few minutes and try again.',
    },
  },
});

// -----------------------------------------------------------------------
// /verify — available to any authenticated user. Route order matters:
// mounted BEFORE the module-gated CRUD so sub-admins without the
// MASTER_MANAGEMENT module can still call it.
// -----------------------------------------------------------------------
router.post(
  '/verify',
  requireAuth,
  verifyLimiter,
  validate(verifyBody),
  async (req, res, next) => {
    try {
      const result = await service.verify(req.body);
      res.json(result);
    } catch (e) {
      next(e);
    }
  },
);

// -----------------------------------------------------------------------
// CRUD — restricted to admins holding MASTER_MANAGEMENT.
// -----------------------------------------------------------------------
router.use(requireAuth, requireModule(MODULES.MASTER_MANAGEMENT));

router.get(
  '/',
  validate(listQuery, 'query'),
  async (req, res, next) => {
    try { res.json(await service.list(req.query)); }
    catch (e) { next(e); }
  },
);

router.get(
  '/:id',
  validate(idParam, 'params'),
  async (req, res, next) => {
    try { res.json(await service.getOne(req.params.id)); }
    catch (e) { next(e); }
  },
);

router.post(
  '/',
  validate(createBody),
  async (req, res, next) => {
    try {
      const created = await service.create(req.body, req);
      res.status(201).json(created);
    } catch (e) { next(e); }
  },
);

router.put(
  '/:id',
  validate(idParam, 'params'),
  validate(updateBody),
  async (req, res, next) => {
    try { res.json(await service.update(req.params.id, req.body, req)); }
    catch (e) { next(e); }
  },
);

router.delete(
  '/:id',
  validate(idParam, 'params'),
  async (req, res, next) => {
    try {
      await service.remove(req.params.id);
      res.status(204).end();
    } catch (e) { next(e); }
  },
);

module.exports = router;
