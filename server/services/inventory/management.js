const crypto = require('crypto');
const { HttpError } = require('../../middleware/errors');
const inventory = require('../../db/queries/inventory_properties');
const propertyFiles = require('../../db/queries/property_files');
const imageUpload = require('../files/imageUpload');
const documentUpload = require('../files/documentUpload');
const excel = require('../files/excel');
const { assignUniqueCode } = require('../properties/propertyCode');
const masters = require('../masters/management');

async function validateMasterCodes(payload) {
  await masters.assertActiveCode('property_type', payload.propertyType);
  await masters.assertActiveCode('transaction_type', payload.transactionType);
  await masters.assertActiveCode('flat_type', payload.bhk);
  await masters.assertActiveCode('status_type', payload.status);
}

const PUBLIC_URL_PREFIX = '/uploads/public';

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
  // the final NSK-<TYPE>-YY-XXXXXX code with retry-on-collision.
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

async function updateStatus(id, status) {
  await masters.assertActiveCode('status_type', status);
  const existing = await inventory.findById(id);
  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Property not found');
  await inventory.updateStatus(id, status);
  return getProperty(id);
}

async function removeProperty(id) {
  const existing = await inventory.findById(id);
  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Property not found');
  await inventory.softDelete(id);
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
  return {
    id: row.id,
    propertyCode: row.property_code,
    title: row.title,
    propertyType: row.property_type,
    transactionType: row.transaction_type,
    location: row.location,
    areaValue: row.area_value !== null ? Number(row.area_value) : null,
    areaUnit: row.area_unit,
    bhk: row.bhk,
    price: Number(row.price),
    status: row.status,
    isDraft: Boolean(row.is_draft),
    ownerName: row.owner_name,
    ownerContact: row.owner_contact,
    agentName: row.agent_name,
    agentContact: row.agent_contact,
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
    where.push('(property_code LIKE ? OR title LIKE ? OR location LIKE ? OR owner_name LIKE ? OR agent_name LIKE ?)');
    const s = `%${q.trim()}%`;
    params.push(s, s, s, s, s);
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

function toDetail(row, images, documents = []) {
  return {
    ...toListItem(row),
    description: row.description,
    isDraft: Boolean(row.is_draft),
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
};
