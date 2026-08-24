const express = require('express');
const Joi = require('joi');

const { validate } = require('../../middleware/validate');
const { requireAuth, requireModule, requireModuleWriteOnMutation } = require('../../middleware/auth');
const { imageUploadMiddleware } = require('../../middleware/imageMulter');
const cms = require('../../services/admin/cms');
const { MODULES } = require('../../constants/modules');
const { CMS_SETTING_KEYS, KEY_LABELS } = require('../../constants/cms');
const { HttpError } = require('../../middleware/errors');

const router = express.Router();

router.use(requireAuth, requireModule(MODULES.CMS_MANAGEMENT));
// T-2026-173 Phase 2: sub-admins with only Read access get 403 on mutation.
router.use(requireModuleWriteOnMutation(MODULES.CMS_MANAGEMENT));

const idParam = Joi.object({ id: Joi.number().integer().positive().required() });

// Standard listing query params (server-side pagination). Shared across the
// two paginated list endpoints below (banners + sidebar-ads).
const listQuery = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(100).default(10),
});

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
// Strict 10-digit Indian mobile.
//
// Was /^\d{10}$/, which accepted ANY ten digits — 5455555545 and
// 0000000000 both validated and were then published on the website footer
// and contact page. Indian mobile numbers always begin 6, 7, 8 or 9, so the
// leading character class is required.
//
// Scope is the CMS contact pair only. shared/validation/rules.js still
// carries the looser app-wide pattern used by seller / buyer registration
// and the bulk-upload helpers; changing those is a separate decision.
//
// Mirrored by PHONE_PATTERN in src/admin/pages/Cms/ContactInfoForm.jsx —
// keep the two in step.
const PHONE_RE = /^[6-9]\d{9}$/;
const URL_RE   = /^https?:\/\/[^\s]+$/i;

const optionalLen = (max) => Joi.string().trim().max(max).allow('', null);
const optionalPhone = () => Joi.string().trim().length(10).pattern(PHONE_RE).allow('', null)
  .messages({
    'string.pattern.base': 'Enter a valid 10-digit mobile number starting with 6-9',
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

router.get('/banners', validate(listQuery, 'query'), async (req, res, next) => {
  try { res.json(await cms.listBanners(req.query)); } catch (e) { next(e); }
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
const MAX_SIDEBAR_AD_SERIAL_NUMBER = 5;
const DEFAULT_SIDEBAR_CTA_TEXT = "Post Property, It's FREE";
const optionalIsoDate = () => Joi.alternatives().try(
  Joi.string().trim().pattern(ISO_DATE_RE).max(10),
  Joi.valid(null, ''),
).messages({ 'string.pattern.base': 'Date must be YYYY-MM-DD' });

const sidebarAdUpdateBody = Joi.object({
  title: Joi.string().trim().min(1).max(120),
  subtitle: Joi.string().trim().max(240).allow('', null),
  ctaText: Joi.string().trim().min(1).max(60)
    .messages({ 'string.empty': 'Call to action is required.' }),
  startDate: optionalIsoDate(),
  endDate: optionalIsoDate(),
  serialNumber: Joi.number().integer().min(1).max(MAX_SIDEBAR_AD_SERIAL_NUMBER)
    .messages({ 'number.max': 'Serial Number cannot be greater than 5.' }),
  // Accept the old API name during rollout, but never expose it in the new
  // CMS UI or response DTO.
  sortOrder: Joi.number().integer().min(1).max(MAX_SIDEBAR_AD_SERIAL_NUMBER)
    .messages({ 'number.max': 'Serial Number cannot be greater than 5.' }),
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

router.get('/sidebar-ads', validate(listQuery, 'query'), async (req, res, next) => {
  try { res.json(await cms.listSidebarAds(req.query)); } catch (e) { next(e); }
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
    const ctaText = (req.body.ctaText || DEFAULT_SIDEBAR_CTA_TEXT).toString().trim();
    const startDate = normalizeDate(req.body.startDate);
    const endDate = normalizeDate(req.body.endDate);
    const serialNumber = Number(req.body.serialNumber ?? req.body.sortOrder ?? 1);
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
    if (!ctaText) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Call to action is required.');
    }
    if (ctaText.length > 60) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Call to action too long (max 60)');
    }
    if (startDate && endDate && endDate < startDate) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'endDate must be on or after startDate');
    }
    if (!Number.isInteger(serialNumber) || serialNumber < 1 || serialNumber > MAX_SIDEBAR_AD_SERIAL_NUMBER) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Serial Number cannot be greater than 5.');
    }

    const created = await cms.createSidebarAd({
      file,
      title,
      subtitle,
      ctaText,
      startDate,
      endDate,
      serialNumber,
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
