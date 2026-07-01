const express = require('express');
const Joi = require('joi');

const { validate } = require('../../middleware/validate');
const { requireAuth, requireModule } = require('../../middleware/auth');
const { imageUploadMiddleware, documentUploadMiddleware } = require('../../middleware/imageMulter');
const idempotency = require('../../middleware/idempotency');
const management = require('../../services/website_property/management');
const { AREA_UNITS } = require('../../constants/property');
const masterCodeField = Joi.string().trim().lowercase().pattern(/^[a-z0-9][a-z0-9_-]{0,62}[a-z0-9]$/);
const { APPROVAL_STATUSES } = require('../../constants/website');
const { MODULES } = require('../../constants/modules');
const { HttpError } = require('../../middleware/errors');

const router = express.Router();

router.use(requireAuth, requireModule(MODULES.WEBSITE_PROPERTY_MANAGEMENT));

const idParam = Joi.object({ id: Joi.number().integer().positive().required() });
const subIdParam = Joi.object({
  id: Joi.number().integer().positive().required(),
  fileId: Joi.number().integer().positive().required(),
});

// Names: letters + spaces only. Titles: letters + digits + spaces (3 BHK ok).
const ALPHANUM_SPACE = /^[A-Za-z0-9\s]+$/;
const titleField = Joi.string().trim().min(3).max(50).pattern(ALPHANUM_SPACE)
  .messages({ 'string.pattern.base': 'Title can only contain letters, digits and spaces' });
const locField = Joi.string().trim().min(1).max(255);
const descField = Joi.string().trim().max(200).allow('', null);

const listQuery = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(100).default(10),
  search: Joi.string().trim().max(255).allow('').optional(),
  propertyType: masterCodeField.optional(),
  transactionType: masterCodeField.optional(),
  approvalStatus: Joi.string().valid(...APPROVAL_STATUSES).optional(),
  isActive: Joi.boolean().optional(),
  isFeatured: Joi.boolean().optional(),
  location: Joi.string().trim().max(255).optional(),
  priceMin: Joi.number().min(0).optional(),
  priceMax: Joi.number().min(0).optional(),
  dateFrom: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
  sort: Joi.string()
    .pattern(/^(created_at|price|location|property_type|title|approved_at):(asc|desc)$/)
    .default('created_at:desc'),
});

const createBody = Joi.object({
  sellerId: Joi.number().integer().positive().required(),
  title: titleField.required(),
  description: descField.optional(),
  propertyType: masterCodeField.required(),
  transactionType: masterCodeField.required(),
  location: locField.required(),
  latitude: Joi.number().min(-90).max(90).optional().allow(null),
  longitude: Joi.number().min(-180).max(180).optional().allow(null),
  areaValue: Joi.number().min(0).optional().allow(null),
  areaUnit: Joi.string().valid(...AREA_UNITS).optional().allow('', null),
  bhk: masterCodeField.optional().allow('', null),
  price: Joi.number().min(0).required(),
  approvalStatus: Joi.string().valid(...APPROVAL_STATUSES).default('pending'),
  isActive: Joi.boolean().default(true),
});

const updateBody = Joi.object({
  title: titleField.required(),
  description: descField.optional(),
  propertyType: masterCodeField.required(),
  transactionType: masterCodeField.required(),
  location: locField.required(),
  latitude: Joi.number().min(-90).max(90).optional().allow(null),
  longitude: Joi.number().min(-180).max(180).optional().allow(null),
  areaValue: Joi.number().min(0).optional().allow(null),
  areaUnit: Joi.string().valid(...AREA_UNITS).optional().allow('', null),
  bhk: masterCodeField.optional().allow('', null),
  price: Joi.number().min(0).required(),
});

const rejectBody = Joi.object({
  reason: Joi.string().trim().min(1).max(1000).required(),
});

const activeBody = Joi.object({ isActive: Joi.boolean().required() });
const featuredBody = Joi.object({ isFeatured: Joi.boolean().required() });

const suggestQuery = Joi.object({
  q: Joi.string().trim().max(255).allow('').optional(),
  limit: Joi.number().integer().min(1).max(20).default(8),
});

// Same filters as list, but pagination is optional (we export everything matching).
const exportQuery = listQuery.fork(['page', 'pageSize'], (s) => s.optional());

router.get('/', validate(listQuery, 'query'), async (req, res, next) => {
  try { res.json(await management.listProperties(req.query)); } catch (e) { next(e); }
});

// Must come BEFORE '/:id' or Express matches `id='suggest'` and 400s.
router.get('/suggest', validate(suggestQuery, 'query'), async (req, res, next) => {
  try { res.json({ data: await management.suggest(req.query) }); } catch (e) { next(e); }
});

// Export routes MUST be defined BEFORE '/:id' — same reason as /suggest.
router.get('/export.csv', validate(exportQuery, 'query'), async (req, res, next) => {
  try {
    const csv = await management.exportCsv(req.query);
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="website-properties-${stamp}.csv"`);
    res.send(csv);
  } catch (e) { next(e); }
});

router.get('/export.xlsx', validate(exportQuery, 'query'), async (req, res, next) => {
  try {
    const buffer = await management.exportXlsx(req.query);
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="website-properties-${stamp}.xlsx"`);
    res.send(buffer);
  } catch (e) { next(e); }
});

router.get('/export.pdf', validate(exportQuery, 'query'), async (req, res, next) => {
  try {
    const buffer = await management.exportPdf(req.query);
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="website-properties-${stamp}.pdf"`);
    res.send(buffer);
  } catch (e) { next(e); }
});

router.get('/:id', validate(idParam, 'params'), async (req, res, next) => {
  try { res.json(await management.getProperty(req.params.id)); } catch (e) { next(e); }
});

router.post('/', idempotency(), validate(createBody), async (req, res, next) => {
  try { res.status(201).json(await management.createProperty(req.body)); } catch (e) { next(e); }
});

router.put('/:id', validate(idParam, 'params'), validate(updateBody), async (req, res, next) => {
  try { res.json(await management.updateProperty(req.params.id, req.body)); } catch (e) { next(e); }
});

router.patch('/:id/approve', idempotency(), validate(idParam, 'params'), async (req, res, next) => {
  try {
    const adminId = req.auth.role === 'admin' ? Number(req.auth.sub) : null;
    res.json(await management.approveProperty(req.params.id, adminId, req));
  } catch (e) { next(e); }
});

router.patch('/:id/reject', idempotency(), validate(idParam, 'params'), validate(rejectBody), async (req, res, next) => {
  try {
    const adminId = req.auth.role === 'admin' ? Number(req.auth.sub) : null;
    res.json(await management.rejectProperty(req.params.id, adminId, req.body.reason, req));
  } catch (e) { next(e); }
});

router.patch('/:id/active', idempotency(), validate(idParam, 'params'), validate(activeBody), async (req, res, next) => {
  try { res.json(await management.setActive(req.params.id, req.body.isActive, req)); } catch (e) { next(e); }
});

router.patch('/:id/featured', idempotency(), validate(idParam, 'params'), validate(featuredBody), async (req, res, next) => {
  try { res.json(await management.setFeatured(req.params.id, req.body.isFeatured, req)); } catch (e) { next(e); }
});

router.delete('/:id', validate(idParam, 'params'), async (req, res, next) => {
  try { await management.removeProperty(req.params.id, req); res.status(204).end(); } catch (e) { next(e); }
});

router.post('/:id/images', validate(idParam, 'params'), imageUploadMiddleware, async (req, res, next) => {
  try {
    if (!req.files || req.files.length === 0) throw new HttpError(400, 'NO_FILES', 'No files uploaded');
    res.status(201).json(await management.addImages(req.params.id, req.files));
  } catch (e) { next(e); }
});

router.delete('/:id/images/:fileId', validate(subIdParam, 'params'), async (req, res, next) => {
  try { res.json(await management.removeImage(req.params.id, req.params.fileId)); } catch (e) { next(e); }
});

router.post('/:id/documents', validate(idParam, 'params'), documentUploadMiddleware, async (req, res, next) => {
  try {
    if (!req.files || req.files.length === 0) throw new HttpError(400, 'NO_FILES', 'No files uploaded');
    res.status(201).json(await management.addDocuments(req.params.id, req.files));
  } catch (e) { next(e); }
});

router.delete('/:id/documents/:fileId', validate(subIdParam, 'params'), async (req, res, next) => {
  try { res.json(await management.removeDocument(req.params.id, req.params.fileId)); } catch (e) { next(e); }
});

router.get('/:id/documents/:fileId', validate(subIdParam, 'params'), async (req, res, next) => {
  try {
    const file = await management.findDocument(req.params.fileId);
    if (!file || file.property_kind !== 'website' || Number(file.property_id) !== Number(req.params.id) || file.file_kind !== 'document') {
      throw new HttpError(404, 'NOT_FOUND', 'Document not found');
    }
    return management.streamDocument(res, file);
  } catch (e) { next(e); }
});

module.exports = router;
