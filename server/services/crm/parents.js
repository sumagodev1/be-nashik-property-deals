/**
 * Parent (unique person) service layer for the CRM subsystem.
 *
 * Thin wrapper over db/queries/crm for the parent operations that
 * bypass the duplicate resolver (e.g. admin-side "search parents by
 * name" list, "view parent with sub-enquiries" detail).
 *
 * PII masking (T-2026-151 Phase 1 scaffolding):
 *   `toDto()` masks name / mobile / email by default. Callers that
 *   have re-validated the admin PIN can pass { unmasked: true } to get
 *   the raw values. The Phase-3 FE will wire a PIN dialog on the
 *   Property View "Allocated Enquiries" section that flips a per-
 *   session unmask flag; until then, everything is masked at the
 *   response boundary.
 */

const { HttpError } = require('../../middleware/errors');
const crm = require('../../db/queries/crm');

function maskName(name) {
  if (!name) return '';
  const trimmed = String(name).trim();
  if (trimmed.length <= 2) return trimmed[0] + '*';
  const first = trimmed.slice(0, 2);
  return `${first}${'*'.repeat(Math.min(6, trimmed.length - 2))}`;
}

function maskMobile(mobile) {
  if (!mobile) return '';
  const digits = String(mobile).replace(/\D+/g, '');
  if (digits.length < 4) return '*'.repeat(digits.length);
  const tail = digits.slice(-4);
  return `XXXXXX${tail}`;
}

function maskEmail(email) {
  if (!email) return '';
  const [local, domain] = String(email).split('@');
  if (!domain) return '***';
  if (!local) return `***@${domain}`;
  if (local.length <= 2) return `${local[0]}*@${domain}`;
  return `${local.slice(0, 2)}${'*'.repeat(Math.min(4, local.length - 2))}@${domain}`;
}

function toDto(row, { unmasked = false } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    full_name:         unmasked ? row.full_name         : maskName(row.full_name),
    normalized_mobile: unmasked ? row.normalized_mobile : maskMobile(row.normalized_mobile),
    normalized_email:  unmasked ? row.normalized_email  : maskEmail(row.normalized_email),
    source_hint:       row.source_hint,
    created_at:        row.created_at,
    updated_at:        row.updated_at,
    is_masked:         !unmasked,
  };
}

async function list({ page, pageSize, search, unmasked = false } = {}) {
  const res = await crm.listParents({ page, pageSize, search });
  return {
    ...res,
    rows: res.rows.map((r) => toDto(r, { unmasked })),
  };
}

async function getById(id, { unmasked = false } = {}) {
  const row = await crm.findParentById(id);
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Parent not found');
  return toDto(row, { unmasked });
}

module.exports = {
  list,
  getById,
  toDto,
  maskName,
  maskMobile,
  maskEmail,
};
