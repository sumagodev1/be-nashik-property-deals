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
    salutation: p.salutation ? String(p.salutation).toLowerCase() : null,
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



// ── Bulk upload helpers (additive) ──────────────────────────────────────
//
// bulkCheckDuplicates + bulkCreate live here so the route file stays thin.
// The route file already validates payload shape via Joi; bulkCreate does
// one additional server-side re-validation per row (required fields,
// mobile format, email format) so a hand-crafted client that skips the
// browser check still can't slip malformed rows past. Each row is inserted
// in its own transaction — a failure on row N does NOT roll back rows 0..N-1.

const PHONE_10 = /^\d{10}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normContact(v) {
  return typeof v === 'string' ? v.trim() : (v == null ? '' : String(v).trim());
}

async function bulkCheckDuplicates(items) {
  if (!Array.isArray(items) || items.length === 0) return [];

  const mobiles   = [];
  const phones    = [];
  const whatsapps = [];
  const emails    = [];
  items.forEach((it) => {
    const m = normContact(it.mobile1);
    const p = normContact(it.phone1);
    const w = normContact(it.whatsapp);
    const e = normContact(it.email1);
    if (m) mobiles.push(m);
    if (p) phones.push(p);
    if (w) whatsapps.push(w);
    if (e) emails.push(e.toLowerCase());
  });

  const existing = await repo.findByContactFields({
    mobiles, phones, whatsapps, emails,
  });

  const mobileMap   = new Map();
  const phoneMap    = new Map();
  const whatsappMap = new Map();
  const emailMap    = new Map();
  existing.forEach((row) => {
    ['mobile1', 'mobile2', 'mobile3'].forEach((col) => {
      const v = normContact(row[col]);
      if (v && !mobileMap.has(v)) mobileMap.set(v, row.id);
    });
    ['phone1', 'phone2'].forEach((col) => {
      const v = normContact(row[col]);
      if (v && !phoneMap.has(v)) phoneMap.set(v, row.id);
    });
    const w = normContact(row.whatsapp);
    if (w && !whatsappMap.has(w)) whatsappMap.set(w, row.id);
    ['email1', 'email2'].forEach((col) => {
      const v = normContact(row[col]).toLowerCase();
      if (v && !emailMap.has(v)) emailMap.set(v, row.id);
    });
  });

  return items.map((it, index) => {
    const m = normContact(it.mobile1);
    const p = normContact(it.phone1);
    const w = normContact(it.whatsapp);
    const e = normContact(it.email1).toLowerCase();
    if (m && mobileMap.has(m))   return { index, isDuplicate: true, matchedField: 'mobile',   matchedId: mobileMap.get(m) };
    if (p && phoneMap.has(p))    return { index, isDuplicate: true, matchedField: 'phone',    matchedId: phoneMap.get(p) };
    if (w && whatsappMap.has(w)) return { index, isDuplicate: true, matchedField: 'whatsapp', matchedId: whatsappMap.get(w) };
    if (e && emailMap.has(e))    return { index, isDuplicate: true, matchedField: 'email',    matchedId: emailMap.get(e) };
    return { index, isDuplicate: false };
  });
}

function validateOne(payload) {
  const firstName = normContact(payload.firstName);
  const mobile1   = normContact(payload.mobile1);
  const phone1    = normContact(payload.phone1);
  const whatsapp  = normContact(payload.whatsapp);
  const email1    = normContact(payload.email1);
  if (!firstName)  return 'First name is required.';
  if (!mobile1)    return 'Mobile Number is required.';
  if (!PHONE_10.test(mobile1))            return 'Mobile Number must be exactly 10 digits.';
  if (phone1   && !PHONE_10.test(phone1))   return 'Phone Number must be exactly 10 digits.';
  if (whatsapp && !PHONE_10.test(whatsapp)) return 'WhatsApp Number must be exactly 10 digits.';
  if (email1   && !EMAIL_RE.test(email1))   return 'Email is not a valid address.';
  return null;
}

async function bulkCreate(items, { skipDuplicates = false, adminId = null } = {}) {
  if (!Array.isArray(items) || items.length === 0) return [];

  const contactOnly = items.map((it) => ({
    mobile1: it.mobile1, phone1: it.phone1, whatsapp: it.whatsapp, email1: it.email1,
  }));
  const dupResult = await bulkCheckDuplicates(contactOnly);
  const dupSet = new Set(dupResult.filter((d) => d.isDuplicate).map((d) => d.index));

  const results = [];
  for (let i = 0; i < items.length; i += 1) {
    const payload = items[i];
    const invalidReason = validateOne(payload);
    if (invalidReason) {
      results.push({ index: i, status: 'invalid', error: invalidReason });
      continue;
    }
    if (dupSet.has(i)) {
      if (skipDuplicates) {
        results.push({ index: i, status: 'duplicate', error: 'Already exists in database' });
        continue;
      }
    }
    try {
      // eslint-disable-next-line no-await-in-loop
      const row = await repo.create(normalize(payload), adminId);
      results.push({ index: i, status: 'created', id: row.id });
    } catch (e) {
      results.push({ index: i, status: 'error', error: e.message || 'Insert failed' });
    }
  }
  return results;
}

module.exports = { list, getOne, create, update, remove, toDto, bulkCheckDuplicates, bulkCreate };
