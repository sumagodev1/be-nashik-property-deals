const express = require('express');
const Joi = require('joi');

const { validate } = require('../../middleware/validate');
const { requireAuth, requireModule, requireModuleWriteOnMutation } = require('../../middleware/auth');
const service = require('../../services/admin/land_records');
const { MODULES } = require('../../constants/modules');

const router = express.Router();

router.use(requireAuth, requireModule(MODULES.LAND_RECORD_MANAGEMENT));
// T-2026-173 Phase 2: sub-admins with only Read access get 403 on mutation.
router.use(requireModuleWriteOnMutation(MODULES.LAND_RECORD_MANAGEMENT));

const idParam = Joi.object({ id: Joi.number().integer().positive().required() });

const listQuery = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(100).default(10),
  search: Joi.string().trim().max(255).allow('').optional(),
});

/* ── Shared field builders ──────────────────────────────────── */

const optText   = (max = 255) => Joi.string().trim().max(max).allow('', null).optional();
const reqText   = (max = 255) => Joi.string().trim().max(max).required();
// Numeric fields carry an upper bound as well as a floor. optNum() was
// Joi.number().min(0) with no ceiling, so a rate of 4.4e+40 validated and was
// stored - the form then rendered it back in scientific notation.
//
// The ceilings are generous by design (a million guntha is 25,000 acres; a
// rate cap of 1,000 crore per unit is far past any real figure). They exist to
// stop runaway input, not to second-guess a valuation. Mirrored by AREA_MAX /
// RATE_MAX in src/admin/pages/LandRecords/GaothanLandLocatorForm.jsx.
// Ceilings are chosen to sit INSIDE the column definitions, so a value that
// passes validation can always be stored. Getting this wrong surfaces as a raw
// ER_WARN_DATA_OUT_OF_RANGE from MySQL, which tells an operator nothing.
//
//   gaothan_land_locators.area_*        decimal(12,4)  -> max 99,999,999.9999
//   gaothan_land_locators.rate_*        decimal(14,2)  -> max 999,999,999,999.99
//   paper_notice_records.*_value        decimal(14,4)  -> max 9,999,999,999.9999
//   paper_notice_records.aakaar_paise   decimal(14,2)  -> max 999,999,999,999.99
//
// AREA_MAX / RATE_MAX are the business limits (well inside the columns);
// DECIMAL_14_4_MAX is the storage limit for the paper-notice measures.
const AREA_MAX = 1000000;
const RATE_MAX = 10000000000;
const DECIMAL_14_4_MAX = 9999999999;
// A reference number: letters, digits and the separators these references
// actually use. Anchored so a value of pure punctuation cannot pass.
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9/\-., ]*$/;
const reqRefText = (max) => Joi.string().trim().min(1).max(max).pattern(REF_RE).required()
  .custom((value, helpers) => (
    value.length > 3 && /^(.)\1+$/.test(value) ? helpers.error('ref.repeated') : value
  ))
  .messages({
    'string.pattern.base': 'May contain only letters, digits and / - . , characters',
    'string.max': 'Must be ' + max + ' characters or fewer',
    'string.empty': 'Gut / Survey number is required',
    'any.required': 'Gut / Survey number is required',
    'ref.repeated': 'Does not look like a valid reference',
  });

const refText = (max) => Joi.string().trim().max(max).allow('', null).pattern(REF_RE).optional()
  .messages({
    'string.pattern.base': 'May contain only letters, digits and / - . , characters',
    'string.max': 'Must be ' + max + ' characters or fewer',
  });

// Advocate contact: landline with STD code, or a mobile. Digits only,
// with 8-15 digits.
const contactField = () => Joi.string().pattern(/^\d{8,15}$/).allow('', null)
  .optional()
  .messages({
    'string.base': 'Enter a valid phone number with 8-15 digits',
    'string.pattern.base': 'Enter a valid phone number with 8-15 digits',
  });

const optNum    = (max = RATE_MAX) => {
  const range = '0 and ' + max.toLocaleString('en-IN');
  // Messages go on the NUMBER branch, not just the alternatives wrapper. A
  // value past Number.MAX_SAFE_INTEGER (the 4.4e+40 from the bug report)
  // raises number.unsafe, which fires before .max() and would otherwise
  // surface as Joi's raw 'must be a safe number'.
  const num = Joi.number().min(0).max(max).messages({
    'number.base': 'Must be a number between ' + range,
    'number.min': 'Must be a number between ' + range,
    'number.max': 'Must be a number between ' + range,
    'number.unsafe': 'Must be a number between ' + range,
  });
  return Joi.alternatives().try(num, Joi.string().valid(''), Joi.valid(null)).optional()
    .messages({ 'alternatives.match': 'Must be a number between ' + range });
};

/* ── Gaothan Land Locator ───────────────────────────────────── */

const gaothanBody = Joi.object({
  districtCode: reqText(64),
  talukaCode:   reqText(64),
  shivarCode:   reqText(64),
  location:     reqText(255),
  gutOrSurveyNo: reqRefText(20),
  distanceFromGaothan: optText(100),
  roadApproach: Joi.boolean().default(false),
  roadApproachNote: Joi.when('roadApproach', {
    is: true,
    then: optText(500),
    otherwise: Joi.valid('', null).optional(),
  }),
  road1: optText(255),
  road2: optText(255),
  areaGuntha: optNum(AREA_MAX),
  areaAcre: optNum(AREA_MAX),
  ratePerGuntha: optNum(RATE_MAX),
  ratePerAcre: optNum(RATE_MAX),
});

router.get('/gaothan', validate(listQuery, 'query'), async (req, res, next) => {
  try { res.json(await service.listGaothan(req.query)); } catch (e) { next(e); }
});
router.get('/gaothan/:id', validate(idParam, 'params'), async (req, res, next) => {
  try { res.json(await service.getGaothan(req.params.id)); } catch (e) { next(e); }
});
router.post('/gaothan', validate(gaothanBody, 'body'), async (req, res, next) => {
  try { res.status(201).json(await service.createGaothan(req.body, req.user?.id)); } catch (e) { next(e); }
});
router.put('/gaothan/:id', validate(idParam, 'params'), validate(gaothanBody, 'body'), async (req, res, next) => {
  try { res.json(await service.updateGaothan(req.params.id, req.body)); } catch (e) { next(e); }
});
router.delete('/gaothan/:id', validate(idParam, 'params'), async (req, res, next) => {
  try { await service.deleteGaothan(req.params.id); res.status(204).end(); } catch (e) { next(e); }
});

/* ── Survey Number Locator ──────────────────────────────────── */

const surveyBody = Joi.object({
  districtCode: reqText(64),
  talukaCode:   reqText(64),
  shivarCode:   reqText(64),
  // Matches gaothanBody: a gut / survey number is a short identifier.
  gutOrSurveyNo: reqRefText(20),
  locality: reqText(255),
  roadTouch: Joi.boolean().default(false),
  roadTouchNote: Joi.when('roadTouch', {
    is: true,
    then: optText(500),
    otherwise: Joi.valid('', null).optional(),
  }),
  road: optText(255),
  offRoad: optText(255),
  inFrontOf: optText(255),
  nearBy: optText(255),
  behind: optText(255),
  opposite: optText(255),
  nextTo: optText(255),
});

router.get('/survey', validate(listQuery, 'query'), async (req, res, next) => {
  try { res.json(await service.listSurvey(req.query)); } catch (e) { next(e); }
});
router.get('/survey/:id', validate(idParam, 'params'), async (req, res, next) => {
  try { res.json(await service.getSurvey(req.params.id)); } catch (e) { next(e); }
});
router.post('/survey', validate(surveyBody, 'body'), async (req, res, next) => {
  try { res.status(201).json(await service.createSurvey(req.body, req.user?.id)); } catch (e) { next(e); }
});
router.put('/survey/:id', validate(idParam, 'params'), validate(surveyBody, 'body'), async (req, res, next) => {
  try { res.json(await service.updateSurvey(req.params.id, req.body)); } catch (e) { next(e); }
});
router.delete('/survey/:id', validate(idParam, 'params'), async (req, res, next) => {
  try { await service.deleteSurvey(req.params.id); res.status(204).end(); } catch (e) { next(e); }
});

/* ── Paper Notice Record ────────────────────────────────────── */

const paperBody = Joi.object({
  paperNameCode: reqText(64),
  // Reference numbers: shape as well as length. Mirrored by REF_PATTERN in
  // src/admin/pages/LandRecords/PaperNoticeRecordForm.jsx.
  pageNo: refText(10),
  paperNoticeNo: refText(30),
  noticeDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).required(),
  advocateSalutation: Joi.string().valid('mr', 'mrs', 'smt', 'miss').required(),
  advocateName: reqText(255),
  chamberNo: refText(30),
  address: optText(500),
  contactNo: contactField(),
  gutOrSurveyNo: reqRefText(20),
  areaValue: optNum(DECIMAL_14_4_MAX),
  areaUnitCode: optText(64),
  potKharbaValue: optNum(DECIMAL_14_4_MAX),
  potKharbaUnitCode: optText(64),
  totalAreaValue: optNum(DECIMAL_14_4_MAX),
  totalAreaUnitCode: optText(64),
  aakaarPaise: optNum(),
  ownersAreaValue: optNum(DECIMAL_14_4_MAX),
  ownersAreaUnitCode: optText(64),
  ownerName: optText(255),
  saleableAreaValue: optNum(DECIMAL_14_4_MAX),
  saleableAreaUnitCode: optText(64),
});

router.get('/paper-notice', validate(listQuery, 'query'), async (req, res, next) => {
  try { res.json(await service.listPaperNotice(req.query)); } catch (e) { next(e); }
});
router.get('/paper-notice/:id', validate(idParam, 'params'), async (req, res, next) => {
  try { res.json(await service.getPaperNotice(req.params.id)); } catch (e) { next(e); }
});
router.post('/paper-notice', validate(paperBody, 'body'), async (req, res, next) => {
  try { res.status(201).json(await service.createPaperNotice(req.body, req.user?.id)); } catch (e) { next(e); }
});
router.put('/paper-notice/:id', validate(idParam, 'params'), validate(paperBody, 'body'), async (req, res, next) => {
  try { res.json(await service.updatePaperNotice(req.params.id, req.body)); } catch (e) { next(e); }
});
router.delete('/paper-notice/:id', validate(idParam, 'params'), async (req, res, next) => {
  try { await service.deletePaperNotice(req.params.id); res.status(204).end(); } catch (e) { next(e); }
});

module.exports = router;
