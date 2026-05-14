const express = require('express');
const Joi = require('joi');

const { validate } = require('../../middleware/validate');
const { requireAuth, requireModule } = require('../../middleware/auth');
const leadsService = require('../../services/admin/leads');
const { MODULES } = require('../../constants/modules');

const router = express.Router();

router.use(requireAuth, requireModule(MODULES.LEAD_MANAGEMENT));

const idParam = Joi.object({ id: Joi.number().integer().positive().required() });

const listQuery = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(100).default(10),
  search: Joi.string().trim().max(255).allow('').optional(),
  status: Joi.string().valid('new', 'contacted').optional(),
  actionType: Joi.string().valid('contact_seller', 'view_location', 'general_enquiry').optional(),
  propertyId: Joi.number().integer().positive().optional(),
  propertyCode: Joi.string().trim().max(32).optional(),
  dateFrom: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
  sort: Joi.string().pattern(/^(created_at|status):(asc|desc)$/).default('created_at:desc'),
});

const exportQuery = listQuery.fork(['page', 'pageSize'], (s) => s.optional());

const statusBody = Joi.object({ status: Joi.string().valid('new', 'contacted').required() });
const notesBody = Joi.object({ notes: Joi.string().trim().max(5000).allow('', null) });

router.get('/', validate(listQuery, 'query'), async (req, res, next) => {
  try { res.json(await leadsService.listLeads(req.query)); } catch (e) { next(e); }
});

router.get('/export.csv', validate(exportQuery, 'query'), async (req, res, next) => {
  try {
    const csv = await leadsService.exportCsv(req.query);
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="leads-${stamp}.csv"`);
    res.send(csv);
  } catch (e) { next(e); }
});

router.get('/export.xlsx', validate(exportQuery, 'query'), async (req, res, next) => {
  try {
    const buffer = await leadsService.exportXlsx(req.query);
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="leads-${stamp}.xlsx"`);
    res.send(buffer);
  } catch (e) { next(e); }
});

router.get('/:id', validate(idParam, 'params'), async (req, res, next) => {
  try { res.json(await leadsService.getLead(req.params.id)); } catch (e) { next(e); }
});

router.patch('/:id/status', validate(idParam, 'params'), validate(statusBody), async (req, res, next) => {
  try { res.json(await leadsService.updateStatus(req.params.id, req.body.status)); } catch (e) { next(e); }
});

router.patch('/:id/notes', validate(idParam, 'params'), validate(notesBody), async (req, res, next) => {
  try { res.json(await leadsService.updateNotes(req.params.id, req.body.notes)); } catch (e) { next(e); }
});

router.delete('/:id', validate(idParam, 'params'), async (req, res, next) => {
  try {
    await leadsService.removeLead(req.params.id);
    res.status(204).end();
  } catch (e) { next(e); }
});

module.exports = router;
