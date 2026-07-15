const express = require('express');
const Joi = require('joi');

const { validate } = require('../../middleware/validate');
const { requireAuth, requireModule } = require('../../middleware/auth');
const { imageUploadMiddleware, documentUploadMiddleware } = require('../../middleware/imageMulter');
const idempotency = require('../../middleware/idempotency');
const management = require('../../services/enquiry/management');
// dynamicData validation is table-agnostic — reused from the inventory
// service to keep the shape rules (contact/phone/email/dualMode/etc.)
// authored in one place. Enquiry rows use the same DynamicPropertyForm
// engine on the frontend, so the payload shape is identical.
const { validateDynamicData } = require('../../services/inventory/dynamicDataValidation');
const {
  AREA_UNITS,
} = require('../../constants/property');

const masterCodeField = Joi.string().trim().lowercase().pattern(/^[a-z0-9][a-z0-9_-]{0,62}[a-z0-9]$/);
const { MODULES } = require('../../constants/modules');
const { HttpError } = require('../../middleware/errors');

const router = express.Router();

// Access control reuses INVENTORY_MANAGEMENT — a Sub Admin who can manage
// Inventory records is authorised to manage Enquiry records as well. This
// avoids silently locking existing Sub Admins out of the new surface on
// deploy. If finer-grained separation is needed later, introduce
// ENQUIRY_MANAGEMENT here and grant it to existing roles in a follow-up.
router.use(requireAuth, requireModule(MODULES.INVENTORY_MANAGEMENT));

const idParam = Joi.object({ id: Joi.number().integer().positive().required() });
const subIdParam = Joi.object({
  id: Joi.number().integer().positive().required(),
  fileId: Joi.number().integer().positive().required(),
});

// Every property/enquiry field is optional at the API layer. Only structural
// caps (max lengths, non-negative bounds) remain — no min lengths, no format
// patterns, no `.required()` on property fields.
const titleField = Joi.string().trim().max(255).allow('', null);
const descField = Joi.string().trim().max(2000).allow('', null);
const locField = Joi.string().trim().max(255).allow('', null);
const propertyTypeField = Joi.string().trim().max(255).allow('', null);
const phoneField = Joi.string().trim().max(20).allow('', null);
const personField = Joi.string().trim().max(255).allow('', null);

const listQuery = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(100).default(10),
  search: Joi.string().trim().max(255).allow('').optional(),
  propertyType: Joi.string().trim().max(255).allow('').optional(),
  transactionType: Joi.string().trim().max(255).allow('').optional(),
  // Cascading filter additions (2026-07-14) — mirror of the inventory
  // route. See routes/admin/inventory-properties.js listQuery for the
  // full contract; these two schemas are structural mirrors by design.
  district: masterCodeField.allow('').optional(),
  taluka: masterCodeField.allow('').optional(),
  shivar: masterCodeField.allow('').optional(),
  propertyTypeIn: Joi.string().max(8192).allow('').optional(),
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

const PRICE_MAX = 1_000_00_00_000;
const AREA_MAX = 10_00_000;

// Every property field is optional. Accepts partial payloads.
const propertyBody = Joi.object({
  title: titleField,
  description: descField,
  registrationDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional().allow('', null),
  propertyType: propertyTypeField,
  transactionType: Joi.string().trim().max(255).allow('', null).optional(),
  transactionVariant: masterCodeField.optional().allow('', null),
  location: locField,
  district: masterCodeField.optional().allow('', null),
  taluka: masterCodeField.optional().allow('', null),
  shivar: masterCodeField.optional().allow('', null),
  latitude: Joi.number().min(-90).max(90).optional().allow(null, ''),
  longitude: Joi.number().min(-180).max(180).optional().allow(null, ''),
  pincode: Joi.string().trim().max(20).allow('', null).optional(),
  areaValue: Joi.number().min(0).max(AREA_MAX).optional().allow(null, ''),
  areaUnit: Joi.string().max(50).optional().allow('', null),
  bhk: masterCodeField.optional().allow('', null),
  price: Joi.number().min(0).max(PRICE_MAX).optional().allow(null, ''),
  status: masterCodeField.default('available'),
  isDraft: Joi.boolean().default(false),
  ownerName: personField.optional(),
  ownerContact: phoneField.optional(),
  agentName: personField.optional(),
  agentContact: phoneField.optional(),
  details: Joi.object().unknown(true).max(200).optional().allow(null),
}).unknown(true);

const statusBody = Joi.object({
  status: masterCodeField.required(),
  note: Joi.string().trim().max(500).allow('', null).optional(),
});

const suggestQuery = Joi.object({
  q: Joi.string().trim().max(255).allow('').optional(),
  limit: Joi.number().integer().min(1).max(20).default(8),
  includeDrafts: Joi.boolean().default(false),
});

const exportQuery = listQuery.fork(['page', 'pageSize'], (s) => s.optional());

function validateDynamicDataMiddleware(req, res, next) {
  try {
    const body = req.body || {};
    if (body.isDraft) return next();
    const dyn = body.details && body.details.dynamicData;
    if (!dyn) return next();
    const { value, errors } = validateDynamicData(dyn);
    if (errors.length > 0) {
      const details = errors.map((e) => ({
        path: `details.dynamicData.${e.path}`,
        message: e.message,
      }));
      return next(new HttpError(400, 'VALIDATION_ERROR', 'Invalid request', details));
    }
    req.body.details.dynamicData = value;
    return next();
  } catch (err) {
    return next(err);
  }
}

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

router.get('/export.csv', validate(exportQuery, 'query'), async (req, res, next) => {
  try {
    const csv = await management.exportCsv(req.query);
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="enquiry-${stamp}.csv"`);
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
    res.setHeader('Content-Disposition', `attachment; filename="enquiry-${stamp}.xlsx"`);
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

router.get('/export.pdf', validate(exportQuery, 'query'), async (req, res, next) => {
  try {
    const buffer = await management.exportPdf(req.query);
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="enquiry-${stamp}.pdf"`);
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

router.post('/', idempotency(), validate(propertyBody), validateDynamicDataMiddleware, async (req, res, next) => {
  try {
    const created = await management.createProperty({
      ...req.body,
      price: req.body.price ?? 0,
      propertyType: req.body.propertyType || '',
      transactionType: req.body.transactionType || 'sale',
      location: req.body.location || '',
      createdByAdminId: req.auth.role === 'admin' ? Number(req.auth.sub) : null,
    });
    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

router.put('/:id', validate(idParam, 'params'), validate(propertyBody), validateDynamicDataMiddleware, async (req, res, next) => {
  try {
    res.json(await management.updateProperty(req.params.id, {
      ...req.body,
      price: req.body.price ?? 0,
      propertyType: req.body.propertyType || '',
      transactionType: req.body.transactionType || 'sale',
      location: req.body.location || '',
    }));
  } catch (err) {
    next(err);
  }
});

router.patch('/:id/status', idempotency(), validate(idParam, 'params'), validate(statusBody), async (req, res, next) => {
  try {
    const changedBy = req.auth?.role === 'admin' ? Number(req.auth.sub) : null;
    res.json(await management.updateStatus(req.params.id, req.body.status, req.body.note || null, changedBy));
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

router.get('/:id/documents/:fileId', validate(subIdParam, 'params'), async (req, res, next) => {
  try {
    const file = await management.findDocument(req.params.fileId);
    if (!file || file.property_kind !== 'enquiry' || Number(file.property_id) !== Number(req.params.id) || file.file_kind !== 'document') {
      throw new HttpError(404, 'NOT_FOUND', 'Document not found');
    }
    return management.streamDocument(res, file);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
