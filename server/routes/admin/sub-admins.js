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
// Password: length AND composition.
//
// This was Joi.string().min(8).max(128), i.e. length only, while the admin
// form has always demanded an uppercase letter, a lowercase letter, a number
// and a symbol. Anything not going through that form - a script, a direct API
// call, a future mobile client - could therefore set a password like
// "aaaaaaaa" on an account that can administer the panel.
//
// Mirrors the `complexity` / `noSpaces` / `minLength` rules in
// src/admin/pages/SubAdmins/SubAdminForm.jsx.
const passwordField = Joi.string().min(8).max(128)
  .custom((value, helpers) => {
    if (/\s/.test(value)) return helpers.error('password.spaces');
    const hasLower = /[a-z]/.test(value);
    const hasUpper = /[A-Z]/.test(value);
    const hasDigit = /\d/.test(value);
    const hasSymbol = /[^A-Za-z0-9]/.test(value);
    if (!(hasLower && hasUpper && hasDigit && hasSymbol)) {
      return helpers.error('password.weak');
    }
    return value;
  })
  .messages({
    'string.min': 'Password must be at least 8 characters',
    'string.max': 'Password is too long (max 128)',
    'password.spaces': 'Password cannot contain spaces',
    'password.weak': 'Include upper, lower, number, and symbol',
  });

const LETTERS_ONLY = /^[A-Za-z\s]+$/;
// The form also rejects runs of two or more spaces; .trim() already handles
// the leading / trailing case it guards against.
const nameField = Joi.string().trim().min(3).max(50).pattern(LETTERS_ONLY)
  .custom((value, helpers) => (
    / {2,}/.test(value) ? helpers.error('name.doubleSpace') : value
  ))
  .messages({
    'string.pattern.base': 'Name can only contain letters and spaces',
    'string.min': 'Name must be at least 3 characters',
    'string.max': 'Name must be at most 50 characters',
    'name.doubleSpace': 'Use only single spaces between words',
  });
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
