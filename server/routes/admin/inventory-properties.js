const express = require('express');
const Joi = require('joi');

const { validate } = require('../../middleware/validate');
const { requireAuth, requireModule } = require('../../middleware/auth');
const { imageUploadMiddleware, documentUploadMiddleware } = require('../../middleware/imageMulter');
const management = require('../../services/inventory/management');
const {
  AREA_UNITS,
} = require('../../constants/property');

// Master codes are validated semantically in the service layer against the
// current master_* tables (which the admin can edit). The shape check below
// just ensures the value looks like a master code so we fail fast on garbage.
const masterCodeField = Joi.string().trim().lowercase().pattern(/^[a-z0-9][a-z0-9_-]{0,62}[a-z0-9]$/);
const { MODULES } = require('../../constants/modules');
const { HttpError } = require('../../middleware/errors');

const router = express.Router();

router.use(requireAuth, requireModule(MODULES.INVENTORY_MANAGEMENT));

const idParam = Joi.object({ id: Joi.number().integer().positive().required() });
const subIdParam = Joi.object({
  id: Joi.number().integer().positive().required(),
  fileId: Joi.number().integer().positive().required(),
});

const titleField = Joi.string().trim().min(1).max(255);
const descField = Joi.string().trim().max(10000).allow('', null);
const locField = Joi.string().trim().min(1).max(255);
const phoneField = Joi.string().trim().pattern(/^[+\-0-9 ()]{6,20}$/).allow('', null);
const personField = Joi.string().trim().max(255).allow('', null);

const listQuery = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(100).default(10),
  search: Joi.string().trim().max(255).allow('').optional(),
  propertyType: masterCodeField.optional(),
  transactionType: masterCodeField.optional(),
  status: masterCodeField.optional(),
  location: Joi.string().trim().max(255).optional(),
  priceMin: Joi.number().min(0).optional(),
  priceMax: Joi.number().min(0).optional(),
  dateFrom: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
  isDraft: Joi.boolean().optional(),
  sort: Joi.string()
    .pattern(/^(created_at|price|location|property_type|title):(asc|desc)$/)
    .default('created_at:desc'),
});

// Drafts skip strict validation on price/transaction/etc — only title + type
// are required for identification. Non-drafts use the standard required set.
const propertyBody = Joi.object({
  title: titleField.required(),
  description: descField.optional(),
  propertyType: masterCodeField.when('isDraft', { is: true, then: Joi.optional(), otherwise: Joi.required() }),
  transactionType: masterCodeField.when('isDraft', { is: true, then: Joi.optional(), otherwise: Joi.required() }),
  location: Joi.alternatives().conditional('isDraft', {
    is: true,
    then: locField.optional().allow('', null),
    otherwise: locField.required(),
  }),
  areaValue: Joi.number().min(0).optional().allow(null),
  areaUnit: Joi.string().valid(...AREA_UNITS).optional().allow('', null),
  bhk: masterCodeField.optional().allow('', null),
  price: Joi.number().min(0).when('isDraft', { is: true, then: Joi.optional(), otherwise: Joi.required() }),
  status: masterCodeField.default('available'),
  isDraft: Joi.boolean().default(false),
  ownerName: personField.optional(),
  ownerContact: phoneField.optional(),
  agentName: personField.optional(),
  agentContact: phoneField.optional(),
});

const statusBody = Joi.object({
  status: masterCodeField.required(),
});

const suggestQuery = Joi.object({
  q: Joi.string().trim().max(255).allow('').optional(),
  limit: Joi.number().integer().min(1).max(20).default(8),
  includeDrafts: Joi.boolean().default(false),
});

// Export query: same filters as list, but pagination is optional.
const exportQuery = listQuery.fork(['page', 'pageSize'], (s) => s.optional());

router.get('/', validate(listQuery, 'query'), async (req, res, next) => {
  try {
    res.json(await management.listProperties(req.query));
  } catch (err) {
    next(err);
  }
});

router.get('/suggest', validate(suggestQuery, 'query'), async (req, res, next) => {
  try {
    res.json({ data: await management.suggest(req.query) });
  } catch (err) {
    next(err);
  }
});

// IMPORTANT: export routes MUST be defined BEFORE /:id, otherwise Express
// treats `export.csv` and `export.xlsx` as :id values and the param validator
// rejects them.
router.get('/export.csv', validate(exportQuery, 'query'), async (req, res, next) => {
  try {
    const csv = await management.exportCsv(req.query);
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="inventory-${stamp}.csv"`);
    res.send(csv);
  } catch (err) {
    next(err);
  }
});

router.get('/export.xlsx', validate(exportQuery, 'query'), async (req, res, next) => {
  try {
    const buffer = await management.exportXlsx(req.query);
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="inventory-${stamp}.xlsx"`);
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', validate(idParam, 'params'), async (req, res, next) => {
  try {
    res.json(await management.getProperty(req.params.id));
  } catch (err) {
    next(err);
  }
});

router.post('/', validate(propertyBody), async (req, res, next) => {
  try {
    const created = await management.createProperty({
      ...req.body,
      // Drafts default missing fields to safe placeholders so the row is insertable.
      price: req.body.price ?? 0,
      propertyType: req.body.propertyType || 'flat',
      transactionType: req.body.transactionType || 'sale',
      location: req.body.location || '',
      createdByAdminId: req.auth.role === 'admin' ? Number(req.auth.sub) : null,
    });
    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

router.put('/:id', validate(idParam, 'params'), validate(propertyBody), async (req, res, next) => {
  try {
    res.json(await management.updateProperty(req.params.id, {
      ...req.body,
      price: req.body.price ?? 0,
      propertyType: req.body.propertyType || 'flat',
      transactionType: req.body.transactionType || 'sale',
      location: req.body.location || '',
    }));
  } catch (err) {
    next(err);
  }
});

router.patch('/:id/status', validate(idParam, 'params'), validate(statusBody), async (req, res, next) => {
  try {
    res.json(await management.updateStatus(req.params.id, req.body.status));
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', validate(idParam, 'params'), async (req, res, next) => {
  try {
    await management.removeProperty(req.params.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.post('/:id/images', validate(idParam, 'params'), imageUploadMiddleware, async (req, res, next) => {
  try {
    if (!req.files || req.files.length === 0) {
      throw new HttpError(400, 'NO_FILES', 'No files uploaded');
    }
    res.status(201).json(await management.addImages(req.params.id, req.files));
  } catch (err) {
    next(err);
  }
});

router.delete('/:id/images/:fileId', validate(subIdParam, 'params'), async (req, res, next) => {
  try {
    res.json(await management.removeImage(req.params.id, req.params.fileId));
  } catch (err) {
    next(err);
  }
});

router.post('/:id/documents', validate(idParam, 'params'), documentUploadMiddleware, async (req, res, next) => {
  try {
    if (!req.files || req.files.length === 0) {
      throw new HttpError(400, 'NO_FILES', 'No files uploaded');
    }
    res.status(201).json(await management.addDocuments(req.params.id, req.files));
  } catch (err) {
    next(err);
  }
});

router.delete('/:id/documents/:fileId', validate(subIdParam, 'params'), async (req, res, next) => {
  try {
    res.json(await management.removeDocument(req.params.id, req.params.fileId));
  } catch (err) {
    next(err);
  }
});

// Stream a private document. Auth + module gate already enforced by router.use.
router.get('/:id/documents/:fileId', validate(subIdParam, 'params'), async (req, res, next) => {
  try {
    const file = await management.findDocument(req.params.fileId);
    if (!file || file.property_kind !== 'inventory' || Number(file.property_id) !== Number(req.params.id) || file.file_kind !== 'document') {
      throw new HttpError(404, 'NOT_FOUND', 'Document not found');
    }
    return management.streamDocument(res, file);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
