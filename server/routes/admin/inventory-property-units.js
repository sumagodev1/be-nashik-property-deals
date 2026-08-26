// ============================================================
// /api/admin/inventory-properties/:masterId/units — Builder unit CRUD
// (T-2026-137)
// ============================================================
// This router is MOUNTED INSIDE inventory-properties.js at
//   router.use('/:masterId/units', require('./inventory-property-units'))
//
// That mount inherits the parent router's auth chain
// (requireAuth + requireModule(INVENTORY_PROPERTIES)) so we do NOT
// re-apply it here. mergeParams:true lets us read :masterId which was
// captured by the parent mount path. (T-2026-174 renamed the parent
// gate from the umbrella INVENTORY_MANAGEMENT to the discrete
// INVENTORY_PROPERTIES key; the inheritance behaviour is unchanged.)
//
// ROUTE SURFACE (per T-2026-136 spec section 15):
//   GET    /                → list units + status counts for one master
//   POST   /                → add unit (409 UNIT_NO_TAKEN on duplicate)
//   GET    /:unitId         → view one unit
//   PATCH  /:unitId         → update editable fields (unit_no / status / details)
//   PATCH  /:unitId/status  → single-field status flip (dashboard fast-path)
//   DELETE /:unitId         → hard-delete one unit
//
// VALIDATION:
//   Payload shape validated by Joi.  The `details` blob accepts any
//   object shape (`.unknown(true)`) — same design as the master
//   property's `details` field. Per project non-negotiable "reuse
//   existing Joi via .unknown(true) — do not create a parallel
//   validator stack". Deep validation of unit-level dynamicData rules
//   remains on the FE (unit form config is the single source of truth).
//
// PUBLIC EXCLUSION:
//   The parent router already enforces requireModule(INVENTORY_PROPERTIES)
//   which admin + module-permitted sub-admins have. Public / seller /
//   buyer surfaces have no path to this router.
// ============================================================

const express = require('express');
const Joi = require('joi');

const { validate } = require('../../middleware/validate');
const { HttpError } = require('../../middleware/errors');
const idempotency = require('../../middleware/idempotency');
const units = require('../../services/inventory/units');
const { validateCommunicationNumbers } = require('../../services/inventory/dynamicDataValidation');
// T-2026-146: Builder Property Unit Status is now master-driven
// (master_lookups.master_key='builder_status'). We validate the code
// against the master at write time rather than a hardcoded enum so
// admin-added codes work end-to-end with zero FE code change and
// deactivated codes are rejected for new/updated units.
const mastersService = require('../../services/masters/management');

const router = express.Router({ mergeParams: true });

// masterId lives in req.params (captured by the parent mount path).
const masterIdParam = Joi.object({
  masterId: Joi.number().integer().positive().required(),
}).unknown(true);
const masterAndUnitIdParam = Joi.object({
  masterId: Joi.number().integer().positive().required(),
  unitId: Joi.number().integer().positive().required(),
}).unknown(true);

// T-2026-146: status is validated at the JOI layer only for SHAPE (it must
// be a non-empty string matching the master code pattern). The FRESHNESS
// check (is the code registered + active in master_lookups?) runs in the
// handler via mastersService.assertActiveCode('builder_status', code). This
// two-step design mirrors the pattern already used for status_type /
// enquiry_status / property_type — the Joi validator can't reach the DB.
const STATUS_CODE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}[a-z0-9]$/;

// Unit body (create + update share the shape; update ignores unset keys).
// - unit_no: 1..64 chars trimmed (matches DB VARCHAR(64) + spec section 9
//   "Flat No." field).
// - status:  master code (shape-checked here, active-checked in handler).
//            Defaults to 'available' on create — this is a permanently
//            seeded row (migration 100) so the assertActiveCode call
//            below always resolves for that default.
// - details: pass-through object bag (`.unknown(true)`), max 200 keys
//   (matches the ceiling used on the master body).
const unitBody = Joi.object({
  unitNo: Joi.string().trim().min(1).max(64).required().messages({
    'any.required':  'Unit No. is required.',
    'string.empty':  'Unit No. is required.',
    'string.max':    'Unit No. must be 64 characters or fewer.',
  }),
  status: Joi.string().trim().pattern(STATUS_CODE_PATTERN).default('available').messages({
    'string.pattern.base': 'Status code has an invalid shape.',
  }),
  details: Joi.object().unknown(true).max(200).default({}),
}).unknown(true);

// Update body: same shape, but unitNo optional (an update that keeps the
// same Unit No. shouldn't need to re-send it). Every field optional.
const unitUpdateBody = Joi.object({
  unitNo: Joi.string().trim().min(1).max(64).optional().messages({
    'string.empty':  'Unit No. is required.',
    'string.max':    'Unit No. must be 64 characters or fewer.',
  }),
  status: Joi.string().trim().pattern(STATUS_CODE_PATTERN).optional().messages({
    'string.pattern.base': 'Status code has an invalid shape.',
  }),
  details: Joi.object().unknown(true).max(200).optional(),
}).unknown(true);

function validateUnitCommunicationNumbers(req, res, next) {
  const errors = validateCommunicationNumbers(req.body?.details, 'details');
  if (errors.length === 0) return next();
  return next(new HttpError(
    400,
    'VALIDATION_ERROR',
    errors.map((entry) => entry.message).join('; '),
    errors,
  ));
}

// Dashboard fast-path — status flip only.
const statusBody = Joi.object({
  status: Joi.string().trim().pattern(STATUS_CODE_PATTERN).required().messages({
    'any.required':        'Status is required.',
    'string.pattern.base': 'Status code has an invalid shape.',
  }),
});

router.get('/', validate(masterIdParam, 'params'), async (req, res, next) => {
  try {
    res.json(await units.list(Number(req.params.masterId)));
  } catch (err) { next(err); }
});

router.post('/', idempotency(), validate(masterIdParam, 'params'), validate(unitBody, 'body'), validateUnitCommunicationNumbers,
  async (req, res, next) => {
    try {
      // T-2026-146: reject unknown/inactive builder_status codes at write
      // time. `assertActiveCode` is a no-op when status is undefined/empty;
      // when set, it throws 400 INVALID_MASTER_CODE with a friendly message
      // if the code isn't a currently active master_lookups row under
      // master_key='builder_status'. Historical unit rows keep their code
      // as-is even after the master row is later deactivated (read path
      // doesn't call assertActiveCode) — only new writes are guarded.
      await mastersService.assertActiveCode('builder_status', req.body.status);
      const created = await units.create(Number(req.params.masterId), req.body);
      res.status(201).json(created);
    } catch (err) { next(err); }
  });

router.get('/:unitId', validate(masterAndUnitIdParam, 'params'), async (req, res, next) => {
  try {
    res.json(await units.getOne(Number(req.params.masterId), Number(req.params.unitId)));
  } catch (err) { next(err); }
});

router.patch('/:unitId', validate(masterAndUnitIdParam, 'params'), validate(unitUpdateBody, 'body'), validateUnitCommunicationNumbers,
  async (req, res, next) => {
    try {
      // T-2026-146: only guard status if the update payload actually
      // includes it. Passing `undefined` (field omitted) is a no-op inside
      // assertActiveCode — the guard silently returns for absent codes.
      await mastersService.assertActiveCode('builder_status', req.body.status);
      res.json(await units.update(
        Number(req.params.masterId),
        Number(req.params.unitId),
        req.body,
      ));
    } catch (err) { next(err); }
  });

router.patch('/:unitId/status', idempotency(),
  validate(masterAndUnitIdParam, 'params'), validate(statusBody, 'body'),
  async (req, res, next) => {
    try {
      // T-2026-146: status body always includes `status` (required Joi
      // field) so assertActiveCode always resolves against a real code.
      // Rejects with 400 INVALID_MASTER_CODE when the code is unknown or
      // inactive — the FE fast-path (pill click) should show that
      // error inline; the pills themselves are pre-filtered to active
      // codes only (see useBuilderStatuses hook) so this is a defence-
      // in-depth check for stale FE state.
      await mastersService.assertActiveCode('builder_status', req.body.status);
      res.json(await units.changeStatus(
        Number(req.params.masterId),
        Number(req.params.unitId),
        req.body.status,
      ));
    } catch (err) { next(err); }
  });

router.delete('/:unitId', validate(masterAndUnitIdParam, 'params'), async (req, res, next) => {
  try {
    await units.remove(Number(req.params.masterId), Number(req.params.unitId));
    res.status(204).end();
  } catch (err) { next(err); }
});

module.exports = router;
