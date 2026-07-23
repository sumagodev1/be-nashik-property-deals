const crypto = require('crypto');
const fsp = require('fs/promises');
const path = require('path');
const { HttpError } = require('../../middleware/errors');
const { pool } = require('../../db/pool');
const inventory = require('../../db/queries/inventory_properties');
const propertyFiles = require('../../db/queries/property_files');
const storageUsage = require('../../db/queries/storage_usage');
const imageUpload = require('../files/imageUpload');
const documentUpload = require('../files/documentUpload');
const excel = require('../files/excel');
const { buildTablePdf } = require('../files/pdf');
const csvUtil = require('../files/csv');
const { getBrandingSnapshot } = require('../files/branding');
const locationsQuery = require('../../db/queries/locations');
const INVENTORY_STATUS_LABELS = {
  available: 'Available', sold: 'Sold', rented: 'Rented',
  under_offer: 'Under Offer', on_hold: 'On Hold', pending: 'Pending',
  inactive: 'Inactive',
};
const { assignUniqueCode } = require('../properties/propertyCode');
const masters = require('../masters/management');
// Centralised Property Type / Transaction Type / Property Variety
// validator. Every service that persists a property MUST use this so the
// three fields cannot be miswired to the wrong master (see the module
// header for the incident this prevents).
const { validatePropertyClassification } = require('../masters/propertyMasters');
// Fix D (T-2026-057): dependency-driven cross-master validation. The
// FE chooser guarantees only (PT, TT, PV) triples registered in the
// tree are submitted; this backend guard logs a warning if the two
// catalogs drift (permissive — the record still saves so pre-catalog
// records and legacy edits keep working).
const formCodeCatalog = require('../../constants/formCodeCatalog');
// Fix E (T-2026-058): DB-authoritative dependency validator. Uses
// master_property_forms (migration 063) as the source of truth and
// falls back to the JS catalog above when the DB table hasn't been
// seeded yet. Same call shape — the save path swaps in-place.
const propertyFormCatalog = require('../masters/propertyFormCatalog');

async function validateMasterCodes(payload) {
  // Property Type + Transaction Type + Property Variety (carried on
  // payload.transactionVariant) — pinned to their own masters by the
  // centralised helper. Do not inline these three checks here.
  await validatePropertyClassification(payload);
  await masters.assertActiveCode('flat_type', payload.bhk);
  await masters.assertActiveCode('status_type', payload.status);
  // Hierarchical location masters — only validated when supplied.
  await masters.assertActiveCode('district', payload.district);
  await masters.assertActiveCode('taluka', payload.taluka);
  await masters.assertActiveCode('shivar', payload.shivar);

  // Fix E (T-2026-058): cross-master dependency check backed by the
  // DB (`master_property_forms`). Falls back to the JS catalog when
  // the table is empty (still-migrating install). Log-only so legacy
  // edits and pre-catalog records keep saving; strict mode can be
  // enabled later if desired. Non-fatal on any error — a broken DB
  // connection here must not block a property save that would
  // otherwise succeed.
  try {
    await propertyFormCatalog.validateCombination({
      mode: 'inventory',
      propertyType: payload.propertyTypeName || payload.propertyType,
      transactionType: payload.transactionType,
      propertyVariety: payload.propertyVarietyName || payload.transactionVariant,
      label: 'inventory.save',
    });
  } catch (_e) {
    formCodeCatalog.validateCombination({
      propertyType: payload.propertyTypeName || payload.propertyType,
      transactionType: payload.transactionType,
      propertyVariety: payload.propertyVarietyName || payload.transactionVariant,
      label: 'inventory.save.fallback',
    });
  }
}

const { PUBLIC_URL_PREFIX } = require('../files/publicUrl');

// T-2026-072: Every export format (PDF / XLSX / CSV) uses this ONE column
// set. Mirrors the admin list-page columns exactly — no monetary columns
// (Price / Budget), no internal columns (is_draft, area/bhk, contact
// numbers). The single source of truth means CSV/XLSX/PDF always agree
// with what the admin sees on the screen, per the "no hidden data" rule.
const INVENTORY_EXPORT_COLUMNS = [
  { key: 'property_code',   label: 'Property ID',      align: 'left',   width: 16, weight: 2.0, noWrap: true, type: 's' },
  { key: 'title',           label: 'Title',            align: 'left',   width: 30, weight: 2.6 },
  { key: 'property_type',   label: 'Property Type',    align: 'left',   width: 18, weight: 1.6, noWrap: true },
  { key: 'transaction_type', label: 'Transaction',     align: 'left',   width: 16, weight: 1.4, noWrap: true },
  { key: 'property_variety', label: 'Property Variety', align: 'left',  width: 18, weight: 1.6, noWrap: true },
  { key: 'district',        label: 'District',         align: 'left',   width: 14, weight: 1.2, noWrap: true },
  { key: 'taluka',          label: 'Taluka',           align: 'left',   width: 14, weight: 1.2, noWrap: true },
  { key: 'village',         label: 'Village / City',   align: 'left',   width: 14, weight: 1.2, noWrap: true },
  { key: 'status',          label: 'Status',           align: 'center', width: 12, weight: 1.0, noWrap: true, headerAlign: 'center' },
  { key: 'owner_name',      label: 'Owner',            align: 'left',   width: 18, weight: 1.6 },
  { key: 'agent_name',      label: 'Agent',            align: 'left',   width: 18, weight: 1.4 },
  { key: 'created_at',      label: 'Created Date',     align: 'center', width: 14, weight: 1.2, noWrap: true, headerAlign: 'center' },
];

// Compat shim: legacy CSV endpoint used a raw string-array shape. Keep the
// header/value helpers as compatibility names so nothing else in this file
// (if any) breaks — but every export now goes through the shared column set
// above via `inventoryRowFromExportColumns`.
const INVENTORY_HEADERS = INVENTORY_EXPORT_COLUMNS.map((c) => c.label);
function inventoryRowValues(r) {
  return INVENTORY_EXPORT_COLUMNS.map((c) => renderInventoryCell(r, c.key));
}

function renderInventoryCell(r, key) {
  switch (key) {
    case 'property_code':    return r.property_code || '';
    case 'title':            return r.title || '';
    case 'property_type':    return r.resolved_property_type_name    || r.property_type_name    || r.property_type    || '';
    case 'transaction_type': return r.resolved_transaction_type_name || r.transaction_type_name || r.transaction_type || '';
    case 'property_variety': return r.resolved_property_variety_name || r.property_variety_name || r.transaction_variant || '';
    case 'status':           return INVENTORY_STATUS_LABELS[r.status] || r.status || '';
    case 'owner_name':       return r.owner_name || '';
    case 'agent_name':       return r.agent_name || '';
    case 'created_at':       return formatDate(r.created_at);
    // District/Taluka/Village labels resolved via enrichRowsWithLocationLabels below.
    case 'district':         return r._districtLabel || r.district || '';
    case 'taluka':           return r._talukaLabel   || r.taluka   || '';
    case 'village':          return r._shivarLabel   || r.shivar   || '';
    default:                 return '';
  }
}

// Batch-resolve district/taluka/shivar codes → labels, then attach as
// underscore-prefixed fields on each row so renderInventoryCell can pick
// them up without re-querying.
async function enrichRowsWithLocationLabels(rows) {
  const uniq = (arr) => Array.from(new Set(arr.filter(Boolean).map(String)));
  const [districts, talukas, shivars] = await Promise.all([
    locationsQuery.labelsForCodes('district', uniq(rows.map((r) => r.district))).catch(() => []),
    locationsQuery.labelsForCodes('taluka',   uniq(rows.map((r) => r.taluka))).catch(() => []),
    locationsQuery.labelsForCodes('shivar',   uniq(rows.map((r) => r.shivar))).catch(() => []),
  ]);
  const dMap = Object.fromEntries((districts || []).map((r) => [r.code, r.label]));
  const tMap = Object.fromEntries((talukas   || []).map((r) => [r.code, r.label]));
  const sMap = Object.fromEntries((shivars   || []).map((r) => [r.code, r.label]));
  return rows.map((r) => ({
    ...r,
    _districtLabel: r.district ? (dMap[r.district] || r.district) : '',
    _talukaLabel:   r.taluka   ? (tMap[r.taluka]   || r.taluka)   : '',
    _shivarLabel:   r.shivar   ? (sMap[r.shivar]   || r.shivar)   : '',
  }));
}

function buildInventorySummaryCards(rows) {
  const counts = { available: 0, sold: 0, rented: 0 };
  for (const r of rows) {
    if (counts[r.status] != null) counts[r.status] += 1;
  }
  return [
    { label: 'Total Records', value: String(rows.length) },
    { label: 'Available',     value: String(counts.available) },
    { label: 'Sold',          value: String(counts.sold) },
    { label: 'Rented',        value: String(counts.rented) },
  ];
}

async function buildInventoryFilterChips(filters) {
  const chips = [];
  if (filters.search)       chips.push({ label: 'Search',       value: filters.search });
  if (filters.ownerSearch)  chips.push({ label: 'Owner Search', value: filters.ownerSearch });
  if (filters.status)       chips.push({ label: 'Status',       value: INVENTORY_STATUS_LABELS[filters.status] || filters.status });
  if (filters.propertyType) chips.push({ label: 'Property Type', value: filters.propertyType });
  if (filters.transactionType) chips.push({ label: 'Transaction', value: filters.transactionType });
  if (filters.transactionVariant) chips.push({ label: 'Variety',   value: filters.transactionVariant });
  // Resolve district/taluka/shivar to labels for the chip strip.
  const needed = [];
  if (filters.district) needed.push({ k: 'district', key: 'District', code: filters.district });
  if (filters.taluka)   needed.push({ k: 'taluka',   key: 'Taluka',   code: filters.taluka   });
  if (filters.shivar)   needed.push({ k: 'shivar',   key: 'Village',  code: filters.shivar   });
  if (needed.length > 0) {
    const byKey = {};
    for (const n of needed) (byKey[n.k] ||= []).push(n.code);
    const labelMaps = {};
    await Promise.all(Object.entries(byKey).map(async ([mk, codes]) => {
      const rows = await locationsQuery.labelsForCodes(mk, codes).catch(() => []);
      labelMaps[mk] = Object.fromEntries((rows || []).map((r) => [r.code, r.label]));
    }));
    for (const n of needed) chips.push({ label: n.key, value: (labelMaps[n.k] && labelMaps[n.k][n.code]) || n.code });
  }
  if (filters.dateFrom || filters.dateTo) {
    chips.push({ label: 'Date', value: (filters.dateFrom || 'earliest') + ' to ' + (filters.dateTo || 'today') });
  }
  return chips;
}

function exportedByLabel(auth) {
  if (!auth) return 'Administrator';
  return auth.name || auth.email || (auth.role === 'admin' ? 'Administrator' : 'Sub Admin');
}

function csvField(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

async function listProperties(query) {
  const { rows, total } = await inventory.list(query);
  return {
    data: rows.map(toListItem),
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
  };
}

async function getProperty(id) {
  const row = await inventory.findById(id);
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Property not found');
  const [images, documents] = await Promise.all([
    propertyFiles.listForProperty(null, 'inventory', id),
    documentUpload.listPropertyDocuments('inventory', id),
  ]);
  return toDetail(row, images, documents);
}

async function createProperty(payload) {
  await validateMasterCodes(payload);
  // property_code is UNIQUE in MySQL. Insert with a UUID placeholder so
  // concurrent creates can never collide on the constraint, then assign
  // the final NSK-<TYPE>-YY-XXXXXXX code with retry-on-collision.
  const tmpCode = `TMP-${crypto.randomUUID()}`;
  const id = await inventory.create({ ...payload, propertyCode: tmpCode });
  await assignUniqueCode(payload.propertyType, async (code) => {
    try {
      await inventory.updatePropertyCode(id, code);
      return true;
    } catch (err) {
      if (err && err.code === 'ER_DUP_ENTRY') return false;
      throw err;
    }
  });
  return getProperty(id);
}

async function updateProperty(id, payload) {
  await validateMasterCodes(payload);
  const existing = await inventory.findById(id);
  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Property not found');
  await inventory.update(id, payload);
  // Code format is independent of draft state — the UI surfaces draft
  // separately via the is_draft column, so no renaming on toggle.
  return getProperty(id);
}

async function updateStatus(id, status, note, changedBy) {
  await masters.assertActiveCode('status_type', status);
  const existing = await inventory.findById(id);
  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Property not found');
  await inventory.updateStatus(id, status, note, changedBy);
  return getProperty(id);
}

async function removeProperty(id) {
  const existing = await inventory.findById(id);
  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Property not found');

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Delete all property_files rows (images + documents + amenity thumbnails)
    // and adjust the storage quota counter atomically with the soft-delete so
    // no orphan file rows survive a successful delete.
    const removed = await propertyFiles.deleteAllForProperty(conn, 'inventory', id);
    const totalBytes = removed.reduce((acc, r) => acc + Number(r.size_bytes), 0);
    if (totalBytes > 0) await storageUsage.subtractBytes(conn, totalBytes);

    await inventory.softDeleteForConn(conn, id);
    await conn.commit();

    // Physical file removal happens after commit — a failure here leaves
    // unreferenced files on disk but the DB is consistent (no orphan rows).
    const appRoot = path.resolve(__dirname, '..', '..', '..');
    const publicDir = process.env.UPLOAD_PUBLIC_DIR || 'uploads/public';
    const privateDir = process.env.UPLOAD_PRIVATE_DIR || 'uploads/private';
    // stored_name already encodes '${propertyKind}/filename', so join with base dir only (not base + propertyKind).
    await Promise.all(
      removed.map((r) => {
        const dir = r.file_kind === 'document' ? privateDir : publicDir;
        return fsp.unlink(path.join(appRoot, dir, r.stored_name)).catch(() => {});
      }),
    );
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

async function addImages(id, files) {
  const existing = await inventory.findById(id);
  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Property not found');
  await imageUpload.persistImages({ propertyKind: 'inventory', propertyId: id, files });
  return getProperty(id);
}

async function removeImage(id, fileId) {
  const existing = await inventory.findById(id);
  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Property not found');
  await imageUpload.deleteImage({ fileId, propertyKind: 'inventory', propertyId: id });
  return getProperty(id);
}

async function addDocuments(id, files) {
  const existing = await inventory.findById(id);
  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Property not found');
  await documentUpload.persistPropertyDocuments({ propertyKind: 'inventory', propertyId: id, files });
  return getProperty(id);
}

async function removeDocument(id, fileId) {
  const existing = await inventory.findById(id);
  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Property not found');
  await documentUpload.deletePropertyDocument({ fileId, propertyKind: 'inventory', propertyId: id });
  return getProperty(id);
}

async function listDocuments(id) {
  return documentUpload.listPropertyDocuments('inventory', id);
}

async function findDocument(fileId) {
  return propertyFiles.findById(null, fileId);
}

async function streamDocument(res, file) {
  return documentUpload.streamPropertyDocument(res, file);
}

function toListItem(row) {
  // Mirrors every column returned by the list SQL projection so callers can
  // reconstruct the record without a second fetch. `details` is JSON.parsed
  // so `dynamicData` and any nested MD-form fields are directly accessible.
  return {
    id: row.id,
    propertyCode: row.property_code,
    registrationDate: row.registration_date,
    title: row.title,
    description: row.description ?? null,
    propertyType: row.property_type,
    // T-2026-055: {id, name} pair columns echoed verbatim so the FE
    // renders the stored master identity captured from the pre-form
    // chooser at creation time. NEVER derived from title/form-code/
    // heading/name/route. Legacy rows created before T-2026-055 have
    // nulls here; the FE falls back to the masters lookup so historical
    // records keep rendering correctly.
    propertyTypeId: row.property_type_id ?? null,
    // Fix C (T-2026-057): prefer the resolved name from the LIST SQL's
    // LEFT JOIN over the persisted snapshot column. `resolved_property_type_name`
    // is COALESCE(persisted_snapshot, master_by_id.label, master_by_code.label),
    // so pre-T-2026-055 rows with NULL snapshots still render a human label.
    // Falls back to the persisted snapshot when the LIST SQL isn't the
    // source of this row (e.g. a raw findById() call further down); falls
    // back to null if both are NULL.
    propertyTypeName: row.resolved_property_type_name ?? row.property_type_name ?? null,
    transactionType: row.transaction_type,
    transactionTypeId: row.transaction_type_id ?? null,
    transactionTypeName: row.resolved_transaction_type_name ?? row.transaction_type_name ?? null,
    transactionVariant: row.transaction_variant ?? null,
    propertyVarietyId: row.property_variety_id ?? null,
    propertyVarietyName: row.resolved_property_variety_name ?? row.property_variety_name ?? null,
    location: row.location,
    district: row.district ?? null,
    taluka: row.taluka ?? null,
    shivar: row.shivar ?? null,
    latitude: row.latitude !== null && row.latitude !== undefined ? Number(row.latitude) : null,
    longitude: row.longitude !== null && row.longitude !== undefined ? Number(row.longitude) : null,
    // T-2026-048: reverse-geocoded human-readable address paired with lat/lng.
    formattedAddress: row.formatted_address ?? null,
    pincode: row.pincode ?? null,
    areaValue: row.area_value !== null ? Number(row.area_value) : null,
    areaUnit: row.area_unit,
    bhk: row.bhk,
    price: Number(row.price),
    status: row.status,
    statusNote: row.status_note ?? null,
    statusChangedAt: row.status_changed_at ?? null,
    isDraft: Boolean(row.is_draft),
    ownerName: row.owner_name,
    ownerContact: row.owner_contact,
    agentName: row.agent_name,
    agentContact: row.agent_contact,
    // Every field the admin filled in on the registration form — including
    // the entire dynamicData blob for MD-engine variants — is included so
    // the frontend can render or export the record without a per-row detail
    // fetch. `undefined` when the list SQL didn't select `details`.
    details: row.details !== undefined ? parseDetailsField(row.details) : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Search-as-you-type. Returns up to `limit` rows ordered by recency, with
 * a tight column set suitable for a typeahead dropdown.
 */
async function suggest({ q, limit = 8, includeDrafts = false }) {
  const { pool } = require('../../db/pool');
  const where = ['deleted_at IS NULL'];
  const params = [];
  if (!includeDrafts) where.push('is_draft = 0');
  if (q && q.trim()) {
    // Autocomplete surface — mirrors the list-search field set exactly so
    // a JSON-blob dynamic-form match (facing, parking, layout, amenities,
    // hospital/hotel/hostel/PG/TDR/… specifics) shows up in the dropdown,
    // not only after the debounced list refetch. Same OR-list + params
    // order + owner/contact exclusion as db/queries/inventory_properties.js
    // ::list (JSON_REMOVE strips contacts / keyPersons / Source of Lead).
    where.push(`(
      property_code LIKE ? OR title LIKE ? OR description LIKE ?
      OR location LIKE ?
      OR property_type LIKE ? OR transaction_type LIKE ? OR transaction_variant LIKE ?
      OR status LIKE ? OR status_note LIKE ?
      OR district LIKE ? OR taluka LIKE ? OR shivar LIKE ? OR pincode LIKE ?
      OR bhk LIKE ? OR area_unit LIKE ?
      OR CAST(price AS CHAR) LIKE ? OR CAST(area_value AS CHAR) LIKE ?
      OR CAST(JSON_REMOVE(details, '$.dynamicData.contacts', '$.dynamicData.keyPersons', '$.dynamicData.referenceSourceOfLead') AS CHAR) LIKE ?
    )`);
    const s = `%${q.trim()}%`;
    for (let i = 0; i < 18; i++) params.push(s);
  }
  const [rows] = await pool.query(
    `SELECT id, property_code, title, location, property_type, transaction_type, price, status, is_draft
     FROM inventory_properties
     WHERE ${where.join(' AND ')}
     ORDER BY created_at DESC, id DESC
     LIMIT ?`,
    [...params, Math.min(20, Math.max(1, limit))],
  );
  return rows.map((r) => ({
    id: r.id,
    propertyCode: r.property_code,
    title: r.title,
    location: r.location,
    propertyType: r.property_type,
    transactionType: r.transaction_type,
    price: Number(r.price),
    status: r.status,
    isDraft: Boolean(r.is_draft),
  }));
}

// MySQL's JSON column comes back as either a string (older drivers) or a
// parsed object (newer drivers). Normalise to a plain object so the frontend
// always sees the same shape.
function parseDetailsField(raw) {
  if (raw === null || raw === undefined) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw) || {}; } catch { return {}; }
}

function toDetail(row, images, documents = []) {
  return {
    ...toListItem(row),
    description: row.description,
    isDraft: Boolean(row.is_draft),
    details: parseDetailsField(row.details),
    images: images.map((f) => ({
      id: f.id,
      url: `${PUBLIC_URL_PREFIX}/${f.stored_name}`,
      originalName: f.original_name,
      mimeType: f.mime_type,
      sizeBytes: Number(f.size_bytes),
      sortOrder: f.sort_order,
    })),
    documents: documents.map((f) => ({
      id: f.id,
      // Documents are private — caller fetches via /admin/inventory-properties/:id/documents/:fileId
      downloadPath: `/admin/inventory-properties/${row.id}/documents/${f.id}`,
      originalName: f.original_name,
      mimeType: f.mime_type,
      sizeBytes: Number(f.size_bytes),
    })),
  };
}

function formatDate(d) {
  if (!d) return '';
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return String(d);
  return date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

// T-2026-072: all three export functions now accept `context` = { auth }
// so the branded PDF header can render "Generated By" + branding pulled
// from CMS settings. Backwards-compatible: callers that don't pass a
// context still get a valid export (defaults kick in).

async function exportCsv(filters, context = {}) {
  const { rows: raw } = await inventory.list({ ...filters, page: 1, pageSize: 100000 });
  const rows = await enrichRowsWithLocationLabels(raw);
  return csvUtil.buildCsvFromColumns({
    columns: INVENTORY_EXPORT_COLUMNS.map((c) => ({
      label: c.label,
      key: c.key,
      render: (row) => renderInventoryCell(row, c.key),
    })),
    rows,
  });
}

async function exportXlsx(filters, context = {}) {
  const { rows: raw } = await inventory.list({ ...filters, page: 1, pageSize: 100000 });
  const rows = await enrichRowsWithLocationLabels(raw);
  return excel.buildWorkbookFromColumns({
    sheetName: 'Inventory Properties',
    columns: INVENTORY_EXPORT_COLUMNS.map((c) => ({
      label: c.label,
      key: c.key,
      type: c.type || 's',
      width: c.width,
      render: (row) => renderInventoryCell(row, c.key),
    })),
    rows,
  });
}

async function exportPdf(filters, context = {}) {
  const { rows: raw } = await inventory.list({ ...filters, page: 1, pageSize: 100000 });
  const rows = await enrichRowsWithLocationLabels(raw);
  const [branding, filterChips] = await Promise.all([
    getBrandingSnapshot(),
    buildInventoryFilterChips(filters || {}),
  ]);
  return buildTablePdf({
    title: 'Inventory Properties Report',
    subtitle: `${rows.length} record${rows.length === 1 ? '' : 's'}`,
    columns: INVENTORY_EXPORT_COLUMNS,
    rows: rows.map((r) => {
      const out = {};
      for (const c of INVENTORY_EXPORT_COLUMNS) out[c.key] = renderInventoryCell(r, c.key);
      return out;
    }),
    branding,
    exportedBy: exportedByLabel(context.auth),
    summaryCards: buildInventorySummaryCards(rows),
    filterChips,
    emptyMessage: 'No records found for the selected filters.',
  });
}

module.exports = {
  listProperties,
  getProperty,
  createProperty,
  updateProperty,
  updateStatus,
  removeProperty,
  addImages,
  removeImage,
  addDocuments,
  removeDocument,
  listDocuments,
  findDocument,
  streamDocument,
  suggest,
  exportCsv,
  exportXlsx,
  exportPdf,
};
