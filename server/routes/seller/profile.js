const express = require('express');
const Joi = require('joi');

const { validate } = require('../../middleware/validate');
const { requireAuth, requireRole } = require('../../middleware/auth');
const { documentUploadMiddleware } = require('../../middleware/imageMulter');
const sellers = require('../../db/queries/sellers');
const documentUpload = require('../../services/files/documentUpload');
const { HttpError } = require('../../middleware/errors');

const router = express.Router();

router.use(requireAuth, requireRole('seller'));

const emailField = Joi.string().email({ tlds: { allow: false } }).max(255);
const phoneField = Joi.string().trim().pattern(/^[+\-0-9 ()]{6,20}$/);
const nameField = Joi.string().trim().min(1).max(255);

// Mobile is non-editable on Owner profiles and restricted on Agent profiles.
// Both are forbidden from the body — mobile changes go through a dedicated
// (future) flow with OTP, not via the profile-update endpoint.
const updateBody = Joi.object({
  fullName: nameField.required(),
  // Email is optional now (OTP moved to mobile). Empty string normalizes to null.
  email: emailField.optional().allow('', null),
  alternateContact: phoneField.optional().allow('', null),
  agencyName: Joi.string().trim().max(255).optional().allow('', null),
  businessAddress: Joi.string().trim().max(1000).optional().allow('', null),
  area: Joi.string().trim().max(255).optional().allow('', null),
});

const idParam = Joi.object({ id: Joi.number().integer().positive().required() });

router.get('/', async (req, res, next) => {
  try {
    const sellerId = Number(req.auth.sub);
    const seller = await sellers.findById(sellerId);
    if (!seller) throw new HttpError(404, 'NOT_FOUND', 'Profile not found');
    const documents = await documentUpload.listSellerDocuments(sellerId);
    res.json(toProfile(seller, documents));
  } catch (e) { next(e); }
});

router.put('/', validate(updateBody), async (req, res, next) => {
  try {
    const id = Number(req.auth.sub);
    const seller = await sellers.findById(id);
    if (!seller) throw new HttpError(404, 'NOT_FOUND', 'Profile not found');

    // Owners cannot set agency_name or business_address (server enforces).
    const isOwner = seller.user_type === 'owner';
    const normalizedEmail =
      typeof req.body.email === 'string' && req.body.email.trim()
        ? req.body.email.trim()
        : null;
    const payload = {
      fullName: req.body.fullName,
      email: normalizedEmail,
      alternateContact: req.body.alternateContact,
      agencyName: isOwner ? null : req.body.agencyName,
      businessAddress: isOwner ? null : req.body.businessAddress,
      area: req.body.area,
    };

    if (payload.email && payload.email !== seller.email) {
      const existing = await sellers.findByEmail(payload.email);
      if (existing && existing.id !== seller.id) {
        throw new HttpError(409, 'EMAIL_TAKEN', 'This email is already linked to another account.');
      }
    }

    await sellers.updateProfile(id, payload);
    const fresh = await sellers.findById(id);
    const documents = await documentUpload.listSellerDocuments(id);
    res.json(toProfile(fresh, documents));
  } catch (e) { next(e); }
});

// Agents (and owners, who'd ignore them) can upload business documents.
router.post('/documents', documentUploadMiddleware, async (req, res, next) => {
  try {
    if (!req.files || req.files.length === 0) throw new HttpError(400, 'NO_FILES', 'No files uploaded');
    const sellerId = Number(req.auth.sub);
    await documentUpload.persistSellerDocuments({ sellerId, files: req.files });
    const documents = await documentUpload.listSellerDocuments(sellerId);
    res.status(201).json({ documents });
  } catch (e) { next(e); }
});

router.delete('/documents/:id', validate(idParam, 'params'), async (req, res, next) => {
  try {
    const sellerId = Number(req.auth.sub);
    const doc = await documentUpload.findSellerDocumentById(req.params.id);
    if (!doc || Number(doc.seller_id) !== sellerId) {
      throw new HttpError(404, 'NOT_FOUND', 'Document not found');
    }
    await documentUpload.deleteSellerDocument(req.params.id);
    const documents = await documentUpload.listSellerDocuments(sellerId);
    res.json({ documents });
  } catch (e) { next(e); }
});

router.get('/documents/:id', validate(idParam, 'params'), async (req, res, next) => {
  try {
    const sellerId = Number(req.auth.sub);
    const doc = await documentUpload.findSellerDocumentById(req.params.id);
    if (!doc || Number(doc.seller_id) !== sellerId) {
      throw new HttpError(404, 'NOT_FOUND', 'Document not found');
    }
    return documentUpload.streamSellerDocument(res, doc);
  } catch (e) { next(e); }
});

function toProfile(seller, documents = []) {
  return {
    id: seller.id,
    userType: seller.user_type,
    fullName: seller.full_name,
    mobile: seller.mobile_number, // read-only on this endpoint
    email: seller.email,
    alternateContact: seller.alternate_contact,
    agencyName: seller.agency_name,
    businessAddress: seller.business_address,
    area: seller.area,
    isActive: Boolean(seller.is_active),
    isVerified: Boolean(seller.is_verified),
    createdAt: seller.created_at,
    updatedAt: seller.updated_at,
    documents: documents.map((d) => ({
      id: d.id,
      originalName: d.original_name,
      mimeType: d.mime_type,
      sizeBytes: Number(d.size_bytes),
      downloadPath: `/seller/profile/documents/${d.id}`,
      createdAt: d.created_at,
    })),
  };
}

module.exports = router;
