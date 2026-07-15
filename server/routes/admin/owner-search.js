/**
 * Route: GET /api/admin/owner-search
 *
 * Cross-module owner-duplicate search used by the Inventory / Enquiry /
 * Business Associate forms to surface live "already exists" suggestions.
 *
 * Query params:
 *   q       (required)  — search fragment. Min 2 chars — the frontend
 *                         hook already refuses shorter inputs, but we
 *                         guard here too.
 *   sources (optional)  — comma-separated subset of
 *                         'inventory', 'enquiry', 'ba' (aka 'business_associate').
 *                         Defaults to all three.
 *   limit   (optional)  — max suggestions returned (default 15, capped 50).
 *   field   (optional)  — 'phone' | 'name'. Accepted for backward compat with
 *                         the earlier stub contract in the frontend
 *                         (shared/api/owners.js). Currently informational
 *                         only — the service always matches every field.
 *
 * Auth: requires a valid admin OR sub_admin token. We do NOT gate on any
 * single MODULE — a sub_admin who can create either Inventory or Enquiry
 * properties genuinely needs to see duplicates across all three data sets
 * (otherwise a Business Associate contact wouldn't surface for an Enquiry
 * form filler with only INVENTORY_MANAGEMENT access).
 */

const express = require('express');
const Joi = require('joi');

const { validate } = require('../../middleware/validate');
const { requireAuth } = require('../../middleware/auth');
const { HttpError } = require('../../middleware/errors');
const service = require('../../services/admin/owner_search');

const router = express.Router();

router.use(requireAuth);

const querySchema = Joi.object({
  q: Joi.string().trim().min(2).max(120).required(),
  sources: Joi.string().trim().max(120).allow('').optional(),
  limit: Joi.number().integer().min(1).max(50).default(15),
  // Kept for backward compat with the pre-existing frontend stub. Not
  // otherwise consumed — see comment above.
  field: Joi.string().valid('phone', 'name').optional(),
});

function parseSources(raw) {
  if (!raw) return ['inventory', 'enquiry', 'ba'];
  const set = new Set(
    raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  );
  const out = [];
  if (set.has('inventory')) out.push('inventory');
  if (set.has('enquiry')) out.push('enquiry');
  if (set.has('ba') || set.has('business_associate')) out.push('ba');
  // Empty parse → treat as "all" so a malformed param never returns nothing.
  return out.length > 0 ? out : ['inventory', 'enquiry', 'ba'];
}

router.get('/', validate(querySchema, 'query'), async (req, res, next) => {
  try {
    const role = req.auth?.role;
    if (role !== 'admin' && role !== 'sub_admin') {
      return next(new HttpError(403, 'FORBIDDEN', 'Owner search requires an admin session.'));
    }
    const sources = parseSources(req.query.sources);
    const result = await service.search(req.query.q, sources, req.query.limit);
    res.json(result);
  } catch (e) { next(e); }
});

module.exports = router;
