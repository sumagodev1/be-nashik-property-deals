const express = require('express');
const Joi = require('joi');

const { validate } = require('../../middleware/validate');
const {
  requireAuth,
  requireModule,
  requireModuleWriteOnMutation,
} = require('../../middleware/auth');
const management = require('../../services/sub_admin/management');
const { MODULES, MODULE_KEYS } = require('../../constants/modules');

const router = express.Router();

// T-2026-173-B: Sub Admin management is now a grantable module. Administrator
// role bypasses via requireModule's role==='admin' short-circuit. Sub-admins
// with SUB_ADMIN_MANAGEMENT (read) can list/view sub-admins; those with
// SUB_ADMIN_MANAGEMENT (write) additionally get POST/PUT/PATCH/DELETE
// (create / edit / deactivate / grant modules). Prior behaviour
// (requireRole('admin')) is preserved for administrators because the
// middleware short-circuits for role==='admin' before any grant check;
// existing sub-admins have NO grant on deploy so nothing is auto-escalated.
router.use(
  requireAuth,
  requireModule(MODULES.SUB_ADMIN_MANAGEMENT),
  requireModuleWriteOnMutation(MODULES.SUB_ADMIN_MANAGEMENT),
);

const emailField = Joi.string().email({ tlds: { allow: false } }).max(255);
const passwordField = Joi.string().min(8).max(128);
const LETTERS_ONLY = /^[A-Za-z\s]+$/;
const nameField = Joi.string().trim().min(3).max(50).pattern(LETTERS_ONLY)
  .messages({ 'string.pattern.base': 'Name can only contain letters and spaces' });
// T-2026-173: `modules` now accepts EITHER shape:
//   - legacy string (implicit write, preserves pre-T-173 API callers)
//   - { module_key, access_level } object (new UI shape)
// Joi.alternatives() picks whichever matches per array element, and the
// service layer's dedupePermissions() normalizes both to the object shape.
const moduleKeyField = Joi.string().valid(...MODULE_KEYS);
const moduleGrantField = Joi.alternatives().try(
  moduleKeyField,
  Joi.object({
    module_key: moduleKeyField.required(),
    access_level: Joi.string().valid('read', 'write').default('write'),
  }),
);

const idParam = Joi.object({ id: Joi.number().integer().positive().required() });

const listQuery = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(100).default(10),
  search: Joi.string().trim().max(255).allow('').optional(),
  isActive: Joi.boolean().optional(),
});

const createBody = Joi.object({
  email: emailField.required(),
  password: passwordField.required(),
  fullName: nameField.required(),
  isActive: Joi.boolean().default(true),
  modules: Joi.array().items(moduleGrantField).default([]),
});

const updateBody = Joi.object({
  email: emailField.optional(),
  password: passwordField.optional(),
  fullName: nameField.optional(),
  isActive: Joi.boolean().optional(),
}).min(1);

const updateModulesBody = Joi.object({
  modules: Joi.array().items(moduleGrantField).required(),
});

router.get('/', validate(listQuery, 'query'), async (req, res, next) => {
  try {
    res.json(await management.list(req.query));
  } catch (err) {
    next(err);
  }
});

router.get('/:id', validate(idParam, 'params'), async (req, res, next) => {
  try {
    res.json(await management.getOne(req.params.id));
  } catch (err) {
    next(err);
  }
});

router.post('/', validate(createBody), async (req, res, next) => {
  try {
    const created = await management.create({ ...req.body, createdByAdminId: Number(req.auth.sub), req });
    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

router.put('/:id', validate(idParam, 'params'), validate(updateBody), async (req, res, next) => {
  try {
    res.json(await management.update(req.params.id, req.body, req));
  } catch (err) {
    next(err);
  }
});

router.put('/:id/modules', validate(idParam, 'params'), validate(updateModulesBody), async (req, res, next) => {
  try {
    res.json(await management.updateModules(req.params.id, req.body.modules, req));
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', validate(idParam, 'params'), async (req, res, next) => {
  try {
    await management.remove(req.params.id, req);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
