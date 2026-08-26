const express = require('express');
const Joi = require('joi');

const { validate } = require('../../middleware/validate');
const { requireAuth, requireModule, requireModuleWriteOnMutation } = require('../../middleware/auth');
const service = require('../../services/admin/business_associates');
const { MODULES } = require('../../constants/modules');

const router = express.Router();

router.use(requireAuth, requireModule(MODULES.BUSINESS_ASSOCIATE_MANAGEMENT));
// T-2026-173 Phase 2: sub-admins with only Read access get 403 on mutation.
router.use(requireModuleWriteOnMutation(MODULES.BUSINESS_ASSOCIATE_MANAGEMENT));

const idParam = Joi.object({ id: Joi.number().integer().positive().required() });

const listQuery = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(100).default(10),
  // Unified global search — scans every user-visible text column
  // (name, company, designation, address, phone/mobile/whatsapp,
  // email, website, notes, business_category, general_category, …).
  search: Joi.string().trim().max(255).allow('').optional(),
  // Legacy owner-only search (T-2026-032, T-2026-036). Retained so
  // any pre-merge caller that still passes it gets the same behaviour.
  ownerSearch: Joi.string().trim().max(255).allow('').optional(),
  // Unified module filters. All optional / composable.
  generalCategory: Joi.string().valid('business_associate', 'phone_book').allow('').optional(),
  businessCategory: Joi.string().trim().max(255).allow('').optional(),
  designation: Joi.string().trim().max(200).allow('').optional(),
});

const optText = (max = 255) => Joi.string().trim().max(max).allow('', null).optional();

// A single NAME PART: one word, no spaces. Letters plus the punctuation that
// legitimately appears inside names (D'Souza, Mary-Jane, an initial like
// "K."). Digits and spaces are rejected on purpose.
//
// Nothing stopped an operator typing a whole name into First Name. With
// Middle Name and Surname also filled in, the record then rendered as
// "Mrs. Rohini mahesh gaikwad Mahesh Gaikwad" — the name doubled up in the
// display string and in every export.
//
// Mirrored by NAME_PATTERN in
// src/admin/pages/BusinessAssociates/BusinessAssociateForm.jsx.
const NAME_RE = /^[A-Za-z][A-Za-z.'-]*$/;
const nameMsg = (label) => label
  + ' must be a single name (letters only, no spaces). Use the separate'
  + ' Middle Name and Surname fields for the rest.';

// Phone slots accept digits only, including an optional STD code, and contain
// 8-15 digits.
const phoneField = Joi.string().pattern(/^\d{8,15}$/).allow('', null).optional()
  .messages({
    'string.base': 'Enter a valid phone number with 8-15 digits',
    'string.pattern.base': 'Enter a valid phone number with 8-15 digits',
  });

// Mobile slots (mobile1 / mobile2 / mobile3 / whatsapp) are 10-digit Indian
// mobile numbers. These used the lax phoneField too, so twenty digits of
// anything validated; the form's only complaint was "Too long".
//
// Mirrored by MOBILE_PATTERN in
// src/admin/pages/BusinessAssociates/BusinessAssociateForm.jsx.
const mobileField = Joi.string().pattern(/^[6-9]\d{9}$/).allow('', null).optional()
  .messages({
    'string.base': 'Enter a valid 10-digit mobile number starting with 6-9',
    'string.pattern.base': 'Enter a valid 10-digit mobile number starting with 6-9',
  });

// Website — must carry a scheme and a dotted host. These were plain
// optText(255), so any string validated and rows of digits were stored as
// websites. Mirrored by URL_PATTERN in
// src/admin/pages/BusinessAssociates/BusinessAssociateForm.jsx.
const urlField = Joi.string().trim().max(255).allow('', null)
  .pattern(/^https?:\/\/[^\s.]+\.[^\s]{2,}$/i).optional()
  .messages({
    'string.pattern.base': 'Enter a full web address, e.g. https://example.com',
  });

// Email — trim + basic shape check; both slots are optional.
const emailField = Joi.string().trim().max(255).allow('', null)
  .pattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/).optional();

const body = Joi.object({
  // Unified module: 'business_associate' | 'phone_book'. Optional on the
  // wire (defaults to 'business_associate' in the service) so any
  // pre-merge script that still POSTs without the field keeps working.
  generalCategory: Joi.string().valid('business_associate', 'phone_book').optional(),
  salutation: Joi.string().valid('mr', 'mrs', 'miss', 'smt').allow('', null).optional(),
  firstName: Joi.string().trim().min(1).max(100).pattern(NAME_RE).required()
    .messages({
      'string.pattern.base': nameMsg('First name'),
      'string.empty': 'First name is required',
      'any.required': 'First name is required',
    }),
  middleName: Joi.string().trim().max(100).allow('', null).pattern(NAME_RE).optional()
    .messages({ 'string.pattern.base': nameMsg('Middle name') }),
  surname: Joi.string().trim().max(100).allow('', null).pattern(NAME_RE).optional()
    .messages({ 'string.pattern.base': nameMsg('Surname') }),
  // Business Associates enhancement: two optional text fields
  // (company_name promoted out of address_line2 packing;
  // business_category added by the enhancement request). Backward-
  // compatible — omitted keys simply persist as NULL.
  companyName: optText(255),
  businessCategory: optText(255),
  designation: optText(200),
  // Dependent dropdowns shown after Designation is picked.
  //  - areaWise      → Global `location` master LABEL (matches enquiry
  //                    location's stored-label convention for backward
  //                    compat with pre-existing legacy free-text values).
  //  - propertyWise  → Global `property_type` master CODE (e.g. 'flat').
  areaWise: optText(255),
  propertyWise: optText(64),
  addressLine1: optText(255),
  addressLine2: optText(255),
  cityCode: optText(64),
  talukaCode: optText(64),
  districtCode: optText(64),
  phone1: phoneField,
  phone2: phoneField,
  mobile1: mobileField,
  mobile2: mobileField,
  mobile3: mobileField,
  whatsapp: mobileField,
  email1: emailField,
  email2: emailField,
  website1: urlField,
  website2: urlField,
  // ISO date — the frontend datepicker emits YYYY-MM-DD.
  // Date of birth: shape AND range. It was pattern-only, so a future date
  // such as 2027-10-14 validated. ISO strings compare correctly with <,
  // so no Date parsing is needed. Server-local today, matching the client.
  dateOfBirth: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).allow('', null).optional()
    .custom((value, helpers) => {
      if (!value) return value;
      const d = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const today = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
      if (value > today) return helpers.error('date.future');
      if (value < '1900-01-01') return helpers.error('date.tooOld');
      return value;
    })
    .messages({
      'string.pattern.base': 'Date of birth must be in YYYY-MM-DD format',
      'date.future': 'Date of birth cannot be in the future',
      'date.tooOld': 'Date of birth must be on or after 1900-01-01',
    }),
  // Notes textarea — mirrors the Phone Book column so migrated PB rows
  // keep their existing text and the unified form can capture it.
  notes: Joi.string().trim().max(500).allow('', null).optional(),
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
    mobile1:  mobileField,
    phone1:   phoneField,
    whatsapp: mobileField,
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
