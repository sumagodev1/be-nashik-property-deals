const express = require('express');
const Joi = require('joi');

const { validate } = require('../../middleware/validate');
const service = require('../../services/public/properties');
const {
  PROPERTY_TYPES,
  TRANSACTION_TYPES,
} = require('../../constants/property');

const router = express.Router();

const listQuery = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(48).default(12),
  search: Joi.string().trim().max(255).allow('').optional(),
  propertyType: Joi.string().valid(...PROPERTY_TYPES).optional(),
  transactionType: Joi.string().valid(...TRANSACTION_TYPES).optional(),
  location: Joi.string().trim().max(255).optional(),
  priceMin: Joi.number().min(0).optional(),
  priceMax: Joi.number().min(0).optional(),
  sort: Joi.string().valid('latest', 'price_asc', 'price_desc').default('latest'),
});

const featuredQuery = Joi.object({ limit: Joi.number().integer().min(1).max(20).default(6) });

const idParam = Joi.object({ identifier: Joi.string().trim().required() });

router.get('/', validate(listQuery, 'query'), async (req, res, next) => {
  try { res.json(await service.listPublic(req.query)); } catch (e) { next(e); }
});

router.get('/featured', validate(featuredQuery, 'query'), async (req, res, next) => {
  try { res.json({ data: await service.featured(req.query) }); } catch (e) { next(e); }
});

router.get('/latest', validate(featuredQuery, 'query'), async (req, res, next) => {
  try { res.json({ data: await service.latest(req.query) }); } catch (e) { next(e); }
});

router.get('/:identifier', validate(idParam, 'params'), async (req, res, next) => {
  try { res.json(await service.getPublic(req.params.identifier)); } catch (e) { next(e); }
});

module.exports = router;
