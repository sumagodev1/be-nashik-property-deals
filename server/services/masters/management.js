/**
 * Service layer for the four master vocabularies. The repo handles SQL with a
 * whitelisted table name; this layer adds:
 *   - the masterKey → table mapping (so the route layer never sees raw table
 *     names)
 *   - duplicate-code prevention with a user-friendly error
 *   - DTO shaping for the API response (camelCase, boolean isActive)
 *   - guard against deleting the last remaining row referenced by inventory
 *     or website properties (best-effort — DB has no FK because the column
 *     stores a code string, not an id)
 */

const { HttpError } = require('../../middleware/errors');
const repo = require('../../db/queries/masters');
const { pool } = require('../../db/pool');

const MASTER_TABLES = Object.freeze({
  property_type:    'master_property_types',
  transaction_type: 'master_transaction_types',
  flat_type:        'master_flat_types',
  status_type:      'master_status_types',
});

const MASTER_LABELS = Object.freeze({
  property_type:    'Property type',
  transaction_type: 'Transaction type',
  flat_type:        'Flat / BHK configuration',
  status_type:      'Status',
});

// Fixed-vocabulary masters: the admin can toggle active/inactive on existing
// rows but cannot add, rename or delete them. The seeded list is the contract
// downstream filters and reports rely on.
const FIXED_MASTERS = new Set(['status_type']);
function assertNotFixed(masterKey, action) {
  if (FIXED_MASTERS.has(masterKey)) {
    throw new HttpError(
      403,
      'MASTER_FIXED',
      `${MASTER_LABELS[masterKey]} is a fixed vocabulary — ${action} is disabled. You can toggle individual rows active/inactive instead.`,
    );
  }
}

// Where each master is referenced. Used by the delete-safety check.
const USAGE_REFS = Object.freeze({
  property_type: [
    { table: 'inventory_properties', column: 'property_type' },
    { table: 'website_properties',   column: 'property_type' },
  ],
  transaction_type: [
    { table: 'inventory_properties', column: 'transaction_type' },
    { table: 'website_properties',   column: 'transaction_type' },
  ],
  flat_type: [
    { table: 'inventory_properties', column: 'bhk' },
    { table: 'website_properties',   column: 'bhk' },
  ],
  status_type: [
    { table: 'inventory_properties', column: 'status' },
  ],
});

function tableFor(masterKey) {
  const t = MASTER_TABLES[masterKey];
  if (!t) throw new HttpError(404, 'UNKNOWN_MASTER', `Unknown master "${masterKey}"`);
  return t;
}

function toDto(row) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    label: row.label,
    sortOrder: row.sort_order,
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function masterKeys() {
  return Object.keys(MASTER_TABLES);
}

function masterMeta(key) {
  return { key, label: MASTER_LABELS[key] || key };
}

async function list(masterKey, filters = {}) {
  const table = tableFor(masterKey);
  const page = Math.max(1, Number(filters.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(filters.pageSize) || 10));
  const { rows, total } = await repo.list(table, { ...filters, page, pageSize });
  return {
    master: masterMeta(masterKey),
    data: rows.map(toDto),
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

async function listAll(masterKey, filters = {}) {
  const rows = await repo.listAll(tableFor(masterKey), filters);
  return { master: masterMeta(masterKey), data: rows.map(toDto) };
}

async function getOne(masterKey, id) {
  const row = await repo.findById(tableFor(masterKey), id);
  if (!row) throw new HttpError(404, 'NOT_FOUND', `${MASTER_LABELS[masterKey]} not found`);
  return toDto(row);
}

async function activeCodes(masterKey) {
  return repo.activeCodes(tableFor(masterKey));
}

// Label rules vary per master. The strict masters accept letters + spaces
// only and cap at 30 chars (these are human category names — short and
// alphabetic, no numbers or punctuation). The lenient default still
// requires at least one letter but allows digits + a handful of punctuation
// because rows like "2 BHK" or "Showroom / Office" need them.
const LABEL_RULES = {
  property_type:    { maxLen: 30, pattern: 'alpha' },          // letters + spaces only
  transaction_type: { maxLen: 30, pattern: 'alpha' },          // letters + spaces only
  flat_type:        { maxLen: 30, pattern: 'alphanumeric' },   // letters + digits + spaces only
  status_type:      { maxLen: 64, pattern: 'lenient' },        // fixed master; rule unused
};
const PATTERNS = {
  alpha:        /^[A-Za-z ]+$/,
  alphanumeric: /^[A-Za-z0-9 ]+$/,
  lenient:      /^[A-Za-z0-9 /()&,.\-]+$/,
};
const PATTERN_MESSAGES = {
  alpha:        'may only contain letters and spaces — digits and special characters are not allowed',
  alphanumeric: 'may only contain letters, digits, and spaces — special characters are not allowed',
  lenient:      'contains an unsupported character. Allowed: letters, digits, spaces, and / ( ) & , . -',
};

function assertValidLabel(masterKey, label) {
  const v = String(label || '').trim();
  if (!v) throw new HttpError(400, 'VALIDATION_ERROR', `${MASTER_LABELS[masterKey]} name is required`);

  const rule = LABEL_RULES[masterKey] || { maxLen: 255, pattern: 'lenient' };
  if (v.length > rule.maxLen) {
    throw new HttpError(400, 'VALIDATION_ERROR', `${MASTER_LABELS[masterKey]} name must be at most ${rule.maxLen} characters`);
  }
  if (!/[A-Za-z]/.test(v)) {
    throw new HttpError(400, 'VALIDATION_ERROR', `${MASTER_LABELS[masterKey]} name must contain at least one letter`);
  }
  const regex = PATTERNS[rule.pattern] || PATTERNS.lenient;
  if (!regex.test(v)) {
    throw new HttpError(400, 'VALIDATION_ERROR', `${MASTER_LABELS[masterKey]} name ${PATTERN_MESSAGES[rule.pattern]}`);
  }
  return v;
}

async function create(masterKey, payload) {
  assertNotFixed(masterKey, 'creating new entries');
  const table = tableFor(masterKey);
  const label = assertValidLabel(masterKey, payload.label);
  const code = String(payload.code || '').trim().toLowerCase();
  if (await repo.codeTaken(table, code)) {
    throw new HttpError(409, 'CODE_TAKEN', `A ${MASTER_LABELS[masterKey].toLowerCase()} with code "${code}" already exists`);
  }
  if (await repo.labelTaken(table, label)) {
    throw new HttpError(409, 'LABEL_TAKEN', `A ${MASTER_LABELS[masterKey].toLowerCase()} named "${label}" already exists`);
  }
  const id = await repo.create(table, {
    code,
    label,
    sortOrder: Number(payload.sortOrder) || 0,
    isActive: payload.isActive !== false,
  });
  return getOne(masterKey, id);
}

async function update(masterKey, id, payload) {
  const table = tableFor(masterKey);
  const existing = await repo.findById(table, id);
  if (!existing) throw new HttpError(404, 'NOT_FOUND', `${MASTER_LABELS[masterKey]} not found`);
  // For fixed masters the admin may still flip is_active but cannot change
  // code or label. Strip those out of the payload before validation/persist.
  if (FIXED_MASTERS.has(masterKey)) {
    payload = { isActive: payload.isActive, sortOrder: payload.sortOrder };
  }
  // Label is only validated if it's actually being changed.
  const label = payload.label !== undefined
    ? assertValidLabel(masterKey, payload.label)
    : existing.label;
  const code = String(payload.code ?? existing.code).trim().toLowerCase();
  if (code !== existing.code && await repo.codeTaken(table, code, id)) {
    throw new HttpError(409, 'CODE_TAKEN', `A ${MASTER_LABELS[masterKey].toLowerCase()} with code "${code}" already exists`);
  }
  if (label.toLowerCase() !== String(existing.label).toLowerCase() && await repo.labelTaken(table, label, id)) {
    throw new HttpError(409, 'LABEL_TAKEN', `A ${MASTER_LABELS[masterKey].toLowerCase()} named "${label}" already exists`);
  }
  await repo.update(table, id, {
    code,
    label,
    sortOrder: payload.sortOrder !== undefined ? Number(payload.sortOrder) : existing.sort_order,
    isActive: payload.isActive !== undefined ? Boolean(payload.isActive) : Boolean(existing.is_active),
  });
  return getOne(masterKey, id);
}

async function remove(masterKey, id) {
  assertNotFixed(masterKey, 'deleting entries');
  const table = tableFor(masterKey);
  const existing = await repo.findById(table, id);
  if (!existing) throw new HttpError(404, 'NOT_FOUND', `${MASTER_LABELS[masterKey]} not found`);

  // Best-effort safety: if any non-deleted property row still references this
  // code, refuse the delete and ask the admin to reassign. Deactivating
  // (is_active = 0) is offered as an alternative since it doesn't break old
  // rows but hides the option from new-property dropdowns.
  const refs = USAGE_REFS[masterKey] || [];
  let inUse = 0;
  for (const ref of refs) {
    const [[{ n }]] = await pool.query(
      `SELECT COUNT(*) AS n FROM ${ref.table} WHERE ${ref.column} = ? AND deleted_at IS NULL`,
      [existing.code],
    );
    inUse += Number(n);
  }
  if (inUse > 0) {
    throw new HttpError(
      409,
      'IN_USE',
      `Cannot delete — ${inUse} property record${inUse === 1 ? ' references' : 's reference'} this ${MASTER_LABELS[masterKey].toLowerCase()}. Deactivate it instead.`,
    );
  }
  await repo.softDelete(table, id);
}

// Used by inventory/website-property/seller-property services to validate
// that a code coming in from a form still corresponds to an active master row.
// Throws HttpError 400 with a friendly message if not.
async function assertActiveCode(masterKey, code) {
  if (code === undefined || code === null || code === '') return;
  const row = await repo.findByCode(tableFor(masterKey), code);
  if (!row || !row.is_active) {
    throw new HttpError(
      400,
      'INVALID_MASTER_CODE',
      `Unknown or inactive ${MASTER_LABELS[masterKey].toLowerCase()}: "${code}"`,
    );
  }
}

module.exports = {
  masterKeys,
  masterMeta,
  list,
  listAll,
  getOne,
  activeCodes,
  assertActiveCode,
  create,
  update,
  remove,
};
