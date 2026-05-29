const express = require('express');
const Joi = require('joi');

const { validate } = require('../../middleware/validate');
const { requireAuth, requireRole } = require('../../middleware/auth');
const service = require('../../services/admin/dashboard');

const router = express.Router();

// Dashboard is the admin landing page — any authenticated admin or sub-admin
// can load it. Per-module gating happens at the link level in the frontend.
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

module.exports = router;
