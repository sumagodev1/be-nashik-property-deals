const crypto = require('crypto');
const { HttpError } = require('../../middleware/errors');
const enquiry = require('../../db/queries/enquiry_properties');
const propertyFiles = require('../../db/queries/property_files');
const imageUpload = require('../files/imageUpload');
const documentUpload = require('../files/documentUpload');
const excel = require('../files/excel');
const { buildTablePdf } = require('../files/pdf');
const { assignUniqueCode } = require('../properties/propertyCode');
const masters = require('../masters/management');

// Structural mirror of services/inventory/management.js — every function has
// the same signature and same downstream behaviour. Only the data source
// (enquiry_properties table via db/queries/enquiry_properties) and the file
// namespace (propertyKind='enquiry' for uploads/downloads) differ.
//
// Kept as a parallel module rather than a factory so a search for the
// enquiry code path lands directly, and so future divergence (e.g. if the
// Enquiry surface grows fields the Inventory surface does not) can happen
// here without dragging the sister module along.

function toPropertyTypeKey(propertyType) {
  const value = String(propertyType || '').trim().toLowerCase();
  if (!value) return 'other';
  if (value.includes('flat') || value.includes('apartment') || value.includes('house')) return 'flat';
  if (value.includes('bunglow') || value.includes('villa')) return 'bunglow';
  if (value.includes('plot')) return 'plot';
  if (value.includes('shop')) return 'shop';
  if (value.includes('commercial')) return 'commercial';
  if (value.includes('land')) return 'land';
  if (value.includes('hostel')) return 'hostel';
  if (value.includes('paying guest') || value.includes('paying_guest')) return 'paying_guest';
  if (value.includes('hospital')) return 'hospital';
  if (value.includes('industrial')) return 'industrial_plot';
  if (value.includes('sez')) return 'sez';
  if (value.includes('tdr')) return 'tdr';
  if (value.includes('pre-leased') || value.includes('pre leased')) return 'pre_leased';
  if (value.includes('bank auction')) return 'bank_auction';
  return 'other';
}

async function validateMasterCodes(payload) {
  if (payload.transactionType) {
    await masters.assertActiveCode('transaction_type', payload.transactionType);
  }
  if (payload.transactionVariant) {
    await masters.assertActiveCode('transaction_type', payload.transactionVariant);
  }
  await masters.assertActiveCode('flat_type', payload.bhk);
  await masters.assertActiveCode('status_type', payload.status);
  await masters.assertActiveCode('district', payload.district);
  await masters.assertActiveCode('taluka', payload.taluka);
  await masters.assertActiveCode('shivar', payload.shivar);
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
  const propertyKey = toPropertyTypeKey(payload.propertyType);
  const id = await enquiry.create({ ...payload, propertyCode: tmpCode });
  await assignUniqueCode(propertyKey, async (code) => {
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
  await enquiry.softDelete(id);
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
    transactionType: row.transaction_type,
    transactionVariant: row.transaction_variant ?? null,
    location: row.location,
    district: row.district ?? null,
    taluka: row.taluka ?? null,
    shivar: row.shivar ?? null,
    latitude: row.latitude !== null && row.latitude !== undefined ? Number(row.latitude) : null,
    longitude: row.longitude !== null && row.longitude !== undefined ? Number(row.longitude) : null,
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
    where.push('(property_code LIKE ? OR title LIKE ? OR location LIKE ? OR owner_name LIKE ? OR agent_name LIKE ?)');
    const s = `%${q.trim()}%`;
    params.push(s, s, s, s, s);
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

async function exportCsv(filters) {
  const { rows } = await enquiry.list({ ...filters, page: 1, pageSize: 100000 });
  const lines = [ENQUIRY_HEADERS.join(',')];
  for (const r of rows) lines.push(enquiryRowValues(r).map(csvField).join(','));
  return lines.join('\r\n');
}

async function exportXlsx(filters) {
  const { rows } = await enquiry.list({ ...filters, page: 1, pageSize: 100000 });
  return excel.buildWorkbook({
    sheetName: 'Enquiry',
    headers: ENQUIRY_HEADERS,
    rows: rows.map(enquiryRowValues),
  });
}

const ENQUIRY_PDF_COLUMNS = [
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
  const { rows } = await enquiry.list({ ...filters, page: 1, pageSize: 100000 });
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
    title: 'Enquiry Properties',
    subtitle: `${rows.length} record${rows.length === 1 ? '' : 's'} · Admin-managed enquiry records`,
    columns: ENQUIRY_PDF_COLUMNS,
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
