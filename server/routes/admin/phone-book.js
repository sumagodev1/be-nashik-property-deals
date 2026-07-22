const express = require('express');
const Joi = require('joi');

const { validate } = require('../../middleware/validate');
const { requireAuth, requireModule } = require('../../middleware/auth');
const service = require('../../services/admin/phone_book');
const { MODULES } = require('../../constants/modules');

const router = express.Router();

router.use(requireAuth, requireModule(MODULES.PHONE_BOOK_MANAGEMENT));

const idParam = Joi.object({ id: Joi.number().integer().positive().required() });

const listQuery = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(100).default(10),
  search: Joi.string().trim().max(255).allow('').optional(),
});

const optText = (max = 255) => Joi.string().trim().max(max).allow('', null).optional();

const phoneField = Joi.string().trim().max(20).allow('', null)
  .pattern(/^[0-9+\-\s()]*$/).optional();

const emailField = Joi.string().trim().max(255).allow('', null)
  .pattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/).optional();

const body = Joi.object({
  salutation: Joi.string().valid('mr', 'mrs', 'miss', 'smt').allow('', null).optional(),
  firstName: Joi.string().trim().min(1).max(100).required(),
  middleName: optText(100),
  surname: optText(100),
  companyName: optText(255),
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
  dateOfBirth: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).allow('', null).optional(),
  notes: optText(500),
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

// ── Bulk upload ──────────────────────────────────────────────────────────
// Independent from Business Associates bulk. Both endpoints only touch the
// `phone_book` table.

const bulkCheckBody = Joi.object({
  items: Joi.array().max(5000).items(Joi.object({
    mobile1:  phoneField,
    phone1:   phoneField,
    whatsapp: phoneField,
    email1:   emailField,
  }).unknown(true)).required(),
});

const bulkCreateBody = Joi.object({
  items: Joi.array().max(5000).items(body).required(),
  skipDuplicates: Joi.boolean().default(false),
});

router.post(
  '/bulk-check-duplicates',
  validate(bulkCheckBody, 'body'),
  async (req, res, next) => {
    try {
      const duplicates = await service.bulkCheckDuplicates(req.body.items);
      res.json({ duplicates });
    } catch (e) { next(e); }
  },
);

router.post(
  '/bulk',
  validate(bulkCreateBody, 'body'),
  async (req, res, next) => {
    try {
      const adminId = req.auth?.role === 'admin' ? Number(req.auth.sub) : null;
      const results = await service.bulkCreate(
        req.body.items,
        { skipDuplicates: Boolean(req.body.skipDuplicates), adminId },
      );
      res.status(201).json({ results });
    } catch (e) { next(e); }
  },
);

module.exports = router;
