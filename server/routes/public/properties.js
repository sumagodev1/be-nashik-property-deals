const express = require('express');
const Joi = require('joi');
const rateLimit = require('express-rate-limit');

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

// -----------------------------------------------------------------------
// T-2026-171: PIN-gated owner-details reveal.
//
// POST /public/properties/:identifier/owner-details { pin: "NNNNNN" }
//
// This is the ONLY public surface that returns owner PII. Nothing else
// under /public/properties/* leaks owner_name, mobile, email etc.
// (verified in services/public/properties.toDetail / toListItem — those
// project only descriptive property columns).
//
// Security layers, in order:
//   1. Joi shape validation: pin is exactly 6 digits.
//   2. Per-IP rate limit (verifyOwnerLimiter): 20 attempts / 5 min —
//      same tightness as /admin/key-pins/verify. Blunts brute-force
//      against the 6-digit key space.
//   3. Service invokes keyPins.verify() — bcrypt-compares against every
//      active Key PIN hash (constant-ish timing) and throws 401
//      INVALID_PIN on miss. THE SAME source of truth that gates admin
//      View/Edit/Delete/Share (see project-admin-action-pin-gate memory).
//   4. If PIN valid, service loads the seller row via a JOIN that
//      re-applies PUBLIC_WHERE — so an unpublished draft cannot leak.
//   5. Response shape drops nullish optional fields so the FE renders
//      only what the seller actually filled in.
//
// Notes:
//   - No requireAuth. Public buyers have no admin session. The PIN is
//     the secondary-factor secret being tested; presence of a valid
//     PIN is the sole authorization signal here.
//   - No audit log write in this ticket (parity with /admin/key-pins/verify
//     which also doesn't log). Follow-up ticket can add an owner-view
//     audit trail if the client wants it.
//   - FE client interceptor (src/shared/api/client.js) short-circuits
//     the 401 on this URL so a wrong PIN doesn't wipe the buyer's
//     session (there is none) or trigger an /auth/refresh loop.
// -----------------------------------------------------------------------
const verifyOwnerLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many PIN attempts. Please wait a few minutes and try again.',
    },
  },
});

const ownerDetailsBody = Joi.object({
  pin: Joi.string().pattern(/^[0-9]{6}$/, '6-digit-numeric').required().messages({
    'string.pattern.name': 'PIN must be exactly 6 numeric digits.',
    'string.empty': 'PIN is required.',
    'any.required': 'PIN is required.',
  }),
});

router.post(
  '/:identifier/owner-details',
  verifyOwnerLimiter,
  validate(idParam, 'params'),
  validate(ownerDetailsBody),
  async (req, res, next) => {
    try {
      res.json(await service.revealOwnerDetails(req.params.identifier, req.body));
    } catch (e) {
      next(e);
    }
  },
);

module.exports = router;
