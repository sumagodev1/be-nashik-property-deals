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
  // Owner Search filter (T-2026-032, additive). Narrows to associates
  // whose name / phone / mobile / whatsapp / email matches. Disjoint
  // from the existing global `search` param.
  ownerSearch: Joi.string().trim().max(255).allow('').optional(),
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
  salutation: Joi.string().valid('mr', 'mrs', 'miss', 'smt').allow('', null).optional(),
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
  // T-2026-040: Owner-duplicate confirmation bypass flag. Frontend sets
  // this to true after the operator confirms the "Duplicate Owner Found"
  // dialog so any (optional) backend duplicate check can be skipped on the
  // retry submit. Currently no backend duplicate check exists on this
  // route, but the flag is accepted here so any future check can honour
  // the confirmation without a schema change. The service layer's
  // normalize() explicitly picks known fields so this key is stripped
  // before the DB insert.
  skipDuplicateOwnerValidation: Joi.boolean().optional(),
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


// ── Bulk upload (additive) ───────────────────────────────────────────────
//
// Two endpoints layered on top of the existing single-record CRUD:
//   1) POST /bulk-check-duplicates  — accepts an array of contact-only rows
//      and returns per-index { isDuplicate, matchedField, matchedId }.
//      Used by the frontend before the operator commits so we can show the
//      "Duplicate Business Associates Found" confirmation.
//   2) POST /bulk                    — accepts an array of full-shape rows
//      and imports them one row per transaction, returning per-row status.
//      Never rolls back an already-committed row; failed rows carry an
//      error string the frontend surfaces in its Error Report Excel.
//
// The bulk arrays are capped at 5000 to match the frontend upload limit.

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
