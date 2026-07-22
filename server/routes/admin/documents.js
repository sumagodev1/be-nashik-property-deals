/**
 * REST API for the Document Directory admin module.
 *
 *   POST   /                  create (multipart, field "file" + metadata)
 *   GET    /                  paginated list with search / sort
 *   GET    /:id               single record
 *   PUT    /:id               update metadata (name / description / category / tags / status)
 *   DELETE /:id               soft-delete record + unlink file
 *   GET    /:id/view          stream file inline (browser preview if possible)
 *   GET    /:id/download      stream file as attachment (original filename)
 *   POST   /:id/share         email the document to a recipient (runtime-only)
 *
 * All routes are guarded by requireAuth + requireModule(DOCUMENT_DIRECTORY).
 * File access is only via the two streaming endpoints — the raw storage
 * path is never exposed.
 */

const express = require('express');
const Joi = require('joi');

const { validate } = require('../../middleware/validate');
const { requireAuth, requireModule } = require('../../middleware/auth');
const { documentDirectoryUpload } = require('../../middleware/documentDirectoryUpload');
const service = require('../../services/admin/documents');
const { MODULES } = require('../../constants/modules');

const router = express.Router();

router.use(requireAuth, requireModule(MODULES.DOCUMENT_DIRECTORY));

const idParam = Joi.object({ id: Joi.number().integer().positive().required() });

const listQuery = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(100).default(10),
  search: Joi.string().trim().max(255).allow('').optional(),
  sortBy: Joi.string().valid(
    'document_id',
    'document_name',
    'original_filename',
    'extension',
    'file_size',
    'created_at',
    'status',
  ).default('created_at'),
  sortDir: Joi.string().valid('asc', 'desc').default('desc'),
});

// Metadata schema for the multipart create route. Multer strips the file
// into req.file, so the remaining text fields land in req.body as strings.
// No frontend size validation and no extension allowlist — the spec is
// explicit that any file type should be accepted.
const createBody = Joi.object({
  documentName: Joi.string().trim().min(1).max(255).required(),
  description: Joi.string().trim().max(10000).allow('', null).optional(),
  category: Joi.string().trim().max(100).allow('', null).optional(),
  tags: Joi.string().trim().max(500).allow('', null).optional(),
});

const updateBody = Joi.object({
  documentName: Joi.string().trim().min(1).max(255).optional(),
  description: Joi.string().trim().max(10000).allow('', null).optional(),
  category: Joi.string().trim().max(100).allow('', null).optional(),
  tags: Joi.string().trim().max(500).allow('', null).optional(),
  status: Joi.string().valid('active', 'archived').optional(),
});

const shareBody = Joi.object({
  recipientEmail: Joi.string().email({ tlds: false }).required(),
  subject: Joi.string().trim().max(255).allow('', null).optional(),
  message: Joi.string().trim().max(5000).allow('', null).optional(),
});

router.get('/', validate(listQuery, 'query'), async (req, res, next) => {
  try {
    res.json(await service.list(req.query));
  } catch (e) { next(e); }
});

router.get('/:id', validate(idParam, 'params'), async (req, res, next) => {
  try {
    res.json(await service.getOne(req.params.id));
  } catch (e) { next(e); }
});

router.post(
  '/',
  documentDirectoryUpload,
  validate(createBody, 'body'),
  async (req, res, next) => {
    try {
      const adminId = req.auth?.role === 'admin' ? Number(req.auth.sub) : Number(req.auth?.sub) || null;
      const dto = await service.upload({
        file: req.file,
        meta: req.body,
        uploadedBy: adminId,
      });
      res.status(201).json({
        message: 'Document uploaded successfully.',
        data: dto,
      });
    } catch (e) { next(e); }
  },
);

router.put(
  '/:id',
  validate(idParam, 'params'),
  validate(updateBody, 'body'),
  async (req, res, next) => {
    try {
      const dto = await service.updateMetadata(req.params.id, req.body);
      res.json({ message: 'Document updated successfully.', data: dto });
    } catch (e) { next(e); }
  },
);

router.delete('/:id', validate(idParam, 'params'), async (req, res, next) => {
  try {
    await service.remove(req.params.id);
    res.json({ message: 'Document deleted successfully.' });
  } catch (e) { next(e); }
});

router.get('/:id/view', validate(idParam, 'params'), async (req, res, next) => {
  try {
    await service.streamDocument(req.params.id, res, { disposition: 'inline' });
  } catch (e) { next(e); }
});

router.get('/:id/download', validate(idParam, 'params'), async (req, res, next) => {
  try {
    await service.streamDocument(req.params.id, res, { disposition: 'attachment' });
  } catch (e) { next(e); }
});

router.post(
  '/:id/share',
  validate(idParam, 'params'),
  validate(shareBody, 'body'),
  async (req, res, next) => {
    try {
      await service.shareByEmail(req.params.id, req.body);
      res.json({ message: 'Document shared successfully.' });
    } catch (e) { next(e); }
  },
);

module.exports = router;
