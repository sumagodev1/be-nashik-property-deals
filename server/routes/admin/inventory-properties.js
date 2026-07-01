const express = require('express');
const Joi = require('joi');

const { validate } = require('../../middleware/validate');
const { requireAuth, requireModule } = require('../../middleware/auth');
const { imageUploadMiddleware, documentUploadMiddleware } = require('../../middleware/imageMulter');
const idempotency = require('../../middleware/idempotency');
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

// Project-wide rules:
//   - Names (person names): 3–50 chars, letters + spaces ONLY.
//   - Titles (property titles): 3–50 chars, letters + digits + spaces. No
//     punctuation. "3 BHK Apartment" is valid; "3-BHK!" is not.
//   - Descriptions: capped at 200 chars.
// Mirror in src/shared/validation/rules.js on the frontend.
const LETTERS_ONLY = /^[A-Za-z\s]+$/;
const ALPHANUM_SPACE = /^[A-Za-z0-9\s]+$/;
const titleField = Joi.string().trim().min(3).max(50).pattern(ALPHANUM_SPACE)
  .messages({ 'string.pattern.base': 'Title can only contain letters, digits and spaces' });
const descField = Joi.string().trim().max(200).allow('', null);
const locField = Joi.string().trim().min(1).max(255);
const propertyTypeField = Joi.string().trim().max(255);
const phoneField = Joi.string().trim().pattern(/^\d{10}$/).allow('', null)
  .messages({ 'string.pattern.base': 'Enter a valid 10-digit mobile number' });
const personField = Joi.string().trim().min(3).max(50).pattern(LETTERS_ONLY).allow('', null)
  .messages({ 'string.pattern.base': 'Name can only contain letters and spaces' });

const listQuery = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(100).default(10),
  search: Joi.string().trim().max(255).allow('').optional(),
  propertyType: Joi.string().trim().max(255).allow('').optional(),
  transactionType: Joi.string().trim().max(255).allow('').optional(),
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

// Sanity ceilings — catch typos like an extra zero on price/area without
// being so tight that they reject a real ultra-prime Nashik property.
// 1000 crore (1e10) covers any conceivable real-estate price; 10 lakh sq.ft
// covers any realistic land parcel.
const PRICE_MAX = 1_000_00_00_000;
const AREA_MAX = 10_00_000;

// Drafts skip strict validation on price/transaction/etc — only title + type
// are required for identification. Non-drafts use the standard required set.
const propertyBody = Joi.object({
  title: titleField.required(),
  description: descField.optional(),
  // Registration date as written by the admin on the form (separate from the
  // system created_at). Optional — defaults to NULL when not supplied.
  registrationDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional().allow('', null),
  propertyType: propertyTypeField.when('isDraft', { is: true, then: Joi.optional(), otherwise: Joi.required() }),
  transactionType: Joi.string().trim().max(255).allow('', null).optional(),
  // Sub-variant of transactionType: Resale vs New Sale, Joint Venture,
  // Hostel Let In/Out, Paying Guest. Master-validated against transaction_type
  // master rows (which already carry the full set of variants).
  transactionVariant: masterCodeField.optional().allow('', null),
  location: Joi.alternatives().conditional('isDraft', {
    is: true,
    then: locField.optional().allow('', null),
    otherwise: locField.required(),
  }),
  // Hierarchical location. Validated as master codes against district/taluka/
  // shivar lookups in the service layer.
  district: masterCodeField.optional().allow('', null),
  taluka: masterCodeField.optional().allow('', null),
  shivar: masterCodeField.optional().allow('', null),
  // Coordinates (promoted from details.lat/lng to columns for list-time
  // filtering / sort). Bounded loosely to India.
  latitude: Joi.number().min(6).max(38).optional().allow(null),
  longitude: Joi.number().min(68).max(98).optional().allow(null),
  pincode: Joi.string().trim().pattern(/^\d{6}$/).optional().allow('', null)
    .messages({ 'string.pattern.base': 'Enter a valid 6-digit pincode' }),
  areaValue: Joi.number().min(0).max(AREA_MAX).optional().allow(null),
  areaUnit: Joi.string().valid(...AREA_UNITS).optional().allow('', null),
  bhk: masterCodeField.optional().allow('', null),
  price: Joi.number()
    .min(0)
    .max(PRICE_MAX)
    .when('isDraft', { is: true, then: Joi.optional(), otherwise: Joi.number().min(1).required() }),
  status: masterCodeField.default('available'),
  isDraft: Joi.boolean().default(false),
  ownerName: personField.optional(),
  ownerContact: phoneField.optional(),
  agentName: personField.optional(),
  agentContact: phoneField.optional(),
  // Open-ended bag of category-specific fields (flat floor / plot zoning /
  // hostel timing / stamp duty breakdown / etc. + lat/lng map pin). The form
  // shape is defined on the client; the server just stores it as JSON.
  // Capped at 200 keys to prevent abuse — well above what any real
  // registration form would need.
  details: Joi.object().unknown(true).max(200).optional().allow(null),
});

const statusBody = Joi.object({
  status: masterCodeField.required(),
  // Free-text "why" the admin recorded when flipping the status. Optional so a
  // quick status flip doesn't force typing; capped at 500 chars (well over a
  // sentence or two of context).
  note: Joi.string().trim().max(500).allow('', null).optional(),
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

router.get('/export.pdf', validate(exportQuery, 'query'), async (req, res, next) => {
  try {
    const buffer = await management.exportPdf(req.query);
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="inventory-${stamp}.pdf"`);
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

router.post('/', idempotency(), validate(propertyBody), async (req, res, next) => {
  try {
    const created = await management.createProperty({
      ...req.body,
      // Drafts default missing fields to safe placeholders so the row is insertable.
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

router.put('/:id', validate(idParam, 'params'), validate(propertyBody), async (req, res, next) => {
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
