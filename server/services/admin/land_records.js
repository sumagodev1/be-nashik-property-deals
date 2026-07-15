/**
 * Service layer for the three Land Record Management surfaces.
 *
 * Adds DTO shaping (snake → camel), soft not-found errors, and
 * per-column trim/normalize passes on top of the repo layer.
 */

const { HttpError } = require('../../middleware/errors');
const repo = require('../../db/queries/land_records');

function trimStr(v) {
  return typeof v === 'string' ? v.trim() : v;
}

/* ── Gaothan Land Locator ───────────────────────────────────── */

function toGaothanDto(row) {
  if (!row) return null;
  return {
    id: row.id,
    districtCode: row.district_code,
    talukaCode: row.taluka_code,
    shivarCode: row.shivar_code,
    location: row.location,
    gutOrSurveyNo: row.gut_or_survey_no,
    distanceFromGaothan: row.distance_from_gaothan,
    roadApproach: !!row.road_approach,
    roadApproachNote: row.road_approach_note,
    road1: row.road_1,
    road2: row.road_2,
    areaGuntha: row.area_guntha == null ? null : Number(row.area_guntha),
    areaAcre: row.area_acre == null ? null : Number(row.area_acre),
    ratePerGuntha: row.rate_per_guntha == null ? null : Number(row.rate_per_guntha),
    ratePerAcre: row.rate_per_acre == null ? null : Number(row.rate_per_acre),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function listGaothan(query = {}) {
  const result = await repo.listGaothan(query);
  return {
    data: result.data.map(toGaothanDto),
    total: result.total,
    page: result.page,
    pageSize: result.pageSize,
    totalPages: Math.max(1, Math.ceil(result.total / result.pageSize)),
  };
}

async function getGaothan(id) {
  const row = await repo.getGaothan(id);
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Record not found.');
  return toGaothanDto(row);
}

async function createGaothan(payload, adminId) {
  const clean = normalizeGaothan(payload);
  const row = await repo.createGaothan(clean, adminId);
  return toGaothanDto(row);
}

async function updateGaothan(id, payload) {
  const existing = await repo.getGaothan(id);
  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Record not found.');
  const clean = normalizeGaothan(payload);
  const row = await repo.updateGaothan(id, clean);
  return toGaothanDto(row);
}

async function deleteGaothan(id) {
  const existing = await repo.getGaothan(id);
  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Record not found.');
  await repo.deleteGaothan(id);
}

function normalizeGaothan(p) {
  return {
    districtCode: trimStr(p.districtCode),
    talukaCode: trimStr(p.talukaCode),
    shivarCode: trimStr(p.shivarCode),
    location: trimStr(p.location),
    gutOrSurveyNo: trimStr(p.gutOrSurveyNo),
    distanceFromGaothan: trimStr(p.distanceFromGaothan),
    roadApproach: !!p.roadApproach,
    roadApproachNote: p.roadApproach ? trimStr(p.roadApproachNote) : null,
    road1: trimStr(p.road1),
    road2: trimStr(p.road2),
    areaGuntha: p.areaGuntha === '' || p.areaGuntha == null ? null : Number(p.areaGuntha),
    areaAcre: p.areaAcre === '' || p.areaAcre == null ? null : Number(p.areaAcre),
    ratePerGuntha: p.ratePerGuntha === '' || p.ratePerGuntha == null ? null : Number(p.ratePerGuntha),
    ratePerAcre: p.ratePerAcre === '' || p.ratePerAcre == null ? null : Number(p.ratePerAcre),
  };
}

/* ── Survey Number Locator ──────────────────────────────────── */

function toSurveyDto(row) {
  if (!row) return null;
  return {
    id: row.id,
    districtCode: row.district_code,
    talukaCode: row.taluka_code,
    shivarCode: row.shivar_code,
    gutOrSurveyNo: row.gut_or_survey_no,
    locality: row.locality,
    roadTouch: !!row.road_touch,
    roadTouchNote: row.road_touch_note,
    road: row.road,
    offRoad: row.off_road,
    inFrontOf: row.in_front_of,
    nearBy: row.near_by,
    behind: row.behind,
    opposite: row.opposite,
    nextTo: row.next_to,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function listSurvey(query = {}) {
  const result = await repo.listSurvey(query);
  return {
    data: result.data.map(toSurveyDto),
    total: result.total,
    page: result.page,
    pageSize: result.pageSize,
    totalPages: Math.max(1, Math.ceil(result.total / result.pageSize)),
  };
}

async function getSurvey(id) {
  const row = await repo.getSurvey(id);
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Record not found.');
  return toSurveyDto(row);
}

async function createSurvey(payload, adminId) {
  const clean = normalizeSurvey(payload);
  const row = await repo.createSurvey(clean, adminId);
  return toSurveyDto(row);
}

async function updateSurvey(id, payload) {
  const existing = await repo.getSurvey(id);
  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Record not found.');
  const clean = normalizeSurvey(payload);
  const row = await repo.updateSurvey(id, clean);
  return toSurveyDto(row);
}

async function deleteSurvey(id) {
  const existing = await repo.getSurvey(id);
  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Record not found.');
  await repo.deleteSurvey(id);
}

function normalizeSurvey(p) {
  return {
    districtCode: trimStr(p.districtCode),
    talukaCode: trimStr(p.talukaCode),
    shivarCode: trimStr(p.shivarCode),
    gutOrSurveyNo: trimStr(p.gutOrSurveyNo),
    locality: trimStr(p.locality),
    roadTouch: !!p.roadTouch,
    roadTouchNote: p.roadTouch ? trimStr(p.roadTouchNote) : null,
    road: trimStr(p.road),
    offRoad: trimStr(p.offRoad),
    inFrontOf: trimStr(p.inFrontOf),
    nearBy: trimStr(p.nearBy),
    behind: trimStr(p.behind),
    opposite: trimStr(p.opposite),
    nextTo: trimStr(p.nextTo),
  };
}

/* ── Paper Notice Record ────────────────────────────────────── */

function toPaperDto(row) {
  if (!row) return null;
  return {
    id: row.id,
    paperNameCode: row.paper_name_code,
    pageNo: row.page_no,
    paperNoticeNo: row.paper_notice_no,
    // MySQL DATE round-trips as a JS Date — coerce back to YYYY-MM-DD so
    // the frontend datepicker sees the correct value.
    noticeDate: row.notice_date instanceof Date
      ? row.notice_date.toISOString().slice(0, 10)
      : row.notice_date,
    advocateSalutation: row.advocate_salutation,
    advocateName: row.advocate_name,
    chamberNo: row.chamber_no,
    address: row.address,
    contactNo: row.contact_no,
    gutOrSurveyNo: row.gut_or_survey_no,
    areaValue: row.area_value == null ? null : Number(row.area_value),
    areaUnitCode: row.area_unit_code,
    potKharbaValue: row.pot_kharba_value == null ? null : Number(row.pot_kharba_value),
    potKharbaUnitCode: row.pot_kharba_unit_code,
    totalAreaValue: row.total_area_value == null ? null : Number(row.total_area_value),
    totalAreaUnitCode: row.total_area_unit_code,
    aakaarPaise: row.aakaar_paise == null ? null : Number(row.aakaar_paise),
    ownersAreaValue: row.owners_area_value == null ? null : Number(row.owners_area_value),
    ownersAreaUnitCode: row.owners_area_unit_code,
    ownerName: row.owner_name,
    saleableAreaValue: row.saleable_area_value == null ? null : Number(row.saleable_area_value),
    saleableAreaUnitCode: row.saleable_area_unit_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function listPaperNotice(query = {}) {
  const result = await repo.listPaperNotice(query);
  return {
    data: result.data.map(toPaperDto),
    total: result.total,
    page: result.page,
    pageSize: result.pageSize,
    totalPages: Math.max(1, Math.ceil(result.total / result.pageSize)),
  };
}

async function getPaperNotice(id) {
  const row = await repo.getPaperNotice(id);
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Record not found.');
  return toPaperDto(row);
}

async function createPaperNotice(payload, adminId) {
  const clean = normalizePaper(payload);
  const row = await repo.createPaperNotice(clean, adminId);
  return toPaperDto(row);
}

async function updatePaperNotice(id, payload) {
  const existing = await repo.getPaperNotice(id);
  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Record not found.');
  const clean = normalizePaper(payload);
  const row = await repo.updatePaperNotice(id, clean);
  return toPaperDto(row);
}

async function deletePaperNotice(id) {
  const existing = await repo.getPaperNotice(id);
  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Record not found.');
  await repo.deletePaperNotice(id);
}

function normalizePaper(p) {
  const num = (v) => (v === '' || v == null ? null : Number(v));
  return {
    paperNameCode: trimStr(p.paperNameCode),
    pageNo: trimStr(p.pageNo),
    paperNoticeNo: trimStr(p.paperNoticeNo),
    noticeDate: p.noticeDate,
    advocateSalutation: trimStr(p.advocateSalutation),
    advocateName: trimStr(p.advocateName),
    chamberNo: trimStr(p.chamberNo),
    address: trimStr(p.address),
    contactNo: trimStr(p.contactNo),
    gutOrSurveyNo: trimStr(p.gutOrSurveyNo),
    areaValue: num(p.areaValue),
    areaUnitCode: trimStr(p.areaUnitCode),
    potKharbaValue: num(p.potKharbaValue),
    potKharbaUnitCode: trimStr(p.potKharbaUnitCode),
    totalAreaValue: num(p.totalAreaValue),
    totalAreaUnitCode: trimStr(p.totalAreaUnitCode),
    aakaarPaise: num(p.aakaarPaise),
    ownersAreaValue: num(p.ownersAreaValue),
    ownersAreaUnitCode: trimStr(p.ownersAreaUnitCode),
    ownerName: trimStr(p.ownerName),
    saleableAreaValue: num(p.saleableAreaValue),
    saleableAreaUnitCode: trimStr(p.saleableAreaUnitCode),
  };
}

module.exports = {
  listGaothan, getGaothan, createGaothan, updateGaothan, deleteGaothan,
  listSurvey, getSurvey, createSurvey, updateSurvey, deleteSurvey,
  listPaperNotice, getPaperNotice, createPaperNotice, updatePaperNotice, deletePaperNotice,
};
