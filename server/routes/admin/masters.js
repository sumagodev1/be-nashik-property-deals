const express = require('express');
const Joi = require('joi');

const { validate } = require('../../middleware/validate');
const { requireAuth, requireModule } = require('../../middleware/auth');
const { MODULES } = require('../../constants/modules');
const management = require('../../services/masters/management');

const router = express.Router();

router.use(requireAuth, requireModule(MODULES.MASTER_MANAGEMENT));

const masterKeyParam = Joi.object({
  key: Joi.string().valid(...management.masterKeys()).required(),
});

const idParam = Joi.object({ id: Joi.number().integer().positive().required() });

const codeField = Joi.string()
  .trim()
  .lowercase()
  .pattern(/^[a-z0-9][a-z0-9_-]{0,62}[a-z0-9]$/, 'master-code')
  .min(2).max(64);

const labelField = Joi.string().trim().min(1).max(255);
const sortField  = Joi.number().integer().min(0).max(9999);
const activeField = Joi.boolean();
// parent_code accepts the same shape as `code` (or empty / null to clear).
// Only meaningful for hierarchical lookup vocabularies (district → taluka →
// shivar); ignored by the legacy single-table masters in the service layer.
const parentCodeField = codeField.optional().allow('', null);

const createBody = Joi.object({
  code: codeField.required(),
  label: labelField.required(),
  parentCode: parentCodeField,
  sortOrder: sortField.default(0),
  isActive: activeField.default(true),
});

const updateBody = Joi.object({
  code: codeField.optional(),
  label: labelField.optional(),
  parentCode: parentCodeField,
  sortOrder: sortField.optional(),
  isActive: activeField.optional(),
}).min(1);

const listQuery = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(100).default(10),
  search: Joi.string().trim().max(255).allow('').optional(),
  isActive: Joi.boolean().optional(),
});

// GET /api/admin/masters  → list of master keys + labels (for the side nav).
router.get('/', (req, res) => {
  res.json({
    data: management.masterKeys().map((k) => management.masterMeta(k)),
  });
});

router.get(
  '/:key',
  validate(masterKeyParam, 'params'),
  validate(listQuery, 'query'),
  async (req, res, next) => {
    try { res.json(await management.list(req.params.key, req.query)); }
    catch (e) { next(e); }
  },
);

router.get(
  '/:key/:id',
  validate(Joi.object({
    key: masterKeyParam.extract('key'),
    id: idParam.extract('id'),
  }), 'params'),
  async (req, res, next) => {
    try { res.json(await management.getOne(req.params.key, req.params.id)); }
    catch (e) { next(e); }
  },
);

router.post(
  '/:key',
  validate(masterKeyParam, 'params'),
  validate(createBody),
  async (req, res, next) => {
    try {
      const created = await management.create(req.params.key, req.body);
      res.status(201).json(created);
    } catch (e) { next(e); }
  },
);

router.put(
  '/:key/:id',
  validate(Joi.object({
    key: masterKeyParam.extract('key'),
    id: idParam.extract('id'),
  }), 'params'),
  validate(updateBody),
  async (req, res, next) => {
    try { res.json(await management.update(req.params.key, req.params.id, req.body)); }
    catch (e) { next(e); }
  },
);

router.delete(
  '/:key/:id',
  validate(Joi.object({
    key: masterKeyParam.extract('key'),
    id: idParam.extract('id'),
  }), 'params'),
  async (req, res, next) => {
    try {
      await management.remove(req.params.key, req.params.id);
      res.status(204).end();
    } catch (e) { next(e); }
  },
);

module.exports = router;
