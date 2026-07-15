/**
 * DB layer for the three Land Record Management surfaces.
 *
 * Each table is standalone (no shared schema with inventory or website
 * properties). Standard soft-delete + pagination pattern.
 */

const { pool } = require('../pool');

/* ──────────────────────────────────────────────────────────────────
 * Gaothan Land Locator
 * ────────────────────────────────────────────────────────────────── */

const GAOTHAN_COLUMNS = `
  id, district_code, taluka_code, shivar_code, location, gut_or_survey_no,
  distance_from_gaothan, road_approach, road_approach_note, road_1, road_2,
  area_guntha, area_acre, rate_per_guntha, rate_per_acre,
  created_by_admin_id, created_at, updated_at
`;

async function listGaothan({ page = 1, pageSize = 10, search = '' } = {}) {
  const offset = (page - 1) * pageSize;
  const args = [];
  let where = 'WHERE deleted_at IS NULL';
  if (search) {
    where += ' AND (location LIKE ? OR gut_or_survey_no LIKE ?)';
    const like = `%${search}%`;
    args.push(like, like);
  }
  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM gaothan_land_locators ${where}`,
    args,
  );
  const [rows] = await pool.query(
    `SELECT ${GAOTHAN_COLUMNS} FROM gaothan_land_locators ${where}
     ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    [...args, pageSize, offset],
  );
  return { data: rows, total: Number(total), page, pageSize };
}

async function getGaothan(id) {
  const [rows] = await pool.query(
    `SELECT ${GAOTHAN_COLUMNS} FROM gaothan_land_locators
     WHERE id = ? AND deleted_at IS NULL`,
    [id],
  );
  return rows[0] || null;
}

async function createGaothan(payload, adminId) {
  const [r] = await pool.query(
    `INSERT INTO gaothan_land_locators (
      district_code, taluka_code, shivar_code, location, gut_or_survey_no,
      distance_from_gaothan, road_approach, road_approach_note, road_1, road_2,
      area_guntha, area_acre, rate_per_guntha, rate_per_acre, created_by_admin_id
    ) VALUES (?,?,?,?,?, ?,?,?,?,?, ?,?,?,?,?)`,
    [
      payload.districtCode, payload.talukaCode, payload.shivarCode,
      payload.location, payload.gutOrSurveyNo,
      payload.distanceFromGaothan || null,
      payload.roadApproach ? 1 : 0,
      payload.roadApproachNote || null,
      payload.road1 || null,
      payload.road2 || null,
      payload.areaGuntha ?? null,
      payload.areaAcre ?? null,
      payload.ratePerGuntha ?? null,
      payload.ratePerAcre ?? null,
      adminId || null,
    ],
  );
  return getGaothan(r.insertId);
}

async function updateGaothan(id, payload) {
  await pool.query(
    `UPDATE gaothan_land_locators SET
      district_code = ?, taluka_code = ?, shivar_code = ?,
      location = ?, gut_or_survey_no = ?, distance_from_gaothan = ?,
      road_approach = ?, road_approach_note = ?, road_1 = ?, road_2 = ?,
      area_guntha = ?, area_acre = ?, rate_per_guntha = ?, rate_per_acre = ?
     WHERE id = ? AND deleted_at IS NULL`,
    [
      payload.districtCode, payload.talukaCode, payload.shivarCode,
      payload.location, payload.gutOrSurveyNo,
      payload.distanceFromGaothan || null,
      payload.roadApproach ? 1 : 0,
      payload.roadApproachNote || null,
      payload.road1 || null,
      payload.road2 || null,
      payload.areaGuntha ?? null,
      payload.areaAcre ?? null,
      payload.ratePerGuntha ?? null,
      payload.ratePerAcre ?? null,
      id,
    ],
  );
  return getGaothan(id);
}

async function deleteGaothan(id) {
  await pool.query(
    `UPDATE gaothan_land_locators SET deleted_at = CURRENT_TIMESTAMP
     WHERE id = ? AND deleted_at IS NULL`,
    [id],
  );
}

/* ──────────────────────────────────────────────────────────────────
 * Survey Number Locator
 * ────────────────────────────────────────────────────────────────── */

const SURVEY_COLUMNS = `
  id, district_code, taluka_code, shivar_code, gut_or_survey_no, locality,
  road_touch, road_touch_note, road, off_road, in_front_of, near_by,
  behind, opposite, next_to,
  created_by_admin_id, created_at, updated_at
`;

async function listSurvey({ page = 1, pageSize = 10, search = '' } = {}) {
  const offset = (page - 1) * pageSize;
  const args = [];
  let where = 'WHERE deleted_at IS NULL';
  if (search) {
    where += ' AND (locality LIKE ? OR gut_or_survey_no LIKE ?)';
    const like = `%${search}%`;
    args.push(like, like);
  }
  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM survey_number_locators ${where}`,
    args,
  );
  const [rows] = await pool.query(
    `SELECT ${SURVEY_COLUMNS} FROM survey_number_locators ${where}
     ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    [...args, pageSize, offset],
  );
  return { data: rows, total: Number(total), page, pageSize };
}

async function getSurvey(id) {
  const [rows] = await pool.query(
    `SELECT ${SURVEY_COLUMNS} FROM survey_number_locators
     WHERE id = ? AND deleted_at IS NULL`,
    [id],
  );
  return rows[0] || null;
}

async function createSurvey(payload, adminId) {
  const [r] = await pool.query(
    `INSERT INTO survey_number_locators (
      district_code, taluka_code, shivar_code, gut_or_survey_no, locality,
      road_touch, road_touch_note, road, off_road, in_front_of, near_by,
      behind, opposite, next_to, created_by_admin_id
    ) VALUES (?,?,?,?,?, ?,?,?,?,?, ?,?,?,?,?)`,
    [
      payload.districtCode, payload.talukaCode, payload.shivarCode,
      payload.gutOrSurveyNo, payload.locality,
      payload.roadTouch ? 1 : 0,
      payload.roadTouchNote || null,
      payload.road || null,
      payload.offRoad || null,
      payload.inFrontOf || null,
      payload.nearBy || null,
      payload.behind || null,
      payload.opposite || null,
      payload.nextTo || null,
      adminId || null,
    ],
  );
  return getSurvey(r.insertId);
}

async function updateSurvey(id, payload) {
  await pool.query(
    `UPDATE survey_number_locators SET
      district_code = ?, taluka_code = ?, shivar_code = ?,
      gut_or_survey_no = ?, locality = ?, road_touch = ?, road_touch_note = ?,
      road = ?, off_road = ?, in_front_of = ?, near_by = ?,
      behind = ?, opposite = ?, next_to = ?
     WHERE id = ? AND deleted_at IS NULL`,
    [
      payload.districtCode, payload.talukaCode, payload.shivarCode,
      payload.gutOrSurveyNo, payload.locality,
      payload.roadTouch ? 1 : 0,
      payload.roadTouchNote || null,
      payload.road || null,
      payload.offRoad || null,
      payload.inFrontOf || null,
      payload.nearBy || null,
      payload.behind || null,
      payload.opposite || null,
      payload.nextTo || null,
      id,
    ],
  );
  return getSurvey(id);
}

async function deleteSurvey(id) {
  await pool.query(
    `UPDATE survey_number_locators SET deleted_at = CURRENT_TIMESTAMP
     WHERE id = ? AND deleted_at IS NULL`,
    [id],
  );
}

/* ──────────────────────────────────────────────────────────────────
 * Paper Notice Record
 * ────────────────────────────────────────────────────────────────── */

const PAPER_COLUMNS = `
  id, paper_name_code, page_no, paper_notice_no, notice_date,
  advocate_salutation, advocate_name, chamber_no, address, contact_no,
  gut_or_survey_no,
  area_value, area_unit_code, pot_kharba_value, pot_kharba_unit_code,
  total_area_value, total_area_unit_code, aakaar_paise,
  owners_area_value, owners_area_unit_code, owner_name,
  saleable_area_value, saleable_area_unit_code,
  created_by_admin_id, created_at, updated_at
`;

async function listPaperNotice({ page = 1, pageSize = 10, search = '' } = {}) {
  const offset = (page - 1) * pageSize;
  const args = [];
  let where = 'WHERE deleted_at IS NULL';
  if (search) {
    where += ' AND (advocate_name LIKE ? OR owner_name LIKE ? OR gut_or_survey_no LIKE ? OR paper_notice_no LIKE ?)';
    const like = `%${search}%`;
    args.push(like, like, like, like);
  }
  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM paper_notice_records ${where}`,
    args,
  );
  const [rows] = await pool.query(
    `SELECT ${PAPER_COLUMNS} FROM paper_notice_records ${where}
     ORDER BY notice_date DESC, id DESC LIMIT ? OFFSET ?`,
    [...args, pageSize, offset],
  );
  return { data: rows, total: Number(total), page, pageSize };
}

async function getPaperNotice(id) {
  const [rows] = await pool.query(
    `SELECT ${PAPER_COLUMNS} FROM paper_notice_records
     WHERE id = ? AND deleted_at IS NULL`,
    [id],
  );
  return rows[0] || null;
}

async function createPaperNotice(payload, adminId) {
  const [r] = await pool.query(
    `INSERT INTO paper_notice_records (
      paper_name_code, page_no, paper_notice_no, notice_date,
      advocate_salutation, advocate_name, chamber_no, address, contact_no,
      gut_or_survey_no,
      area_value, area_unit_code, pot_kharba_value, pot_kharba_unit_code,
      total_area_value, total_area_unit_code, aakaar_paise,
      owners_area_value, owners_area_unit_code, owner_name,
      saleable_area_value, saleable_area_unit_code,
      created_by_admin_id
    ) VALUES (?,?,?,?, ?,?,?,?,?, ?, ?,?,?,?, ?,?,?, ?,?,?, ?,?, ?)`,
    [
      payload.paperNameCode,
      payload.pageNo || null,
      payload.paperNoticeNo || null,
      payload.noticeDate,
      payload.advocateSalutation,
      payload.advocateName,
      payload.chamberNo || null,
      payload.address || null,
      payload.contactNo || null,
      payload.gutOrSurveyNo,
      payload.areaValue ?? null,
      payload.areaUnitCode || null,
      payload.potKharbaValue ?? null,
      payload.potKharbaUnitCode || null,
      payload.totalAreaValue ?? null,
      payload.totalAreaUnitCode || null,
      payload.aakaarPaise ?? null,
      payload.ownersAreaValue ?? null,
      payload.ownersAreaUnitCode || null,
      payload.ownerName || null,
      payload.saleableAreaValue ?? null,
      payload.saleableAreaUnitCode || null,
      adminId || null,
    ],
  );
  return getPaperNotice(r.insertId);
}

async function updatePaperNotice(id, payload) {
  await pool.query(
    `UPDATE paper_notice_records SET
      paper_name_code = ?, page_no = ?, paper_notice_no = ?, notice_date = ?,
      advocate_salutation = ?, advocate_name = ?, chamber_no = ?, address = ?, contact_no = ?,
      gut_or_survey_no = ?,
      area_value = ?, area_unit_code = ?, pot_kharba_value = ?, pot_kharba_unit_code = ?,
      total_area_value = ?, total_area_unit_code = ?, aakaar_paise = ?,
      owners_area_value = ?, owners_area_unit_code = ?, owner_name = ?,
      saleable_area_value = ?, saleable_area_unit_code = ?
     WHERE id = ? AND deleted_at IS NULL`,
    [
      payload.paperNameCode,
      payload.pageNo || null,
      payload.paperNoticeNo || null,
      payload.noticeDate,
      payload.advocateSalutation,
      payload.advocateName,
      payload.chamberNo || null,
      payload.address || null,
      payload.contactNo || null,
      payload.gutOrSurveyNo,
      payload.areaValue ?? null,
      payload.areaUnitCode || null,
      payload.potKharbaValue ?? null,
      payload.potKharbaUnitCode || null,
      payload.totalAreaValue ?? null,
      payload.totalAreaUnitCode || null,
      payload.aakaarPaise ?? null,
      payload.ownersAreaValue ?? null,
      payload.ownersAreaUnitCode || null,
      payload.ownerName || null,
      payload.saleableAreaValue ?? null,
      payload.saleableAreaUnitCode || null,
      id,
    ],
  );
  return getPaperNotice(id);
}

async function deletePaperNotice(id) {
  await pool.query(
    `UPDATE paper_notice_records SET deleted_at = CURRENT_TIMESTAMP
     WHERE id = ? AND deleted_at IS NULL`,
    [id],
  );
}

module.exports = {
  listGaothan, getGaothan, createGaothan, updateGaothan, deleteGaothan,
  listSurvey, getSurvey, createSurvey, updateSurvey, deleteSurvey,
  listPaperNotice, getPaperNotice, createPaperNotice, updatePaperNotice, deletePaperNotice,
};
