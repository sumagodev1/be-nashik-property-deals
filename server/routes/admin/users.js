const express = require('express');
const Joi = require('joi');

const { validate } = require('../../middleware/validate');
const { requireAuth, requireModule, requireModuleWriteOnMutation } = require('../../middleware/auth');
const { documentUploadMiddleware } = require('../../middleware/imageMulter');
const { HttpError } = require('../../middleware/errors');
const documentUpload = require('../../services/files/documentUpload');
const users = require('../../services/admin/users');
const { MODULES } = require('../../constants/modules');

const router = express.Router();

router.use(requireAuth, requireModule(MODULES.USER_MANAGEMENT));
// T-2026-173 Phase 2: sub-admins with only Read access get 403 on mutation.
router.use(requireModuleWriteOnMutation(MODULES.USER_MANAGEMENT));

const idParam = Joi.object({ id: Joi.number().integer().positive().required() });

const LETTERS_ONLY = /^[A-Za-z\s]+$/;
const emailField = Joi.string().email({ tlds: { allow: false } }).max(255);
// Indian mobile numbers always begin 6, 7, 8 or 9. This was /^\d{10}$/ - any
// ten digits - which also disagreed with the rule the seller's OWN profile
// enforces (routes/seller/profile.js), so an admin could save an alternate
// contact that the seller was then blocked from keeping on their next save.
//
// Used only by `alternateContact` below. No stored value fails the tighter
// pattern, so no existing seller becomes unsaveable.
const phoneField = Joi.string().pattern(/^[6-9]\d{9}$/)
  .messages({
    'string.base': 'Enter a valid 10-digit mobile number starting with 6-9',
    'string.pattern.base': 'Enter a valid 10-digit mobile number starting with 6-9',
  });
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
    .default('full_name:asc'),
})
  // The two dates were validated only for shape, never against each other, so
  // dateFrom=2026-08-08&dateTo=2026-08-05 was accepted and returned an empty
  // list - indistinguishable from "no sellers registered in that window".
  // Both are ISO yyyy-mm-dd here, so a string compare is a date compare.
  .custom((value, helpers) => {
    if (value.dateFrom && value.dateTo && value.dateFrom > value.dateTo) {
      return helpers.error('any.invalid');
    }
    return value;
  })
  .messages({ 'any.invalid': '"To date" cannot be earlier than "From date".' });

const sellersExportQuery = sellersListQuery.fork(['page', 'pageSize'], (s) => s.optional());

const sellerUpdateBody = Joi.object({
  fullName: nameField.required(),
  // Email is optional now — admins can leave it blank when editing a seller
  // that registered without one. Format is still validated when provided.
  email: emailField.optional().allow('', null),
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
    const doc = await documentUpload.findSellerDocumentById(req.params.fileId);
    if (!doc || Number(doc.seller_id) !== Number(req.params.id)) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Document not found' } });
    }
    return documentUpload.streamSellerDocument(res, doc);
  } catch (e) { next(e); }
});

// Admin upload — attach a business document to a seller. Used by the
// admin panel's seller-edit screen so support staff can add docs on behalf
// of agents who can't (or won't) upload from their own profile.
router.post(
  '/sellers/:id/documents',
  validate(idParam, 'params'),
  documentUploadMiddleware,
  async (req, res, next) => {
    try {
      if (!req.files || req.files.length === 0) {
        throw new HttpError(400, 'NO_FILES', 'No files uploaded');
      }
      const sellerId = Number(req.params.id);
      await documentUpload.persistSellerDocuments({ sellerId, files: req.files });
      const documents = await documentUpload.listSellerDocuments(sellerId);
      res.status(201).json({ documents });
    } catch (e) { next(e); }
  },
);

// Admin delete — remove a seller's business document. Same ownership
// check as the GET endpoint above (file must actually belong to that
// seller) so admins can't accidentally delete cross-seller documents by
// guessing IDs.
router.delete('/sellers/:id/documents/:fileId', validate(docParam, 'params'), async (req, res, next) => {
  try {
    const doc = await documentUpload.findSellerDocumentById(req.params.fileId);
    if (!doc || Number(doc.seller_id) !== Number(req.params.id)) {
      throw new HttpError(404, 'NOT_FOUND', 'Document not found');
    }
    await documentUpload.deleteSellerDocument(req.params.fileId);
    const documents = await documentUpload.listSellerDocuments(req.params.id);
    res.json({ documents });
  } catch (e) { next(e); }
});

// Buyers (aggregated from leads) -------------------------------------
router.get('/buyers', validate(buyersListQuery, 'query'), async (req, res, next) => {
  try { res.json(await users.listBuyers(req.query)); } catch (e) { next(e); }
});

module.exports = router;
