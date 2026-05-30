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
// Per-key validators. The shape is intentionally lenient on empty values
// (`.allow('', null)`) because clearing a setting is a valid operation —
// the public site falls back to its default copy when a key is empty.
// Non-empty values must satisfy the matching pattern + length cap. Mirror
// these rules in src/admin/pages/Cms/ContactInfoForm.jsx on the frontend.
// Strict 10-digit Indian mobile — matches the seller / buyer registration
// flows and the frontend PHONE_PATTERN in src/shared/validation/rules.js.
const PHONE_RE = /^\d{10}$/;
const URL_RE   = /^https?:\/\/[^\s]+$/i;

const optionalLen = (max) => Joi.string().trim().max(max).allow('', null);
const optionalPhone = () => Joi.string().trim().length(10).pattern(PHONE_RE).allow('', null)
  .messages({
    'string.pattern.base': 'Enter a valid 10-digit mobile number',
    'string.length': 'Mobile number must be exactly 10 digits',
  });
const optionalEmail = () => Joi.string().trim().max(255).email({ tlds: { allow: false } }).allow('', null);
const optionalUrl = () => Joi.string().trim().max(500).pattern(URL_RE).allow('', null)
  .messages({ 'string.pattern.base': 'Enter a full URL starting with http(s)://' });

const settingsBody = Joi.object({
  contact_number:    optionalPhone(),
  alternate_contact: optionalPhone(),
  contact_email:     optionalEmail(),
  office_address:    optionalLen(500),
  social_facebook:   optionalUrl(),
  social_twitter:    optionalUrl(),
  social_instagram:  optionalUrl(),
  social_linkedin:   optionalUrl(),
  social_youtube:    optionalUrl(),
  site_tagline:      optionalLen(200),
  support_hours:     optionalLen(200),
  about_heading:     optionalLen(100),
  about_content:     optionalLen(500),
  contact_heading:   optionalLen(100),
  contact_intro:     optionalLen(500),
}).min(1).unknown(false);

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

// Sidebar Ads ----------------------------------------------------------------
//
// All requests already require auth + CMS_MANAGEMENT module access (router-
// level middleware above). Image is optional — text-only ads are valid.

// ISO YYYY-MM-DD (strict). null / '' allowed for "no boundary on this side."
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const optionalIsoDate = () => Joi.alternatives().try(
  Joi.string().trim().pattern(ISO_DATE_RE).max(10),
  Joi.valid(null, ''),
).messages({ 'string.pattern.base': 'Date must be YYYY-MM-DD' });

const sidebarAdUpdateBody = Joi.object({
  title: Joi.string().trim().min(1).max(120),
  subtitle: Joi.string().trim().max(240).allow('', null),
  ctaText: Joi.string().trim().max(60).allow('', null),
  ctaUrl: Joi.string().trim().max(500).allow('', null),
  startDate: optionalIsoDate(),
  endDate: optionalIsoDate(),
  sortOrder: Joi.number().integer().min(0).max(9999),
  isActive: Joi.boolean(),
}).min(1);

function normalizeDate(input) {
  // Accept '', 'null', or undefined as "no value" so the frontend can clear
  // the field by submitting any of them.
  if (input == null) return null;
  const s = String(input).trim();
  if (s === '' || s === 'null') return null;
  if (!ISO_DATE_RE.test(s)) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Date must be YYYY-MM-DD');
  }
  return s;
}

router.get('/sidebar-ads', async (req, res, next) => {
  try { res.json({ data: await cms.listSidebarAds() }); } catch (e) { next(e); }
});

router.get('/sidebar-ads/:id', validate(idParam, 'params'), async (req, res, next) => {
  try { res.json(await cms.getSidebarAd(req.params.id)); } catch (e) { next(e); }
});

router.post('/sidebar-ads', imageUploadMiddleware, async (req, res, next) => {
  try {
    // Image is optional for this resource — req.files may be empty.
    const file = (req.files || [])[0] || null;

    const title = (req.body.title || '').toString().trim();
    const subtitle = (req.body.subtitle || '').toString().trim();
    const ctaText = (req.body.ctaText || '').toString().trim();
    const ctaUrl = (req.body.ctaUrl || '').toString().trim();
    const startDate = normalizeDate(req.body.startDate);
    const endDate = normalizeDate(req.body.endDate);
    const sortOrder = Number(req.body.sortOrder ?? 0);
    const isActive = req.body.isActive === 'false' ? false : true;

    if (!title) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Title is required');
    }
    if (title.length > 120) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Title too long (max 120)');
    }
    if (subtitle.length > 240) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Subtitle too long (max 240)');
    }
    if (ctaText.length > 60) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'CTA text too long (max 60)');
    }
    if (ctaUrl.length > 500) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'CTA URL too long (max 500)');
    }
    if (startDate && endDate && endDate < startDate) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'endDate must be on or after startDate');
    }
    if (!Number.isFinite(sortOrder) || sortOrder < 0 || sortOrder > 9999) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'sortOrder must be 0-9999');
    }

    const created = await cms.createSidebarAd({
      file,
      title,
      subtitle,
      ctaText,
      ctaUrl,
      startDate,
      endDate,
      sortOrder,
      isActive,
    });
    res.status(201).json(created);
  } catch (e) { next(e); }
});

router.put(
  '/sidebar-ads/:id',
  validate(idParam, 'params'),
  validate(sidebarAdUpdateBody),
  async (req, res, next) => {
    try {
      // After validate(), startDate/endDate are either valid 'YYYY-MM-DD',
      // '' (clear), or absent. Normalize '' → null so the service / repo
      // see a clean shape.
      const payload = { ...req.body };
      if ('startDate' in payload) payload.startDate = payload.startDate || null;
      if ('endDate' in payload) payload.endDate = payload.endDate || null;
      if (payload.startDate && payload.endDate && payload.endDate < payload.startDate) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'endDate must be on or after startDate');
      }
      res.json(await cms.updateSidebarAd(req.params.id, payload));
    } catch (e) { next(e); }
  },
);

router.delete('/sidebar-ads/:id', validate(idParam, 'params'), async (req, res, next) => {
  try { await cms.deleteSidebarAd(req.params.id); res.status(204).end(); } catch (e) { next(e); }
});

module.exports = router;
