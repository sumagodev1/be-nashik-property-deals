const express = require('express');
const Joi = require('joi');

const { validate } = require('../../middleware/validate');
const { requireAuth, requireModule } = require('../../middleware/auth');
const users = require('../../services/admin/users');
const { MODULES } = require('../../constants/modules');

const router = express.Router();

router.use(requireAuth, requireModule(MODULES.USER_MANAGEMENT));

const idParam = Joi.object({ id: Joi.number().integer().positive().required() });

const LETTERS_ONLY = /^[A-Za-z\s]+$/;
const emailField = Joi.string().email({ tlds: { allow: false } }).max(255);
const phoneField = Joi.string().trim().pattern(/^\d{10}$/)
  .messages({ 'string.pattern.base': 'Enter a valid 10-digit mobile number' });
const nameField = Joi.string().trim().min(3).max(50).pattern(LETTERS_ONLY)
  .messages({ 'string.pattern.base': 'Name can only contain letters and spaces' });

const sellersListQuery = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(100).default(10),
  search: Joi.string().trim().max(255).allow('').optional(),
  userType: Joi.string().valid('owner', 'agent').optional(),
  isActive: Joi.boolean().optional(),
  isVerified: Joi.boolean().optional(),
  dateFrom: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
  sort: Joi.string()
    .valid('created_at:desc', 'created_at:asc', 'full_name:asc', 'full_name:desc', 'listing_count:desc')
    .default('created_at:desc'),
});

const sellersExportQuery = sellersListQuery.fork(['page', 'pageSize'], (s) => s.optional());

const sellerUpdateBody = Joi.object({
  fullName: nameField.required(),
  email: emailField.required(),
  alternateContact: phoneField.optional().allow('', null),
  agencyName: Joi.string().trim().max(255).optional().allow('', null),
  businessAddress: Joi.string().trim().max(1000).optional().allow('', null),
  area: Joi.string().trim().max(255).optional().allow('', null),
});

const activeBody = Joi.object({ isActive: Joi.boolean().required() });

const buyersListQuery = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(100).default(10),
  search: Joi.string().trim().max(255).allow('').optional(),
  dateFrom: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
  sort: Joi.string()
    .valid('last_seen_at:desc', 'last_seen_at:asc', 'lead_count:desc', 'name:asc')
    .default('last_seen_at:desc'),
});

// Sellers ------------------------------------------------------------
router.get('/sellers', validate(sellersListQuery, 'query'), async (req, res, next) => {
  try { res.json(await users.listSellers(req.query)); } catch (e) { next(e); }
});

router.get('/sellers/export.csv', validate(sellersExportQuery, 'query'), async (req, res, next) => {
  try {
    const csv = await users.exportSellersCsv(req.query);
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="sellers-${stamp}.csv"`);
    res.send(csv);
  } catch (e) { next(e); }
});

router.get('/sellers/export.xlsx', validate(sellersExportQuery, 'query'), async (req, res, next) => {
  try {
    const buffer = await users.exportSellersXlsx(req.query);
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="sellers-${stamp}.xlsx"`);
    res.send(buffer);
  } catch (e) { next(e); }
});

router.get('/sellers/export.pdf', validate(sellersExportQuery, 'query'), async (req, res, next) => {
  try {
    const buffer = await users.exportSellersPdf(req.query);
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="sellers-${stamp}.pdf"`);
    res.send(buffer);
  } catch (e) { next(e); }
});

router.get('/sellers/:id', validate(idParam, 'params'), async (req, res, next) => {
  try { res.json(await users.getSeller(req.params.id)); } catch (e) { next(e); }
});

router.put('/sellers/:id', validate(idParam, 'params'), validate(sellerUpdateBody), async (req, res, next) => {
  try { res.json(await users.updateSeller(req.params.id, req.body)); } catch (e) { next(e); }
});

router.patch('/sellers/:id/active', validate(idParam, 'params'), validate(activeBody), async (req, res, next) => {
  try { res.json(await users.setSellerActive(req.params.id, req.body.isActive)); } catch (e) { next(e); }
});

router.delete('/sellers/:id', validate(idParam, 'params'), async (req, res, next) => {
  try {
    await users.removeSeller(req.params.id);
    res.status(204).end();
  } catch (e) { next(e); }
});

// Stream a seller's uploaded business document. Admin-gated by router.use.
const docParam = Joi.object({
  id: Joi.number().integer().positive().required(),
  fileId: Joi.number().integer().positive().required(),
});
router.get('/sellers/:id/documents/:fileId', validate(docParam, 'params'), async (req, res, next) => {
  try {
    const documentUpload = require('../../services/files/documentUpload');
    const doc = await documentUpload.findSellerDocumentById(req.params.fileId);
    if (!doc || Number(doc.seller_id) !== Number(req.params.id)) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Document not found' } });
    }
    return documentUpload.streamSellerDocument(res, doc);
  } catch (e) { next(e); }
});

// Buyers (aggregated from leads) -------------------------------------
router.get('/buyers', validate(buyersListQuery, 'query'), async (req, res, next) => {
  try { res.json(await users.listBuyers(req.query)); } catch (e) { next(e); }
});

module.exports = router;
