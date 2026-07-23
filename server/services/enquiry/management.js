const crypto = require('crypto');
const fsp = require('fs/promises');
const path = require('path');
const { HttpError } = require('../../middleware/errors');
const { pool } = require('../../db/pool');
const enquiry = require('../../db/queries/enquiry_properties');
const propertyFiles = require('../../db/queries/property_files');
const storageUsage = require('../../db/queries/storage_usage');
const imageUpload = require('../files/imageUpload');
const documentUpload = require('../files/documentUpload');
const excel = require('../files/excel');
const { buildTablePdf } = require('../files/pdf');
const csvUtil = require('../files/csv');
const { getBrandingSnapshot } = require('../files/branding');
const locationsQuery = require('../../db/queries/locations');
const ENQUIRY_STATUS_LABELS = {
  available: 'Available', sold: 'Sold', rented: 'Rented',
  under_offer: 'Under Offer', on_hold: 'On Hold', pending: 'Pending',
  inactive: 'Inactive',
};
const { assignUniqueCode } = require('../properties/propertyCode');
const masters = require('../masters/management');
// Centralised Property Type / Transaction Type / Property Variety
// validator — see services/masters/propertyMasters.js for the contract.
const { validatePropertyClassification } = require('../masters/propertyMasters');
// Fix D (T-2026-057): same cross-master dependency validator inventory
// uses. See inventory/management.js for the full explanation.
const formCodeCatalog = require('../../constants/formCodeCatalog');
// Fix E (T-2026-058): DB-authoritative dependency validator.
const propertyFormCatalog = require('../masters/propertyFormCatalog');

// Structural mirror of services/inventory/management.js — every function has
// the same signature and same downstream behaviour. Only the data source
// (enquiry_properties table via db/queries/enquiry_properties) and the file
// namespace (propertyKind='enquiry' for uploads/downloads) differ.
//
// Kept as a parallel module rather than a factory so a search for the
// enquiry code path lands directly, and so future divergence (e.g. if the
// Enquiry surface grows fields the Inventory surface does not) can happen
// here without dragging the sister module along.

async function validateMasterCodes(payload) {
  // Property Type + Transaction Type + Property Variety (carried on
  // payload.transactionVariant) — pinned to their own masters by the
  // centralised helper. Do not inline these three checks here.
  await validatePropertyClassification(payload);
  await masters.assertActiveCode('flat_type', payload.bhk);
  await masters.assertActiveCode('status_type', payload.status);
  await masters.assertActiveCode('district', payload.district);
  await masters.assertActiveCode('taluka', payload.taluka);
  await masters.assertActiveCode('shivar', payload.shivar);

  // Fix E (T-2026-058): DB-authoritative validator with JS fallback.
  // See inventory/management.js for the full contract.
  try {
    await propertyFormCatalog.validateCombination({
      mode: 'enquiry',
      propertyType: payload.propertyTypeName || payload.propertyType,
      transactionType: payload.transactionType,
      propertyVariety: payload.propertyVarietyName || payload.transactionVariant,
      label: 'enquiry.save',
    });
  } catch (_e) {
    formCodeCatalog.validateCombination({
      propertyType: payload.propertyTypeName || payload.propertyType,
      transactionType: payload.transactionType,
      propertyVariety: payload.propertyVarietyName || payload.transactionVariant,
      label: 'enquiry.save.fallback',
    });
  }
}

const { PUBLIC_URL_PREFIX } = require('../files/publicUrl');

const ENQUIRY_HEADERS = [
  'property_code', 'is_draft', 'status', 'title', 'property_type', 'transaction_type',
  'location', 'bhk', 'area_value', 'area_unit', 'price',
  'owner_name', 'owner_contact', 'agent_name', 'agent_contact',
  'created_at', 'updated_at',
];

function enquiryRowValues(r) {
  return [
    r.property_code,
    r.is_draft ? 'yes' : 'no',
    r.status,
    r.title,
    r.property_type,
    r.transaction_type,
    r.location || '',
    r.bhk || '',
    r.area_value !== null && r.area_value !== undefined ? Number(r.area_value) : '',
    r.area_unit || '',
    Number(r.price) || 0,
    r.owner_name || '',
    r.owner_contact || '',
    r.agent_name || '',
    r.agent_contact || '',
    r.created_at,
    r.updated_at,
  ];
}

function csvField(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

async function listProperties(query) {
  const { rows, total } = await enquiry.list(query);
  return {
    data: rows.map(toListItem),
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
  };
}

async function getProperty(id) {
  const row = await enquiry.findById(id);
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Property not found');
  const [images, documents] = await Promise.all([
    propertyFiles.listForProperty(null, 'enquiry', id),
    documentUpload.listPropertyDocuments('enquiry', id),
  ]);
  return toDetail(row, images, documents);
}

async function createProperty(payload) {
  await validateMasterCodes(payload);
  const tmpCode = `TMP-${crypto.randomUUID()}`;
  const id = await enquiry.create({ ...payload, propertyCode: tmpCode });
  await assignUniqueCode(payload.propertyType, async (code) => {
    try {
      await enquiry.updatePropertyCode(id, code);
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
  const existing = await enquiry.findById(id);
  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Property not found');
  await enquiry.update(id, payload);
  return getProperty(id);
}

async function updateStatus(id, status, note, changedBy) {
  await masters.assertActiveCode('status_type', status);
  const existing = await enquiry.findById(id);
  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Property not found');
  await enquiry.updateStatus(id, status, note, changedBy);
  return getProperty(id);
}

async function removeProperty(id) {
  const existing = await enquiry.findById(id);
  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Property not found');

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Delete all property_files rows (images + documents + amenity thumbnails)
    // and adjust the storage quota counter atomically with the soft-delete so
    // no orphan file rows survive a successful delete.
    const removed = await propertyFiles.deleteAllForProperty(conn, 'enquiry', id);
    const totalBytes = removed.reduce((acc, r) => acc + Number(r.size_bytes), 0);
    if (totalBytes > 0) await storageUsage.subtractBytes(conn, totalBytes);

    await enquiry.softDeleteForConn(conn, id);
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
  const existing = await enquiry.findById(id);
  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Property not found');
  await imageUpload.persistImages({ propertyKind: 'enquiry', propertyId: id, files });
  return getProperty(id);
}

async function removeImage(id, fileId) {
  const existing = await enquiry.findById(id);
  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Property not found');
  await imageUpload.deleteImage({ fileId, propertyKind: 'enquiry', propertyId: id });
  return getProperty(id);
}

async function addDocuments(id, files) {
  const existing = await enquiry.findById(id);
  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Property not found');
  await documentUpload.persistPropertyDocuments({ propertyKind: 'enquiry', propertyId: id, files });
  return getProperty(id);
}

async function removeDocument(id, fileId) {
  const existing = await enquiry.findById(id);
  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Property not found');
  await documentUpload.deletePropertyDocument({ fileId, propertyKind: 'enquiry', propertyId: id });
  return getProperty(id);
}

async function listDocuments(id) {
  return documentUpload.listPropertyDocuments('enquiry', id);
}

async function findDocument(fileId) {
  return propertyFiles.findById(null, fileId);
}

async function streamDocument(res, file) {
  return documentUpload.streamPropertyDocument(res, file);
}

function toListItem(row) {
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
    // Fix C (T-2026-057): prefer the LIST-SQL COALESCE result over the
    // persisted snapshot column so legacy rows (NULL snapshots) still
    // render a human label. See inventory/management.js for the parallel
    // explanation — this file mirrors that decision.
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
    details: row.details !== undefined ? parseDetailsField(row.details) : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function suggest({ q, limit = 8, includeDrafts = false }) {
  const { pool } = require('../../db/pool');
  const where = ['deleted_at IS NULL'];
  const params = [];
  if (!includeDrafts) where.push('is_draft = 0');
  if (q && q.trim()) {
    // Autocomplete surface — mirrors the enquiry list-search field set
    // exactly, including the owner/contact exclusion via JSON_REMOVE.
    // Same OR-list + params order as db/queries/enquiry_properties.js::list.
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
     FROM enquiry_properties
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
      downloadPath: `/admin/enquiry-properties/${row.id}/documents/${f.id}`,
      originalName: f.original_name,
      mimeType: f.mime_type,
      sizeBytes: Number(f.size_bytes),
    })),
  };
}

// T-2026-072: Mirror of Inventory's export pipeline. Same shared column
// set + branded PDF + shared CSV (UTF-8 BOM) + Excel with widths/typing.
// No monetary columns per UI mirror rule.
const ENQUIRY_EXPORT_COLUMNS = [
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

function formatDate(d) {
  if (!d) return '';
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return String(d);
  return date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function renderEnquiryCell(r, key) {
  switch (key) {
    case 'property_code':    return r.property_code || '';
    case 'title':            return r.title || '';
    case 'property_type':    return r.resolved_property_type_name    || r.property_type_name    || r.property_type    || '';
    case 'transaction_type': return r.resolved_transaction_type_name || r.transaction_type_name || r.transaction_type || '';
    case 'property_variety': return r.resolved_property_variety_name || r.property_variety_name || r.transaction_variant || '';
    case 'status':           return ENQUIRY_STATUS_LABELS[r.status] || r.status || '';
    case 'owner_name':       return r.owner_name || '';
    case 'agent_name':       return r.agent_name || '';
    case 'created_at':       return formatDate(r.created_at);
    case 'district':         return r._districtLabel || r.district || '';
    case 'taluka':           return r._talukaLabel   || r.taluka   || '';
    case 'village':          return r._shivarLabel   || r.shivar   || '';
    default:                 return '';
  }
}

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

function buildEnquirySummaryCards(rows) {
  const counts = { available: 0, sold: 0, rented: 0 };
  for (const r of rows) if (counts[r.status] != null) counts[r.status] += 1;
  return [
    { label: 'Total Records', value: String(rows.length) },
    { label: 'Available',     value: String(counts.available) },
    { label: 'Sold',          value: String(counts.sold) },
    { label: 'Rented',        value: String(counts.rented) },
  ];
}

async function buildEnquiryFilterChips(filters) {
  const chips = [];
  if (filters.search)       chips.push({ label: 'Search',       value: filters.search });
  if (filters.ownerSearch)  chips.push({ label: 'Owner Search', value: filters.ownerSearch });
  if (filters.status)       chips.push({ label: 'Status',       value: ENQUIRY_STATUS_LABELS[filters.status] || filters.status });
  if (filters.propertyType) chips.push({ label: 'Property Type', value: filters.propertyType });
  if (filters.transactionType) chips.push({ label: 'Transaction', value: filters.transactionType });
  if (filters.transactionVariant) chips.push({ label: 'Variety',   value: filters.transactionVariant });
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

async function exportCsv(filters, context = {}) {
  const { rows: raw } = await enquiry.list({ ...filters, page: 1, pageSize: 100000 });
  const rows = await enrichRowsWithLocationLabels(raw);
  return csvUtil.buildCsvFromColumns({
    columns: ENQUIRY_EXPORT_COLUMNS.map((c) => ({
      label: c.label,
      key: c.key,
      render: (row) => renderEnquiryCell(row, c.key),
    })),
    rows,
  });
}

async function exportXlsx(filters, context = {}) {
  const { rows: raw } = await enquiry.list({ ...filters, page: 1, pageSize: 100000 });
  const rows = await enrichRowsWithLocationLabels(raw);
  return excel.buildWorkbookFromColumns({
    sheetName: 'Enquiry Properties',
    columns: ENQUIRY_EXPORT_COLUMNS.map((c) => ({
      label: c.label,
      key: c.key,
      type: c.type || 's',
      width: c.width,
      render: (row) => renderEnquiryCell(row, c.key),
    })),
    rows,
  });
}

async function exportPdf(filters, context = {}) {
  const { rows: raw } = await enquiry.list({ ...filters, page: 1, pageSize: 100000 });
  const rows = await enrichRowsWithLocationLabels(raw);
  const [branding, filterChips] = await Promise.all([
    getBrandingSnapshot(),
    buildEnquiryFilterChips(filters || {}),
  ]);
  return buildTablePdf({
    title: 'Enquiry Properties Report',
    subtitle: `${rows.length} record${rows.length === 1 ? '' : 's'}`,
    columns: ENQUIRY_EXPORT_COLUMNS,
    rows: rows.map((r) => {
      const out = {};
      for (const c of ENQUIRY_EXPORT_COLUMNS) out[c.key] = renderEnquiryCell(r, c.key);
      return out;
    }),
    branding,
    exportedBy: exportedByLabel(context.auth),
    summaryCards: buildEnquirySummaryCards(rows),
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
