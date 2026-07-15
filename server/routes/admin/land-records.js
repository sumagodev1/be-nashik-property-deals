const express = require('express');
const Joi = require('joi');

const { validate } = require('../../middleware/validate');
const { requireAuth, requireModule } = require('../../middleware/auth');
const service = require('../../services/admin/land_records');
const { MODULES } = require('../../constants/modules');

const router = express.Router();

router.use(requireAuth, requireModule(MODULES.LAND_RECORD_MANAGEMENT));

const idParam = Joi.object({ id: Joi.number().integer().positive().required() });

const listQuery = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(100).default(10),
  search: Joi.string().trim().max(255).allow('').optional(),
});

/* ── Shared field builders ──────────────────────────────────── */

const optText   = (max = 255) => Joi.string().trim().max(max).allow('', null).optional();
const reqText   = (max = 255) => Joi.string().trim().max(max).required();
const optNum    = () => Joi.alternatives().try(Joi.number().min(0), Joi.string().valid(''), Joi.valid(null)).optional();

/* ── Gaothan Land Locator ───────────────────────────────────── */

const gaothanBody = Joi.object({
  districtCode: reqText(64),
  talukaCode:   reqText(64),
  shivarCode:   reqText(64),
  location:     reqText(255),
  gutOrSurveyNo: reqText(255),
  distanceFromGaothan: optText(255),
  roadApproach: Joi.boolean().default(false),
  roadApproachNote: Joi.when('roadApproach', {
    is: true,
    then: optText(500),
    otherwise: Joi.valid('', null).optional(),
  }),
  road1: optText(255),
  road2: optText(255),
  areaGuntha: optNum(),
  areaAcre: optNum(),
  ratePerGuntha: optNum(),
  ratePerAcre: optNum(),
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
  gutOrSurveyNo: reqText(255),
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
  pageNo: optText(64),
  paperNoticeNo: optText(255),
  noticeDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).required(),
  advocateSalutation: Joi.string().valid('mr', 'mrs', 'smt', 'miss').required(),
  advocateName: reqText(255),
  chamberNo: optText(64),
  address: optText(500),
  contactNo: optText(20),
  gutOrSurveyNo: reqText(255),
  areaValue: optNum(),
  areaUnitCode: optText(64),
  potKharbaValue: optNum(),
  potKharbaUnitCode: optText(64),
  totalAreaValue: optNum(),
  totalAreaUnitCode: optText(64),
  aakaarPaise: optNum(),
  ownersAreaValue: optNum(),
  ownersAreaUnitCode: optText(64),
  ownerName: optText(255),
  saleableAreaValue: optNum(),
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
