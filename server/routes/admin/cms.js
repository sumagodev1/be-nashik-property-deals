const express = require('express');
const Joi = require('joi');

const { validate } = require('../../middleware/validate');
const { requireAuth, requireModule } = require('../../middleware/auth');
const { imageUploadMiddleware } = require('../../middleware/imageMulter');
const cms = require('../../services/admin/cms');
const { MODULES } = require('../../constants/modules');
const { CMS_SETTING_KEYS, KEY_LABELS } = require('../../constants/cms');
const { HttpError } = require('../../middleware/errors');

const router = express.Router();

router.use(requireAuth, requireModule(MODULES.CMS_MANAGEMENT));

const idParam = Joi.object({ id: Joi.number().integer().positive().required() });

const bannerUpdateBody = Joi.object({
  altText: Joi.string().trim().max(255).allow('', null),
  caption: Joi.string().trim().max(255).allow('', null),
  subcaption: Joi.string().trim().max(500).allow('', null),
  sortOrder: Joi.number().integer().min(0).max(9999),
  isActive: Joi.boolean(),
}).min(1);

// Settings: only allowlisted keys can be written. Values are arbitrary text
// (URLs, phone numbers, addresses, and longer free-form copy for about/contact).
// 10k cap is generous — the underlying column is MEDIUMTEXT.
const settingsBody = Joi.object().pattern(
  Joi.string().valid(...CMS_SETTING_KEYS),
  Joi.string().trim().max(10000).allow('', null),
).min(1);

// Banners --------------------------------------------------------------------

router.get('/banners', async (req, res, next) => {
  try { res.json({ data: await cms.listBanners() }); } catch (e) { next(e); }
});

router.get('/banners/:id', validate(idParam, 'params'), async (req, res, next) => {
  try { res.json(await cms.getBanner(req.params.id)); } catch (e) { next(e); }
});

router.post('/banners', imageUploadMiddleware, async (req, res, next) => {
  try {
    const file = (req.files || [])[0];
    if (!file) throw new HttpError(400, 'NO_FILE', 'Image is required');

    const altText = (req.body.altText || '').toString().trim();
    const caption = (req.body.caption || '').toString().trim();
    const subcaption = (req.body.subcaption || '').toString().trim();
    const sortOrder = Number(req.body.sortOrder ?? 0);
    const isActive = req.body.isActive === 'false' ? false : true;

    if (altText.length > 255) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'altText too long');
    }
    if (caption.length > 255) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'caption too long');
    }
    if (subcaption.length > 500) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'subcaption too long');
    }
    if (!Number.isFinite(sortOrder) || sortOrder < 0 || sortOrder > 9999) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'sortOrder must be 0-9999');
    }

    const created = await cms.createBanner({
      file,
      altText,
      caption,
      subcaption,
      sortOrder,
      isActive,
    });
    res.status(201).json(created);
  } catch (e) { next(e); }
});

router.put('/banners/:id', validate(idParam, 'params'), validate(bannerUpdateBody), async (req, res, next) => {
  try { res.json(await cms.updateBanner(req.params.id, req.body)); } catch (e) { next(e); }
});

router.delete('/banners/:id', validate(idParam, 'params'), async (req, res, next) => {
  try { await cms.deleteBanner(req.params.id); res.status(204).end(); } catch (e) { next(e); }
});

// Settings -------------------------------------------------------------------

router.get('/settings', async (req, res, next) => {
  try {
    res.json({
      data: await cms.readSettings(),
      keys: CMS_SETTING_KEYS,
      labels: KEY_LABELS,
    });
  } catch (e) { next(e); }
});

router.put('/settings', validate(settingsBody), async (req, res, next) => {
  try { res.json({ data: await cms.writeSettings(req.body) }); } catch (e) { next(e); }
});

module.exports = router;
