/**
 * Share a property (Inventory / Enquiry / Website) via email.
 *
 * Single source of truth for the "Share Property" feature — all three
 * property surfaces funnel through this module so the recipient email
 * rendering, attachment strategy, and safety filters stay identical.
 *
 * Two rendering modes:
 *
 *   1. DYNAMIC (preferred) — the caller passes a `sections` array
 *      describing the sections + fields to include. Each section maps
 *      1:1 to a checkbox the user selected in the Share dialog; the
 *      frontend builds the array from the resolved MD form config so
 *      any new form field becomes shareable with zero backend changes.
 *
 *   2. LEGACY fallback — when no `sections` array is present we honour
 *      the pre-existing `includeDetails` / `includeDescription` boolean
 *      flags. Preserves back-compat with older frontends.
 *
 * Safety guarantees (belt-and-suspenders):
 *   - The frontend `shareSections` helper strips owner / staff / internal
 *     / contact fields before building the payload.
 *   - This module re-applies the SAME denylist on every field key so a
 *     tampered client payload cannot leak private data.
 *   - Images stream from `uploads/public/<propertyKind>/…`.
 *   - Documents stream from `uploads/private/<propertyKind>/…` — private
 *     files can only be attached via this authenticated admin flow.
 *
 * The user's typed Message becomes the top of the email body verbatim; no
 * default company greeting / footer is ever appended.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const { HttpError } = require('../../middleware/errors');
const emailer = require('./../email/transporter');
const propertyFiles = require('../../db/queries/property_files');
const documentUpload = require('../files/documentUpload');
const inventoryQ = require('../../db/queries/inventory_properties');
const enquiryQ = require('../../db/queries/enquiry_properties');
const websiteQ = require('../../db/queries/website_properties');
const masters = require('../../db/queries/masters');
const locations = require('../../db/queries/locations');

// Backend area-unit code → human label. Kept inline (no shared constant on
// the backend) because constants/property.js only tracks the master
// allowlist, not the display labels.
const AREA_UNIT_LABELS = {
  sqft: 'sq.ft',
  sqm: 'sq.m',
  sqyd: 'sq.yd',
  acre: 'acre',
  hectare: 'hectare',
  guntha: 'guntha',
};

const PRIVATE_DIR = process.env.UPLOAD_PRIVATE_DIR || 'uploads/private';
const PUBLIC_DIR = process.env.UPLOAD_PUBLIC_DIR || 'uploads/public';

function appRoot() { return path.resolve(__dirname, '..', '..', '..'); }

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Mirror of the frontend `shareSections.DENY_SUBSTRINGS`. Any field key
// whose lowercased form contains one of these substrings is dropped —
// even if the client somehow submits it under a "public" section. See
// src/shared/utils/shareSections.js for the canonical list.
const DENY_SUBSTRINGS = [
  'owner', 'contact', 'mobile', 'phone', 'whatsapp', 'email',
  'aadhaar', 'aadhar', 'pan',
  'referencesourceoflead', 'referencesource', 'reference',
  'keydetail', 'keypersons', 'keyperson',
  'internal', 'staff', 'office', 'remark',
  'note', 'salary', 'income', 'financial',
];
const DENY_EXCEPTIONS = new Set([
  'amenitiesnote',
  'roadapproachnote',
  'roadtouchnote',
]);
function isDeniedKey(rawKey) {
  const k = String(rawKey || '').toLowerCase();
  if (!k || k.startsWith('__')) return true;
  if (DENY_EXCEPTIONS.has(k)) return false;
  for (const p of DENY_SUBSTRINGS) if (k.includes(p)) return true;
  return false;
}

// ── Recipients ────────────────────────────────────────────────────────

function parseRecipients(raw) {
  if (!raw) return { valid: [], invalid: [] };
  const tokens = String(raw)
    .split(/[,;\s]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  const valid = [];
  const invalid = [];
  const seen = new Set();
  for (const t of tokens) {
    if (EMAIL_RE.test(t)) {
      const norm = t.toLowerCase();
      if (!seen.has(norm)) { seen.add(norm); valid.push(t); }
    } else {
      invalid.push(t);
    }
  }
  return { valid, invalid };
}

// ── Property fetch (kind-scoped) ─────────────────────────────────────

const KIND_QUERIES = {
  inventory: inventoryQ,
  enquiry: enquiryQ,
  website: websiteQ,
};

async function loadProperty(propertyKind, propertyId) {
  const q = KIND_QUERIES[propertyKind];
  if (!q) throw new HttpError(400, 'BAD_KIND', 'Invalid property kind');
  const row = await q.findById(propertyId);
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Property not found');
  return row;
}

// ── Value readers ────────────────────────────────────────────────────

// Field key → top-level DB column name. Anything not in the map is read
// out of `details.dynamicData` instead. cityVillage is an alias used by
// Bank Auction / Pre-Leased forms whose LocationCascade writes to the
// same `shivar` column.
const TOP_LEVEL_MAP = {
  propertyCode: 'property_code',
  title: 'title',
  description: 'description',
  // Posting Date columns:
  //   * inventory_properties.posting_date        (migration 081 rename)
  //   * enquiry_properties.posting_date          (migration 081 rename)
  //   * website_properties.registration_date     (unchanged — website is
  //                                                out of scope for the
  //                                                Posting Date rollout)
  // `resolveTopLevelColumn` picks the right column per module kind so a
  // sections payload that says `postingDate` resolves correctly on all
  // three surfaces. `registrationDate` is kept as a legacy alias that
  // still works for callers on the pre-rename contract (website + any
  // old inventory/enquiry FE build that hasn't shipped).
  postingDate: 'posting_date',
  registrationDate: 'registration_date',
  availableFromDate: 'available_from_date',
  createdAt: 'created_at',
  // Alias — the new "Created On Date" share checkbox uses `createdOn` as
  // its FE key. Same column, different label.
  createdOn: 'created_at',
  updatedAt: 'updated_at',
  district: 'district',
  taluka: 'taluka',
  shivar: 'shivar',
  cityVillage: 'shivar',
  location: 'location',
  formattedAddress: 'formatted_address',
  pincode: 'pincode',
  latitude: 'latitude',
  longitude: 'longitude',
  bhk: 'bhk',
  price: 'price',
  areaValue: 'area_value',
  areaUnit: 'area_unit',
  status: 'status',
  propertyType: 'property_type',
  transactionType: 'transaction_type',
  propertyVariety: 'transaction_variant',
};

// Per-kind overrides for TOP_LEVEL_MAP. Only entries here diverge from the
// default map. Website keeps the legacy `registration_date` column, so a
// `postingDate` field key falls back to it there.
const TOP_LEVEL_MAP_OVERRIDES = {
  website: {
    postingDate: 'registration_date',
  },
};

function resolveTopLevelColumn(propertyKind, key) {
  const overrides = TOP_LEVEL_MAP_OVERRIDES[propertyKind];
  if (overrides && Object.prototype.hasOwnProperty.call(overrides, key)) {
    return overrides[key];
  }
  return TOP_LEVEL_MAP[key];
}

function parseDetailsField(raw) {
  if (raw === null || raw === undefined) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw) || {}; } catch { return {}; }
}

function readFieldValue(propertyKind, row, dyn, details, key) {
  // Classification codes (property_type / transaction_type /
  // transaction_variant) may be stored as either the CODE column or,
  // for T-2026-055 rows, ALSO the NAME column, and the resolved JOIN
  // alias always fires when a matching master row exists. Try every
  // source so a row missing the code column (some legacy inserts) or
  // a website row (no `_name` column) still produces a value that
  // formatFieldValue can turn into a human label.
  if (key === 'propertyType') {
    return row.property_type
      || row.property_type_name
      || row.resolved_property_type_name
      || (dyn && dyn.propertyType)
      || undefined;
  }
  if (key === 'transactionType') {
    return row.transaction_type
      || row.transaction_type_name
      || row.resolved_transaction_type_name
      || (dyn && dyn.transactionType)
      || undefined;
  }
  if (key === 'propertyVariety') {
    return row.transaction_variant
      || row.property_variety_name
      || row.resolved_property_variety_name
      || (details && details.property_variety)
      || (dyn && dyn.propertyVariety)
      || undefined;
  }
  const col = resolveTopLevelColumn(propertyKind, key);
  if (col && Object.prototype.hasOwnProperty.call(row, col)) return row[col];
  if (Object.prototype.hasOwnProperty.call(dyn, key)) return dyn[key];
  return undefined;
}

// ── Master resolution ────────────────────────────────────────────────

// Legacy single-vocabulary masters live in dedicated tables; every other
// master key is a discriminator on master_lookups.
const LEGACY_MASTER_TABLES = {
  property_type: 'master_property_types',
  transaction_type: 'master_transaction_types',
  flat_type: 'master_flat_types',
  status_type: 'master_status_types',
};

async function resolveMasterLabelByKey(masterKey, code) {
  if (!code || !masterKey) return code || '';
  try {
    const table = LEGACY_MASTER_TABLES[masterKey];
    if (table) {
      const row = await masters.findByCode(table, code);
      return (row && row.label) || code;
    }
    const row = await masters.findByCode('master_lookups', code, {
      discriminator: { masterKey },
    });
    return (row && row.label) || code;
  } catch {
    return code;
  }
}

// Batch resolver for hierarchical location codes (district / taluka /
// shivar). Uses the dedicated locations.labelsForCodes so we don't
// round-trip once per code.
async function resolveLocationLabel(masterKey, code) {
  if (!code) return '';
  try {
    const rows = await locations.labelsForCodes(masterKey, [code]);
    return (rows[0] && rows[0].label) || code;
  } catch {
    return code;
  }
}

// Field-key → default master key. Used for fields the frontend sent
// without an explicit `masterKey` hint because they read from top-level
// columns whose master vocabulary is known here.
function defaultMasterKeyForField(propertyKind, fieldKey) {
  if (fieldKey === 'propertyType')    return 'property_type';
  if (fieldKey === 'transactionType') return 'transaction_type';
  if (fieldKey === 'propertyVariety') return 'property_variety';
  if (fieldKey === 'bhk')             return 'flat_type';
  if (fieldKey === 'status') {
    return propertyKind === 'enquiry' ? 'enquiry_status' : 'status_type';
  }
  if (fieldKey === 'district') return 'district';
  if (fieldKey === 'taluka')   return 'taluka';
  if (fieldKey === 'shivar')   return 'shivar';
  if (fieldKey === 'cityVillage') return 'shivar';
  return null;
}

// ── Formatters ───────────────────────────────────────────────────────

function formatDate(v) {
  if (!v) return '';
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  // DD/MM/YYYY (IST) — Posting Date, Available From Date share cells.
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Kolkata',
  }).format(d);
}

// DD/MM/YYYY hh:mm AM/PM (IST) — Created On Date share cell (server timestamp).
function formatDateTime(v) {
  if (!v) return '';
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  const datePart = new Intl.DateTimeFormat('en-GB', {
    day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Kolkata',
  }).format(d);
  const timePart = new Intl.DateTimeFormat('en-US', {
    hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata',
  }).format(d);
  return `${datePart} ${timePart}`;
}

function formatPrice(v) {
  const p = Number(v);
  if (!Number.isFinite(p) || p <= 0) return '';
  return new Intl.NumberFormat('en-IN', {
    style: 'currency', currency: 'INR', maximumFractionDigits: 0,
  }).format(p);
}

function formatArea(row) {
  const val = row.area_value;
  if (val === null || val === undefined || val === '') return '';
  const unit = row.area_unit || '';
  const unitLabel = AREA_UNIT_LABELS[unit] || unit;
  return unitLabel ? `${val} ${unitLabel}` : String(val);
}

function formatBoolean(v) {
  if (v === true || v === 1 || v === '1' || v === 'true' || v === 'yes') return 'Yes';
  if (v === false || v === 0 || v === '0' || v === 'false' || v === 'no') return 'No';
  return '';
}

function stringifyPrimitive(v) {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.filter(Boolean).map(stringifyPrimitive).filter(Boolean).join(', ');
  if (typeof v === 'object') {
    if (v.label) return String(v.label);
    if (v.value) return String(v.value);
    return '';
  }
  return String(v).trim();
}

/**
 * Resolve one field to its display string. `row` is the property row (for
 * columns like area_unit that live outside dynamicData). `propertyKind`
 * disambiguates status master resolution.
 */
async function formatFieldValue(propertyKind, row, field, rawValue) {
  if (rawValue === null || rawValue === undefined || rawValue === '') return '';

  const key = field.key;

  // Special-case top-level economic / geographic fields whose display is
  // not a plain stringify.
  if (key === 'price') return formatPrice(rawValue);
  if (key === 'areaValue') return formatArea(row);
  // Date-only fields (Posting Date, Available From, legacy Registration Date).
  if (key === 'postingDate' || key === 'registrationDate' || key === 'availableFromDate') {
    return formatDate(rawValue);
  }
  // Server-timestamp fields — always render with time in DD/MM/YYYY hh:mm AM/PM.
  if (key === 'createdOn' || key === 'createdAt' || key === 'updatedAt') {
    return formatDateTime(rawValue);
  }
  if (key === 'propertyType') {
    return row.property_type_name
      || row.resolved_property_type_name
      || await resolveMasterLabelByKey('property_type', rawValue);
  }
  if (key === 'transactionType') {
    return row.transaction_type_name
      || row.resolved_transaction_type_name
      || await resolveMasterLabelByKey('transaction_type', rawValue);
  }
  if (key === 'propertyVariety') {
    return row.property_variety_name
      || row.resolved_property_variety_name
      || await resolveMasterLabelByKey('property_variety', rawValue);
  }

  const defaultMK = defaultMasterKeyForField(propertyKind, key);
  const masterKey = field.masterKey || defaultMK;

  // Location cascade sub-fields: use locations.labelsForCodes for the
  // indexed hierarchical vocabulary.
  if (masterKey === 'district' || masterKey === 'taluka' || masterKey === 'shivar') {
    return resolveLocationLabel(masterKey, rawValue);
  }

  // Field-type driven resolution.
  const type = field.type || '';
  if (type === 'date') return formatDate(rawValue);
  if (type === 'checkbox' || type === 'toggle') return formatBoolean(rawValue);
  if (type === 'multiSelect') {
    const arr = Array.isArray(rawValue) ? rawValue : String(rawValue).split(',').map((s) => s.trim()).filter(Boolean);
    if (masterKey) {
      const labels = await Promise.all(arr.map((c) => resolveMasterLabelByKey(masterKey, c)));
      return labels.filter(Boolean).join(', ');
    }
    return arr.join(', ');
  }
  if ((type === 'select' || type === 'radio') && masterKey) {
    return resolveMasterLabelByKey(masterKey, stringifyPrimitive(rawValue));
  }
  if ((type === 'select' || type === 'radio') && !masterKey && typeof rawValue === 'string') {
    // Radio option labels are already human-readable.
    return rawValue;
  }
  if (type === 'dualMode') {
    // dualMode fields store one primitive value at `data[key]` (either the
    // free-text `any` variant or the master `specific` code). We try master
    // resolution when there's a hint; otherwise render as-is.
    if (masterKey) return resolveMasterLabelByKey(masterKey, stringifyPrimitive(rawValue));
    return stringifyPrimitive(rawValue);
  }

  // Special-case status master when no explicit type hint.
  if (key === 'status' && masterKey) {
    return resolveMasterLabelByKey(masterKey, stringifyPrimitive(rawValue));
  }

  return stringifyPrimitive(rawValue);
}

// ── Section rendering ────────────────────────────────────────────────

async function renderSection(propertyKind, row, dyn, details, section) {
  const lines = [];
  const fields = Array.isArray(section && section.fields) ? section.fields : [];
  for (const field of fields) {
    if (!field || !field.key) continue;
    if (isDeniedKey(field.key)) continue;
    const raw = readFieldValue(propertyKind, row, dyn, details, field.key);
    if (raw === undefined || raw === null || raw === '') continue;
    // eslint-disable-next-line no-await-in-loop
    const value = await formatFieldValue(propertyKind, row, field, raw);
    if (value !== null && value !== undefined && String(value).trim() !== '') {
      lines.push({ label: field.label || field.key, value: String(value) });
    }
  }
  return lines;
}

// ── Property URL builder ─────────────────────────────────────────────

function buildPropertyUrl(propertyKind, propertyId) {
  const publicBase = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  const adminBase  = (process.env.ADMIN_PANEL_URL || publicBase || '').replace(/\/$/, '');
  if (propertyKind === 'website') {
    if (publicBase) return `${publicBase}/properties/${propertyId}`;
    if (adminBase)  return `${adminBase}/admin/website-properties/${propertyId}`;
    return null;
  }
  if (adminBase) return `${adminBase}/admin/${propertyKind === 'enquiry' ? 'enquiry' : 'inventory'}/${propertyId}/view`;
  return null;
}

// ── Body renderers ───────────────────────────────────────────────────

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderTextBody({ userMessage, renderedSections, propertyUrl }) {
  const parts = [];
  if (userMessage) parts.push(userMessage);
  for (const section of renderedSections) {
    if (section.lines.length === 0) continue;
    parts.push('');
    parts.push(section.title);
    parts.push('-'.repeat(section.title.length));
    for (const line of section.lines) parts.push(`${line.label}: ${line.value}`);
  }
  if (propertyUrl) {
    parts.push('');
    parts.push(`View property: ${propertyUrl}`);
  }
  return parts.join('\n').replace(/^\n+/, '');
}

function renderHtmlBody({ userMessage, renderedSections, propertyUrl }) {
  const parts = [];
  parts.push('<div style="font-family:Arial,Helvetica,sans-serif;color:#111;font-size:14px;line-height:1.6;">');
  if (userMessage) {
    parts.push(`<p style="white-space:pre-wrap;margin:0 0 16px;">${esc(userMessage)}</p>`);
  }
  for (const section of renderedSections) {
    if (section.lines.length === 0) continue;
    parts.push(`<h3 style="font-size:15px;margin:18px 0 8px;color:#0F172A;">${esc(section.title)}</h3>`);
    parts.push('<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%;max-width:640px;">');
    for (const line of section.lines) {
      parts.push(
        '<tr>'
        + `<td style="padding:6px 12px 6px 0;color:#64748B;vertical-align:top;white-space:nowrap;">${esc(line.label)}</td>`
        + `<td style="padding:6px 0;color:#0F172A;font-weight:600;">${esc(line.value)}</td>`
        + '</tr>',
      );
    }
    parts.push('</table>');
  }
  if (propertyUrl) {
    parts.push(
      `<p style="margin:16px 0 0;"><a href="${esc(propertyUrl)}" style="color:#1A5E90;">View property online</a></p>`,
    );
  }
  parts.push('</div>');
  return parts.join('\n');
}

// ── Attachment collection ────────────────────────────────────────────

async function collectImageAttachments(propertyKind, propertyId) {
  const rows = await propertyFiles.listForProperty(null, propertyKind, propertyId);
  const out = [];
  for (const f of rows) {
    const absolute = path.join(appRoot(), PUBLIC_DIR, f.stored_name);
    try {
      // eslint-disable-next-line no-await-in-loop
      await fsp.access(absolute, fs.constants.R_OK);
      out.push({
        filename: f.original_name || path.basename(absolute),
        path: absolute,
        contentType: f.mime_type || 'application/octet-stream',
      });
    } catch { /* silently skip missing file */ }
  }
  return out;
}

async function collectDocumentAttachments(propertyKind, propertyId) {
  const rows = await documentUpload.listPropertyDocuments(propertyKind, propertyId);
  const out = [];
  for (const f of rows) {
    const absolute = path.join(appRoot(), PRIVATE_DIR, f.stored_name);
    try {
      // eslint-disable-next-line no-await-in-loop
      await fsp.access(absolute, fs.constants.R_OK);
      out.push({
        filename: f.original_name || path.basename(absolute),
        path: absolute,
        contentType: f.mime_type || 'application/octet-stream',
      });
    } catch { /* silently skip missing file */ }
  }
  return out;
}

// ── Legacy (pre-dynamic-sections) rendering path ─────────────────────
// Kept for back-compat with older clients that still send the boolean
// flags instead of a `sections` array. Emits the same "Basic Property"
// block the module produced before the dynamic renderer landed.

async function legacyBuildDetailLines(propertyKind, row) {
  const details = parseDetailsField(row.details);
  const dyn = details.dynamicData || {};
  const genericSection = {
    title: 'Property Details',
    fields: [
      { key: 'propertyCode', label: 'Property ID' },
      { key: 'title', label: 'Title' },
      { key: 'propertyType', label: 'Property Type' },
      { key: 'transactionType', label: 'Transaction Type' },
      { key: 'propertyVariety', label: 'Property Variety' },
      { key: 'status', label: 'Status' },
      { key: 'district', label: 'District' },
      { key: 'taluka', label: 'Taluka' },
      { key: 'shivar', label: 'Village / City' },
      { key: 'location', label: 'Location' },
      { key: 'pincode', label: 'Pincode' },
      { key: 'bhk', label: 'BHK' },
      { key: 'areaValue', label: 'Area' },
      { key: 'price', label: 'Price' },
    ],
  };
  const lines = await renderSection(propertyKind, row, dyn, details, genericSection);
  return lines;
}

// ── Public API ───────────────────────────────────────────────────────

async function shareProperty(propertyKind, propertyId, {
  recipientEmails,
  subject,
  message,
  sections,
  includeDetails = true,
  includeDescription = true,
  includeImages = true,
  includeDocuments = true,
  includePropertyUrl = true,
} = {}) {
  if (!['inventory', 'enquiry', 'website'].includes(propertyKind)) {
    throw new HttpError(400, 'BAD_KIND', 'Invalid property kind');
  }

  const { valid, invalid } = parseRecipients(recipientEmails);
  if (valid.length === 0) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'At least one valid recipient email is required.');
  }

  const row = await loadProperty(propertyKind, propertyId);
  const details = parseDetailsField(row.details);
  const dyn = details.dynamicData || {};

  // Body assembly.
  const userMessage = message && String(message).trim() ? String(message).trim() : '';
  const renderedSections = [];

  if (Array.isArray(sections) && sections.length > 0) {
    // DYNAMIC PATH — one rendered block per section the caller passed.
    for (const section of sections) {
      if (!section || !section.title) continue;
      // eslint-disable-next-line no-await-in-loop
      const lines = await renderSection(propertyKind, row, dyn, details, section);
      renderedSections.push({ title: String(section.title), lines });
    }
  } else {
    // LEGACY PATH — respect the old boolean flags.
    if (includeDetails) {
      const lines = await legacyBuildDetailLines(propertyKind, row);
      renderedSections.push({ title: 'Property Details', lines });
    }
    if (includeDescription && row.description) {
      renderedSections.push({
        title: 'Description',
        lines: [{ label: 'Description', value: String(row.description).trim() }],
      });
    }
  }

  const propertyUrl = includePropertyUrl ? buildPropertyUrl(propertyKind, propertyId) : null;

  const [images, documents] = await Promise.all([
    includeImages    ? collectImageAttachments(propertyKind, propertyId)    : Promise.resolve([]),
    includeDocuments ? collectDocumentAttachments(propertyKind, propertyId) : Promise.resolve([]),
  ]);
  const attachments = [...images, ...documents];

  const finalSubject = subject && String(subject).trim()
    ? String(subject).trim()
    : `Property Details - ${row.title || row.property_code || 'Property'}`;

  const text = renderTextBody({ userMessage, renderedSections, propertyUrl });
  const html = renderHtmlBody({ userMessage, renderedSections, propertyUrl });

  const transporter = emailer.getTransporter();
  const from = (function buildFrom() {
    if (process.env.SMTP_FROM) return process.env.SMTP_FROM;
    const name  = process.env.SMTP_FROM_NAME;
    const email = process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER;
    if (email && name) return `"${name}" <${email}>`;
    if (email) return email;
    return 'no-reply@example.com';
  }());

  try {
    await transporter.sendMail({
      from,
      to: valid.join(', '),
      subject: finalSubject,
      text: text || undefined,
      html: html || undefined,
      attachments: attachments.length > 0 ? attachments : undefined,
    });
  } catch (err) {
    const code = err.code || err.responseCode;
    const rawMessage = err.message || 'Unknown SMTP error';
    if (code === 'EAUTH' || code === 535) {
      throw new HttpError(502, 'SMTP_AUTH_FAILED', 'SMTP authentication failed. Please check the mail credentials and try again.');
    }
    if (code === 'ECONNECTION' || code === 'ESOCKET' || code === 'ETIMEDOUT' || code === 'EDNS') {
      throw new HttpError(502, 'SMTP_UNAVAILABLE', 'SMTP unavailable. Could not reach the mail server.');
    }
    throw new HttpError(502, 'EMAIL_SEND_FAILED', `Failed to send email: ${rawMessage}`);
  }

  return {
    sentTo: valid,
    skipped: invalid,
    attachmentCount: attachments.length,
    sectionsRendered: renderedSections.filter((s) => s.lines.length > 0).map((s) => s.title),
  };
}

module.exports = { shareProperty, parseRecipients, isDeniedKey };
