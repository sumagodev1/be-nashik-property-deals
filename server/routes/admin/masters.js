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

// T-2026-045: description is optional; only persisted for masters whose
// backing table has the column (currently just status_type). Sending it on
// other masters is silently dropped in the service layer.
const descriptionField = Joi.string().trim().max(255).allow('', null).optional();

const createBody = Joi.object({
  code: codeField.required(),
  label: labelField.required(),
  parentCode: parentCodeField,
  sortOrder: sortField.default(0),
  isActive: activeField.default(true),
  description: descriptionField,
});

const updateBody = Joi.object({
  code: codeField.optional(),
  label: labelField.optional(),
  parentCode: parentCodeField,
  sortOrder: sortField.optional(),
  isActive: activeField.optional(),
  description: descriptionField,
}).min(1);

// T-2026-045: sort is `<key>` or `<key>:<dir>` where key is one of
// name | createdAt | status and dir is asc | desc (default asc). The
// repo whitelists both parts so unknown values fall back to the default
// sort_order+label ordering.
const sortListQueryPattern = /^(name|createdAt|status)(:(asc|desc))?$/i;
const sortField_listQuery = Joi.string().trim().pattern(sortListQueryPattern).optional();

const listQuery = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(100).default(10),
  search: Joi.string().trim().max(255).allow('').optional(),
  isActive: Joi.boolean().optional(),
  sort: sortField_listQuery,
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
      // T-2026-045: pass `req` so the service can attribute the audit-log
      // entry to the acting admin (+ IP).
      const created = await management.create(req.params.key, req.body, req);
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
    try { res.json(await management.update(req.params.key, req.params.id, req.body, req)); }
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
      await management.remove(req.params.key, req.params.id, req);
      res.status(204).end();
    } catch (e) { next(e); }
  },
);

module.exports = router;
