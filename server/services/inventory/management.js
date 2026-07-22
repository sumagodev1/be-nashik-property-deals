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

// Export column order — matches what the admin would expect when reviewing
// inventory offline. ALL columns from the data-entry form so nothing is lost.
const INVENTORY_HEADERS = [
  'property_code', 'is_draft', 'status', 'title', 'property_type', 'transaction_type',
  'location', 'bhk', 'area_value', 'area_unit', 'price',
  'owner_name', 'owner_contact', 'agent_name', 'agent_contact',
  'created_at', 'updated_at',
];

function inventoryRowValues(r) {
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

async function exportCsv(filters) {
  // Pull all matching rows (no pagination) and build a CSV string.
  const { rows } = await inventory.list({ ...filters, page: 1, pageSize: 100000 });
  const lines = [INVENTORY_HEADERS.join(',')];
  for (const r of rows) lines.push(inventoryRowValues(r).map(csvField).join(','));
  return lines.join('\r\n');
}

async function exportXlsx(filters) {
  const { rows } = await inventory.list({ ...filters, page: 1, pageSize: 100000 });
  return excel.buildWorkbook({
    sheetName: 'Inventory',
    headers: INVENTORY_HEADERS,
    rows: rows.map(inventoryRowValues),
  });
}

// PDF export — a curated, human-readable subset of columns (the full CSV/Excel
// dump is too wide to fit a printable page). Column `weight` controls how the
// available landscape width is shared out.
const INVENTORY_PDF_COLUMNS = [
  { key: 'property_code',   label: 'Property ID',  weight: 2.3, noWrap: true },
  { key: 'title',           label: 'Title',        weight: 2.6 },
  { key: 'property_type',   label: 'Type',         weight: 1.4, noWrap: true },
  { key: 'transaction_type', label: 'Txn',         weight: 1.2, noWrap: true },
  { key: 'location',        label: 'Location',     weight: 2.4 },
  { key: 'price',           label: 'Price (INR)',  weight: 1.6, align: 'right', headerAlign: 'right', noWrap: true },
  { key: 'status',          label: 'Status',       weight: 1.2, noWrap: true, align: 'center', headerAlign: 'center' },
  { key: 'owner_name',      label: 'Owner',        weight: 1.8 },
  { key: 'agent_name',      label: 'Agent',        weight: 1.8 },
  { key: 'created_at',      label: 'Created',      weight: 1.5, noWrap: true },
];

function formatInr(n) {
  if (n === null || n === undefined || n === '') return '';
  return Number(n).toLocaleString('en-IN');
}
function formatDate(d) {
  if (!d) return '';
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return String(d);
  return date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

async function exportPdf(filters) {
  const { rows } = await inventory.list({ ...filters, page: 1, pageSize: 100000 });
  const pdfRows = rows.map((r) => ({
    property_code: r.property_code,
    title: r.title,
    property_type: r.property_type,
    transaction_type: r.transaction_type,
    location: r.location || '',
    price: formatInr(r.price),
    status: r.status,
    owner_name: r.owner_name || '—',
    agent_name: r.agent_name || '—',
    created_at: formatDate(r.created_at),
  }));
  return buildTablePdf({
    title: 'Inventory Properties',
    subtitle: `${rows.length} record${rows.length === 1 ? '' : 's'} · Admin-managed inventory`,
    columns: INVENTORY_PDF_COLUMNS,
    rows: pdfRows,
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
