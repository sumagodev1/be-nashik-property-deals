const express = require('express');
const Joi = require('joi');

const { validate } = require('../../middleware/validate');
const { requireAuth, requireModule } = require('../../middleware/auth');
const service = require('../../services/admin/business_associates');
const { MODULES } = require('../../constants/modules');

const router = express.Router();

router.use(requireAuth, requireModule(MODULES.BUSINESS_ASSOCIATE_MANAGEMENT));

const idParam = Joi.object({ id: Joi.number().integer().positive().required() });

const listQuery = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(100).default(10),
  search: Joi.string().trim().max(255).allow('').optional(),
});

const optText = (max = 255) => Joi.string().trim().max(max).allow('', null).optional();

// Phone / mobile / whatsapp — same lax character set the frontend accepts
// (digits, spaces, and + - ( )).
const phoneField = Joi.string().trim().max(20).allow('', null)
  .pattern(/^[0-9+\-\s()]*$/).optional();

// Email — trim + basic shape check; both slots are optional.
const emailField = Joi.string().trim().max(255).allow('', null)
  .pattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/).optional();

const body = Joi.object({
  salutation: Joi.string().valid('mr', 'mrs', 'miss', 'smt').required(),
  firstName: Joi.string().trim().min(1).max(100).required(),
  middleName: optText(100),
  surname: optText(100),
  designation: optText(200),
  addressLine1: optText(255),
  addressLine2: optText(255),
  cityCode: optText(64),
  talukaCode: optText(64),
  districtCode: optText(64),
  phone1: phoneField,
  phone2: phoneField,
  mobile1: phoneField,
  mobile2: phoneField,
  mobile3: phoneField,
  whatsapp: phoneField,
  email1: emailField,
  email2: emailField,
  website1: optText(255),
  website2: optText(255),
  // ISO date — the frontend datepicker emits YYYY-MM-DD.
  dateOfBirth: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).allow('', null).optional(),
});

router.get('/', validate(listQuery, 'query'), async (req, res, next) => {
  try { res.json(await service.list(req.query)); } catch (e) { next(e); }
});

router.get('/:id', validate(idParam, 'params'), async (req, res, next) => {
  try { res.json(await service.getOne(req.params.id)); } catch (e) { next(e); }
});

router.post('/', validate(body, 'body'), async (req, res, next) => {
  try {
    const adminId = req.auth?.role === 'admin' ? Number(req.auth.sub) : null;
    res.status(201).json(await service.create(req.body, adminId));
  } catch (e) { next(e); }
});

router.put(
  '/:id',
  validate(idParam, 'params'),
  validate(body, 'body'),
  async (req, res, next) => {
    try { res.json(await service.update(req.params.id, req.body)); } catch (e) { next(e); }
  },
);

router.delete('/:id', validate(idParam, 'params'), async (req, res, next) => {
  try { await service.remove(req.params.id); res.status(204).end(); } catch (e) { next(e); }
});

module.exports = router;
