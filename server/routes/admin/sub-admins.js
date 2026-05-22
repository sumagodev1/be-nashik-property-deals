const express = require('express');
const Joi = require('joi');

const { validate } = require('../../middleware/validate');
const { requireAuth, requireRole } = require('../../middleware/auth');
const management = require('../../services/sub_admin/management');
const { MODULE_KEYS } = require('../../constants/modules');

const router = express.Router();

// All routes require an authenticated admin (NOT sub admin — admin manages sub admins).
router.use(requireAuth, requireRole('admin'));

const emailField = Joi.string().email({ tlds: { allow: false } }).max(255);
const passwordField = Joi.string().min(8).max(128);
const LETTERS_ONLY = /^[A-Za-z\s]+$/;
const nameField = Joi.string().trim().min(3).max(50).pattern(LETTERS_ONLY)
  .messages({ 'string.pattern.base': 'Name can only contain letters and spaces' });
const moduleField = Joi.string().valid(...MODULE_KEYS);

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
  modules: Joi.array().items(moduleField).default([]),
});

const updateBody = Joi.object({
  email: emailField.optional(),
  password: passwordField.optional(),
  fullName: nameField.optional(),
  isActive: Joi.boolean().optional(),
}).min(1);

const updateModulesBody = Joi.object({
  modules: Joi.array().items(moduleField).required(),
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
    const created = await management.create({ ...req.body, createdByAdminId: Number(req.auth.sub) });
    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

router.put('/:id', validate(idParam, 'params'), validate(updateBody), async (req, res, next) => {
  try {
    res.json(await management.update(req.params.id, req.body));
  } catch (err) {
    next(err);
  }
});

router.put('/:id/modules', validate(idParam, 'params'), validate(updateModulesBody), async (req, res, next) => {
  try {
    res.json(await management.updateModules(req.params.id, req.body.modules));
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', validate(idParam, 'params'), async (req, res, next) => {
  try {
    await management.remove(req.params.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
