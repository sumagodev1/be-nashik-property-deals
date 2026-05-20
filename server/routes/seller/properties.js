const express = require('express');
const Joi = require('joi');

const { validate } = require('../../middleware/validate');
const { requireAuth, requireRole } = require('../../middleware/auth');
const { imageUploadMiddleware } = require('../../middleware/imageMulter');
const sellerProperties = require('../../services/seller/properties');
const { AREA_UNITS } = require('../../constants/property');
const masterCodeField = Joi.string().trim().lowercase().pattern(/^[a-z0-9][a-z0-9_-]{0,62}[a-z0-9]$/);
const { HttpError } = require('../../middleware/errors');

const router = express.Router();

router.use(requireAuth, requireRole('seller'));

const idParam = Joi.object({ id: Joi.number().integer().positive().required() });
const subIdParam = Joi.object({
  id: Joi.number().integer().positive().required(),
  fileId: Joi.number().integer().positive().required(),
});

const titleField = Joi.string().trim().min(1).max(255);
const locField = Joi.string().trim().min(1).max(255);
const descField = Joi.string().trim().max(10000).allow('', null);

const listQuery = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(100).default(10),
  sort: Joi.string()
    .pattern(/^(created_at|price|approval_status):(asc|desc)$/)
    .default('created_at:desc'),
});

const propertyBody = Joi.object({
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
  // Open-ended bag of extra fields the seller form collects (amenities,
  // landmark, etc.). Stored as JSON. Capped at 50 keys to keep payload sane.
  details: Joi.object().unknown(true).max(50).optional().allow(null),
});

router.get('/', validate(listQuery, 'query'), async (req, res, next) => {
  try { res.json(await sellerProperties.listOwn(Number(req.auth.sub), req.query)); }
  catch (e) { next(e); }
});

router.get('/:id', validate(idParam, 'params'), async (req, res, next) => {
  try { res.json(await sellerProperties.getOwn(Number(req.auth.sub), req.params.id)); }
  catch (e) { next(e); }
});

router.post('/', validate(propertyBody), async (req, res, next) => {
  try {
    res.status(201).json(await sellerProperties.createOwn(Number(req.auth.sub), req.body));
  } catch (e) { next(e); }
});

router.put('/:id', validate(idParam, 'params'), validate(propertyBody), async (req, res, next) => {
  try {
    res.json(await sellerProperties.updateOwn(Number(req.auth.sub), req.params.id, req.body));
  } catch (e) { next(e); }
});

router.delete('/:id', validate(idParam, 'params'), async (req, res, next) => {
  try {
    await sellerProperties.removeOwn(Number(req.auth.sub), req.params.id);
    res.status(204).end();
  } catch (e) { next(e); }
});

router.post('/:id/images', validate(idParam, 'params'), imageUploadMiddleware, async (req, res, next) => {
  try {
    if (!req.files || req.files.length === 0) throw new HttpError(400, 'NO_FILES', 'No files uploaded');
    res.status(201).json(await sellerProperties.addImages(Number(req.auth.sub), req.params.id, req.files));
  } catch (e) { next(e); }
});

router.delete('/:id/images/:fileId', validate(subIdParam, 'params'), async (req, res, next) => {
  try {
    res.json(await sellerProperties.removeImage(Number(req.auth.sub), req.params.id, req.params.fileId));
  } catch (e) { next(e); }
});

// Amenities upload — multipart with `images[]` files and `names` field (either
// a JSON-encoded array or a multi-valued form field, in the same order as the
// files). Each entry becomes a property_files row with file_kind='amenity'
// and the typed amenity label stored in original_name.
router.post('/:id/amenities', validate(idParam, 'params'), imageUploadMiddleware, async (req, res, next) => {
  try {
    if (!req.files || req.files.length === 0) throw new HttpError(400, 'NO_FILES', 'No amenity images uploaded');
    // `names` may arrive as a JSON string, a single string, or an array
    // depending on how the client built the FormData. Normalise to string[].
    let names = req.body.names;
    if (typeof names === 'string') {
      try {
        const parsed = JSON.parse(names);
        if (Array.isArray(parsed)) names = parsed;
        else names = [names];
      } catch { names = [names]; }
    }
    if (!Array.isArray(names)) names = names ? [names] : [];
    res.status(201).json(await sellerProperties.addAmenities(Number(req.auth.sub), req.params.id, req.files, names));
  } catch (e) { next(e); }
});

router.delete('/:id/amenities/:fileId', validate(subIdParam, 'params'), async (req, res, next) => {
  try {
    res.json(await sellerProperties.removeAmenity(Number(req.auth.sub), req.params.id, req.params.fileId));
  } catch (e) { next(e); }
});

module.exports = router;
