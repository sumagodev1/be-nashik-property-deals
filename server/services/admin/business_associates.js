/**
 * Service layer for the Business Associates directory.
 *
 * Snake → camel DTO shaping, trim/normalize on write, soft-not-found errors.
 * Same shape is reused by the public route so the homepage card + admin
 * table render off identical fields.
 */

const { HttpError } = require('../../middleware/errors');
const repo = require('../../db/queries/business_associates');

function trimStr(v) {
  return typeof v === 'string' ? v.trim() : v;
}

function toDto(row) {
  if (!row) return null;
  return {
    id: row.id,
    salutation: row.salutation,
    firstName: row.first_name,
    middleName: row.middle_name,
    surname: row.surname,
    designation: row.designation,
    addressLine1: row.address_line1,
    addressLine2: row.address_line2,
    cityCode: row.city_code,
    talukaCode: row.taluka_code,
    districtCode: row.district_code,
    phone1: row.phone1,
    phone2: row.phone2,
    mobile1: row.mobile1,
    mobile2: row.mobile2,
    mobile3: row.mobile3,
    whatsapp: row.whatsapp,
    email1: row.email1,
    email2: row.email2,
    website1: row.website1,
    website2: row.website2,
    // MySQL DATE round-trips as a JS Date — coerce back to YYYY-MM-DD so
    // the frontend datepicker sees the correct string.
    dateOfBirth: row.date_of_birth instanceof Date
      ? row.date_of_birth.toISOString().slice(0, 10)
      : row.date_of_birth,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalize(p) {
  return {
    salutation: trimStr(p.salutation),
    firstName: trimStr(p.firstName),
    middleName: trimStr(p.middleName),
    surname: trimStr(p.surname),
    designation: trimStr(p.designation),
    addressLine1: trimStr(p.addressLine1),
    addressLine2: trimStr(p.addressLine2),
    cityCode: trimStr(p.cityCode),
    talukaCode: trimStr(p.talukaCode),
    districtCode: trimStr(p.districtCode),
    phone1: trimStr(p.phone1),
    phone2: trimStr(p.phone2),
    mobile1: trimStr(p.mobile1),
    mobile2: trimStr(p.mobile2),
    mobile3: trimStr(p.mobile3),
    whatsapp: trimStr(p.whatsapp),
    email1: trimStr(p.email1),
    email2: trimStr(p.email2),
    website1: trimStr(p.website1),
    website2: trimStr(p.website2),
    dateOfBirth: p.dateOfBirth || null,
  };
}

async function list(query = {}) {
  const result = await repo.list(query);
  return {
    data: result.data.map(toDto),
    total: result.total,
    page: result.page,
    pageSize: result.pageSize,
    totalPages: Math.max(1, Math.ceil(result.total / result.pageSize)),
  };
}

async function getOne(id) {
  const row = await repo.getById(id);
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Business associate not found.');
  return toDto(row);
}

async function create(payload, adminId) {
  const row = await repo.create(normalize(payload), adminId);
  return toDto(row);
}

async function update(id, payload) {
  const existing = await repo.getById(id);
  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Business associate not found.');
  const row = await repo.update(id, normalize(payload));
  return toDto(row);
}

async function remove(id) {
  const existing = await repo.getById(id);
  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Business associate not found.');
  await repo.softDelete(id);
}

module.exports = { list, getOne, create, update, remove, toDto };
