const express = require('express');
const Joi = require('joi');

const { validate } = require('../../middleware/validate');
const {
  requireAuth,
  requireRole,
  requireModule,
} = require('../../middleware/auth');
const { MODULES } = require('../../constants/modules');
const service = require('../../services/admin/dashboard');

const router = express.Router();

// Dashboard is the admin landing page — any authenticated admin or sub-admin
// can load the base router. The generic /kpi + /charts endpoints below are
// gated only by role because they are aggregates the DashboardIndex uses
// to decide which sub-dashboard to redirect to. Per-surface endpoints
// (/inventory/*, /enquiry/*, /website/*) are gated at the endpoint level
// by their respective module keys.
router.use(requireAuth, requireRole('admin', 'sub_admin'));

const chartsQuery = Joi.object({
  days: Joi.number().integer().min(7).max(180).default(30),
  granularity: Joi.string().valid('daily', 'weekly', 'monthly', 'custom').default('daily'),
  // dateFrom + dateTo become required when granularity=custom; otherwise optional.
  dateFrom: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/)
    .when('granularity', { is: 'custom', then: Joi.required(), otherwise: Joi.optional() }),
  dateTo: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/)
    .when('granularity', { is: 'custom', then: Joi.required(), otherwise: Joi.optional() }),
}).custom((value, helpers) => {
  // Cross-field guard: dateFrom must not be after dateTo on custom ranges.
  // ISO YYYY-MM-DD sorts lexicographically, so a string compare is safe.
  if (value.granularity === 'custom' && value.dateFrom && value.dateTo && value.dateFrom > value.dateTo) {
    return helpers.error('any.invalid', { message: 'dateFrom cannot be after dateTo' });
  }
  return value;
}, 'date range order').messages({
  'any.invalid': 'dateFrom cannot be after dateTo',
});

router.get('/kpi', async (req, res, next) => {
  try { res.json(await service.kpi()); } catch (e) { next(e); }
});

router.get('/charts', validate(chartsQuery, 'query'), async (req, res, next) => {
  try { res.json(await service.charts(req.query)); } catch (e) { next(e); }
});

/* ──────────────────────────────────────────────────────────────────
 * Per-surface endpoints — the split dashboards call ONLY the endpoint
 * for their surface. Payloads never mix data from the other table.
 * ────────────────────────────────────────────────────────────────── */

// T-2026-174: per-surface dashboards are now gated by their own discrete
// module keys. Sub-admins must be granted the specific dashboard module
// (INVENTORY_DASHBOARD / ENQUIRY_DASHBOARD / WEBSITE_PROPERTY_MANAGEMENT)
// to load its data. Read-level suffices (the dashboards are read-only in
// practice; no mutating verbs live here). Administrator role bypasses via
// requireModule's role==='admin' short-circuit. Legacy sub-admins with
// only the pre-T-174 INVENTORY_MANAGEMENT grant still pass via
// hasGrant's LEGACY_UMBRELLA_ALIASES rule.

router.get(
  '/website/kpi',
  requireModule(MODULES.WEBSITE_PROPERTY_MANAGEMENT),
  async (req, res, next) => {
    try { res.json(await service.websiteKpi()); } catch (e) { next(e); }
  },
);

router.get(
  '/website/charts',
  requireModule(MODULES.WEBSITE_PROPERTY_MANAGEMENT),
  validate(chartsQuery, 'query'),
  async (req, res, next) => {
    try { res.json(await service.websiteCharts(req.query)); } catch (e) { next(e); }
  },
);

router.get(
  '/inventory/kpi',
  requireModule(MODULES.INVENTORY_DASHBOARD),
  async (req, res, next) => {
    try { res.json(await service.inventoryKpi()); } catch (e) { next(e); }
  },
);

router.get(
  '/inventory/charts',
  requireModule(MODULES.INVENTORY_DASHBOARD),
  validate(chartsQuery, 'query'),
  async (req, res, next) => {
    try { res.json(await service.inventoryCharts(req.query)); } catch (e) { next(e); }
  },
);

router.get(
  '/enquiry/kpi',
  requireModule(MODULES.ENQUIRY_DASHBOARD),
  async (req, res, next) => {
    try { res.json(await service.enquiryKpi()); } catch (e) { next(e); }
  },
);

router.get(
  '/enquiry/charts',
  requireModule(MODULES.ENQUIRY_DASHBOARD),
  validate(chartsQuery, 'query'),
  async (req, res, next) => {
    try { res.json(await service.enquiryCharts(req.query)); } catch (e) { next(e); }
  },
);

module.exports = router;
