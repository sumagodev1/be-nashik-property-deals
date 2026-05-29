const express = require('express');
const Joi = require('joi');

const { validate } = require('../../middleware/validate');
const service = require('../../services/public/properties');

const router = express.Router();

// Property + transaction type filters are matched against master codes
// (lowercase, alphanumeric + dash/underscore). We accept any well-formed
// master code here instead of hardcoding the legacy seed enum — admins
// add new property types like Shop / Land / Hostel / Paying Guest via
// Masters → Property Type and the listing filter needs to accept them
// without a route deploy. Invalid codes just yield zero rows (no security
// risk since the value is bound as a SQL parameter).
const masterCodeField = Joi.string().trim().lowercase()
  .pattern(/^[a-z0-9][a-z0-9_-]{0,62}[a-z0-9]$/);

// Multi-select aware variant: accepts a comma-separated list of master codes
// (each code must still satisfy the master-code pattern). Used by the
// public listing's Property Type filter so the buyer can shortlist Flat +
// Villa + Plot together.
const masterCodeListField = Joi.string().trim().lowercase()
  .pattern(/^[a-z0-9][a-z0-9_-]{0,62}[a-z0-9](,[a-z0-9][a-z0-9_-]{0,62}[a-z0-9])*$/);

const listQuery = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(48).default(12),
  search: Joi.string().trim().max(255).allow('').optional(),
  propertyType: masterCodeListField.optional(),
  transactionType: masterCodeField.optional(),
  location: Joi.string().trim().max(255).optional(),
  priceMin: Joi.number().min(0).optional(),
  priceMax: Joi.number().min(0).optional(),
  sort: Joi.string().valid('latest', 'price_asc', 'price_desc').default('latest'),
});

const featuredQuery = Joi.object({ limit: Joi.number().integer().min(1).max(20).default(6) });

const idParam = Joi.object({ identifier: Joi.string().trim().required() });
const similarQuery = Joi.object({ limit: Joi.number().integer().min(1).max(12).default(4) });

router.get('/', validate(listQuery, 'query'), async (req, res, next) => {
  try { res.json(await service.listPublic(req.query)); } catch (e) { next(e); }
});

router.get('/featured', validate(featuredQuery, 'query'), async (req, res, next) => {
  try { res.json({ data: await service.featured(req.query) }); } catch (e) { next(e); }
});

router.get('/latest', validate(featuredQuery, 'query'), async (req, res, next) => {
  try { res.json({ data: await service.latest(req.query) }); } catch (e) { next(e); }
});

// /:identifier/similar must be registered BEFORE the bare /:identifier route
// — Express matches in order and a longer-prefix route still goes through
// the param validator above.
router.get('/:identifier/similar', validate(idParam, 'params'), validate(similarQuery, 'query'), async (req, res, next) => {
  try { res.json({ data: await service.similar({ id: req.params.identifier, limit: req.query.limit }) }); } catch (e) { next(e); }
});

router.get('/:identifier', validate(idParam, 'params'), async (req, res, next) => {
  try { res.json(await service.getPublic(req.params.identifier)); } catch (e) { next(e); }
});

module.exports = router;
