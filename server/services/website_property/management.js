const crypto = require('crypto');
const { HttpError } = require('../../middleware/errors');
const wp = require('../../db/queries/website_properties');
const sellers = require('../../db/queries/sellers');
const propertyFiles = require('../../db/queries/property_files');
const imageUpload = require('../files/imageUpload');
const documentUpload = require('../files/documentUpload');
const excel = require('../files/excel');
const { buildTablePdf } = require('../files/pdf');
const { assignUniqueCode, resolvePropertyTypeIdCode } = require('../properties/propertyCode');
const masters = require('../masters/management');
const { getDistrictShortCode } = require('../../db/queries/locations');
// Centralised Property Type / Transaction Type / Property Variety
// validator — see services/masters/propertyMasters.js for the contract.
const { validatePropertyClassification } = require('../masters/propertyMasters');
const audit = require('../admin/audit');
const allocationGuard = require('../crm/allocationGuard');
// T-2026-156: CRM ingestion hook REMOVED from this file. Website
// Property create is a SELLER action; the CRM Website source is
// BUYER enquiries (services/public/leads.js). See the removal
// comment inside createProperty() for the full rationale. The
// crmResolver import is no longer needed here.

async function validateMasterCodes(payload) {
  await validatePropertyClassification(payload);
  await masters.assertActiveCode('flat_type', payload.bhk);
}

const { PUBLIC_URL_PREFIX } = require('../files/publicUrl');

const WEBSITE_HEADERS = [
  'property_code', 'approval_status', 'is_active', 'is_featured',
  'title', 'property_type', 'transaction_type', 'location',
  'bhk', 'area_value', 'area_unit', 'price',
  'seller_name', 'seller_type', 'seller_mobile', 'seller_email',
  'leads_count', 'created_at', 'approved_at',
];

function websiteRowValues(r) {
  return [
    r.property_code,
    r.approval_status,
    r.is_active ? 'yes' : 'no',
    r.is_featured ? 'yes' : 'no',
    r.title,
    r.property_type,
    r.transaction_type,
    r.location || '',
    r.bhk || '',
    r.area_value !== null && r.area_value !== undefined ? Number(r.area_value) : '',
    r.area_unit || '',
    Number(r.price) || 0,
    r.seller_full_name || r.seller_name || '',
    r.seller_user_type || '',
    r.seller_mobile || '',
    r.seller_email || '',
    Number(r.leads_count) || 0,
    r.created_at,
    r.approved_at || '',
  ];
}

function csvField(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

async function listProperties(query) {
  const { rows, total } = await wp.list(query);
  return {
    data: rows.map(toListItem),
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
  };
}

async function getProperty(id) {
  const row = await wp.findById(id);
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Property not found');
  const [images, documents] = await Promise.all([
    propertyFiles.listForProperty(null, 'website', id),
    documentUpload.listPropertyDocuments('website', id),
  ]);
  return toDetail(row, images, documents);
}

async function createProperty(payload) {
  await validateMasterCodes(payload);
  const seller = await sellers.findById(payload.sellerId);
  if (!seller) throw new HttpError(400, 'INVALID_SELLER', 'Seller not found');

  // District is required — the property ID prefix is derived from it.
  if (!payload.district) {
    throw new HttpError(400, 'DISTRICT_REQUIRED', 'District is required to create a website property');
  }
  const districtShortCode = await getDistrictShortCode(payload.district);
  if (!districtShortCode) {
    throw new HttpError(400, 'INVALID_DISTRICT', 'Selected district does not have a property ID code configured');
  }

  // property_code is UNIQUE in MySQL. Insert with a UUID placeholder so
  // concurrent creates can never collide on the constraint, then assign
  // the final DISTRICTCODE-TYPECODE-YY-RANDOM7 code with retry-on-collision.
  const propertyTypeIdCode = await resolvePropertyTypeIdCode(payload.propertyType);
  const tmpCode = `TMP-${crypto.randomUUID()}`;
  const id = await wp.create({ ...payload, propertyCode: tmpCode });
  await assignUniqueCode(districtShortCode, propertyTypeIdCode, async (code) => {
    try {
      await wp.updatePropertyCode(id, code);
      return true;
    } catch (err) {
      if (err && err.code === 'ER_DUP_ENTRY') return false;
      throw err;
    }
  });
  // T-2026-156 (corrective for T-2026-151 Phase 1): the CRM
  // ingestion hook that used to fire here has been REMOVED. It was
  // wrong: it pushed the SELLER (who registered a property) into CRM
  // as if they were a Website LEAD, but Website Leads in this
  // project are BUYERS who submitted an enquiry via the public
  // Buyer Enquiry form (services/public/leads.js -> `leads` table).
  // Sellers are a different subject and now live only in
  // /admin/sellers (Website Seller module). The correct CRM Website
  // hook now lives in services/public/leads.js#verify -- fires when
  // a buyer OTP-verifies and their `leads` row is created.
  return getProperty(id);
}


async function updateProperty(id, payload) {
  await validateMasterCodes(payload);
  const existing = await wp.findById(id);
  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Property not found');
  await wp.update(id, payload);
  return getProperty(id);
}

async function approveProperty(id, adminId, req = null) {
  const existing = await wp.findById(id);
  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Property not found');
  await wp.approve(id, adminId);
  if (req) {
    void audit.record(req, {
      action: 'property.approved',
      entityType: 'website_property',
      entityId: id,
      summary: `Approved ${existing.property_code} — ${existing.title}`,
      metadata: {
        entityLabel: existing.property_code,
        entitySubLabel: existing.title,
        sellerId: existing.seller_id,
      },
    });
  }
  return getProperty(id);
}

async function rejectProperty(id, adminId, reason, req = null) {
  const existing = await wp.findById(id);
  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Property not found');
  await wp.reject(id, adminId, reason);
  if (req) {
    void audit.record(req, {
      action: 'property.rejected',
      entityType: 'website_property',
      entityId: id,
      summary: `Rejected ${existing.property_code} — ${existing.title}`,
      metadata: {
        entityLabel: existing.property_code,
        entitySubLabel: existing.title,
        reason,
      },
    });
  }
  return getProperty(id);
}

async function setActive(id, isActive, req = null) {
  const existing = await wp.findById(id);
  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Property not found');
  await wp.setActive(id, isActive);
  if (req && Boolean(existing.is_active) !== Boolean(isActive)) {
    void audit.record(req, {
      action: isActive ? 'property.activated' : 'property.deactivated',
      entityType: 'website_property',
      entityId: id,
      summary: `${isActive ? 'Activated' : 'Deactivated'} ${existing.property_code} — ${existing.title}`,
      metadata: {
        entityLabel: existing.property_code,
        entitySubLabel: existing.title,
        from: Boolean(existing.is_active),
        to: Boolean(isActive),
      },
    });
  }
  return getProperty(id);
}

async function setFeatured(id, isFeatured, req = null) {
  const existing = await wp.findById(id);
  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Property not found');
  await wp.setFeatured(id, isFeatured);
  if (req && Boolean(existing.is_featured) !== Boolean(isFeatured)) {
    void audit.record(req, {
      action: isFeatured ? 'property.featured' : 'property.unfeatured',
      entityType: 'website_property',
      entityId: id,
      summary: `${isFeatured ? 'Featured' : 'Unfeatured'} ${existing.property_code} — ${existing.title}`,
      metadata: {
        entityLabel: existing.property_code,
        entitySubLabel: existing.title,
      },
    });
  }
  return getProperty(id);
}

async function removeProperty(id, req = null) {
  const existing = await wp.findById(id);
  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Property not found');

  // Refuse to delete while still allocated to a CRM lead.
  //
  // NEW GUARD, same reasoning as the enquiry surface: website properties
  // became allocatable the moment the CRM started keying allocations on
  // globally-unique property codes instead of inventory row ids. Without
  // this, deleting an allocated website property leaves a dangling
  // reference in the lead's allocation list.
  await allocationGuard.assertNotAllocatedToAnyLead(existing.property_code, 'website property');

  await wp.softDelete(id);
  if (req) {
    void audit.record(req, {
      action: 'property.deleted',
      entityType: 'website_property',
      entityId: id,
      summary: `Deleted ${existing.property_code} — ${existing.title}`,
      metadata: {
        entityLabel: existing.property_code,
        entitySubLabel: existing.title,
      },
    });
  }
}

async function addImages(id, files) {
  const existing = await wp.findById(id);
  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Property not found');
  await imageUpload.persistImages({ propertyKind: 'website', propertyId: id, files });
  return getProperty(id);
}

async function removeImage(id, fileId) {
  const existing = await wp.findById(id);
  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Property not found');
  await imageUpload.deleteImage({ fileId, propertyKind: 'website', propertyId: id });
  return getProperty(id);
}

async function addDocuments(id, files) {
  const existing = await wp.findById(id);
  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Property not found');
  await documentUpload.persistPropertyDocuments({ propertyKind: 'website', propertyId: id, files });
  return getProperty(id);
}

async function removeDocument(id, fileId) {
  const existing = await wp.findById(id);
  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Property not found');
  await documentUpload.deletePropertyDocument({ fileId, propertyKind: 'website', propertyId: id });
  return getProperty(id);
}

async function findDocument(fileId) {
  return propertyFiles.findById(null, fileId);
}

async function streamDocument(res, file) {
  return documentUpload.streamPropertyDocument(res, file);
}

async function suggest({ q, limit = 8 }) {
  const { pool } = require('../../db/pool');
  const where = [`wp.deleted_at IS NULL`];
  const params = [];
  if (q && q.trim()) {
    where.push('(wp.property_code LIKE ? OR wp.title LIKE ? OR wp.location LIKE ? OR s.full_name LIKE ?)');
    const t = `%${q.trim()}%`;
    params.push(t, t, t, t);
  }
  const [rows] = await pool.query(
    `SELECT wp.id, wp.property_code, wp.title, wp.location, wp.property_type,
            wp.transaction_type, wp.price, wp.approval_status, wp.is_active,
            s.full_name AS seller_name
     FROM website_properties wp LEFT JOIN sellers s ON s.id = wp.seller_id
     WHERE ${where.join(' AND ')}
     ORDER BY wp.created_at DESC, wp.id DESC
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
    approvalStatus: r.approval_status,
    isActive: Boolean(r.is_active),
    sellerName: r.seller_name,
  }));
}

function toListItem(row) {
  return {
    id: row.id,
    propertyCode: row.property_code,
    title: row.title,
    propertyType: row.property_type,
    transactionType: row.transaction_type,
    propertyVariety: extractPropertyVariety(row.details),
    location: row.location,
    district: row.district,
    taluka: row.taluka,
    shivar: row.shivar,
    pincode: row.pincode,
    areaValue: row.area_value !== null ? Number(row.area_value) : null,
    areaUnit: row.area_unit,
    bhk: row.bhk,
    price: Number(row.price),
    approvalStatus: row.approval_status,
    isActive: Boolean(row.is_active),
    isFeatured: Boolean(row.is_featured),
    approvedAt: row.approved_at,
    rejectionReason: row.rejection_reason,
    leadsCount: Number(row.leads_count || 0),
    seller: {
      id: row.seller_id,
      name: row.seller_name,
      type: row.seller_type,
      email: row.seller_email,
      mobile: row.seller_mobile,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function extractPropertyVariety(raw) {
  if (raw === null || raw === undefined) return null;
  const obj = typeof raw === 'object' ? raw : (() => { try { return JSON.parse(raw); } catch { return null; } })();
  return obj && obj.property_variety ? String(obj.property_variety) : null;
}

// MySQL's JSON column comes back as either a string (older drivers) or a
// parsed object (newer drivers). Normalise to a plain object so the
// frontend always sees the same shape. Mirrors the same helper used by
// services/inventory/management.js + services/enquiry/management.js so
// the three surfaces produce structurally identical `details` payloads.
function parseDetailsField(raw) {
  if (raw === null || raw === undefined) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw) || {}; } catch { return {}; }
}

function toDetail(row, images, documents = []) {
  return {
    ...toListItem(row),
    description: row.description,
    latitude: row.latitude !== null ? Number(row.latitude) : null,
    longitude: row.longitude !== null ? Number(row.longitude) : null,
    // T-2026-103: additive passthrough of columns the Individual Property
    // PDF Download modal (T-2026-102) walks. Every one of these already
    // exists on the underlying row via `wp.*` in db/queries/website_
    // properties.js#findById — this block simply surfaces them on the
    // response DTO so the FE catalog builder finds them. No schema
    // change, no destructive rename; all additive fields default to
    // `null` when the DB row is a legacy record without that column set.
    //
    //   * postingDate           — aliased from `registration_date` because
    //                              website_properties.registration_date was
    //                              intentionally left unrenamed by
    //                              migration 081 (see the header comment
    //                              of that migration). The FE PDF catalog
    //                              reads `property.postingDate` uniformly
    //                              across all three surfaces.
    //   * availableFromDate     — column added by migration 080; not
    //                              previously exposed on website toDetail.
    //   * details               — JSON blob from migration 013; the FE
    //                              catalog walks `details.dynamicData.*`
    //                              for form-config fields, contacts,
    //                              keyPersons, and the Property Video URL
    //                              (`details.dynamicData.propertyLink`).
    //                              Parsed defensively so both mysql2
    //                              driver shapes (string vs object) yield
    //                              the same object.
    postingDate: row.registration_date ?? null,
    availableFromDate: row.available_from_date ?? null,
    details: row.details !== undefined ? parseDetailsField(row.details) : {},
    seller: {
      id: row.seller_id,
      name: row.seller_name,
      type: row.seller_type,
      email: row.seller_email,
      mobile: row.seller_mobile,
      agency: row.seller_agency,
    },
    documents: documents.map((f) => ({
      id: f.id,
      downloadPath: `/admin/website-properties/${row.id}/documents/${f.id}`,
      originalName: f.original_name,
      mimeType: f.mime_type,
      sizeBytes: Number(f.size_bytes),
    })),
    images: images.map((f) => ({
      id: f.id,
      url: `${PUBLIC_URL_PREFIX}/${f.stored_name}`,
      originalName: f.original_name,
      mimeType: f.mime_type,
      sizeBytes: Number(f.size_bytes),
      sortOrder: f.sort_order,
    })),
  };
}

async function exportCsv(filters) {
  const { rows } = await wp.list({ ...filters, page: 1, pageSize: 100000 });
  const lines = [WEBSITE_HEADERS.join(',')];
  for (const r of rows) lines.push(websiteRowValues(r).map(csvField).join(','));
  return lines.join('\r\n');
}

async function exportXlsx(filters) {
  const { rows } = await wp.list({ ...filters, page: 1, pageSize: 100000 });
  return excel.buildWorkbook({
    sheetName: 'Website Properties',
    headers: WEBSITE_HEADERS,
    rows: rows.map(websiteRowValues),
  });
}

// PDF export — curated subset of columns that fits a landscape A4 sheet.
// `weight` controls relative column width; the helper allocates space
// proportionally to remaining columns.
const WEBSITE_PDF_COLUMNS = [
  { key: 'property_code',   label: 'Property ID', weight: 2.3, noWrap: true },
  { key: 'title',           label: 'Title',       weight: 2.6 },
  { key: 'property_type',   label: 'Type',        weight: 1.3, noWrap: true },
  { key: 'transaction_type', label: 'Txn',        weight: 1.1, noWrap: true },
  { key: 'location',        label: 'Location',    weight: 2.2 },
  { key: 'price',           label: 'Price (INR)', weight: 1.6, align: 'right', headerAlign: 'right', noWrap: true },
  { key: 'approval_status', label: 'Approval',    weight: 1.3, noWrap: true, align: 'center', headerAlign: 'center' },
  { key: 'visibility',      label: 'Visibility',  weight: 1.3, noWrap: true, align: 'center', headerAlign: 'center' },
  { key: 'seller_name',     label: 'Seller',      weight: 1.8 },
  { key: 'leads_count',     label: 'Website Enquiry', weight: 0.8, align: 'right', headerAlign: 'right', noWrap: true },
  { key: 'created_at',      label: 'Created',     weight: 1.5, noWrap: true },
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
function visibilityLabel(r) {
  if (!r.is_active) return 'Inactive';
  if (r.is_featured) return 'Featured';
  return 'Active';
}

async function exportPdf(filters) {
  const { rows } = await wp.list({ ...filters, page: 1, pageSize: 100000 });
  const pdfRows = rows.map((r) => ({
    property_code: r.property_code,
    title: r.title,
    property_type: r.property_type,
    transaction_type: r.transaction_type,
    location: r.location || '',
    price: formatInr(r.price),
    approval_status: r.approval_status,
    visibility: visibilityLabel(r),
    seller_name: r.seller_full_name || r.seller_name || '—',
    leads_count: Number(r.leads_count) || 0,
    created_at: formatDate(r.created_at),
  }));
  return buildTablePdf({
    title: 'Website Properties',
    subtitle: `${rows.length} record${rows.length === 1 ? '' : 's'} · Seller-submitted listings`,
    columns: WEBSITE_PDF_COLUMNS,
    rows: pdfRows,
  });
}

module.exports = {
  listProperties,
  getProperty,
  createProperty,
  updateProperty,
  approveProperty,
  rejectProperty,
  setActive,
  setFeatured,
  removeProperty,
  addImages,
  removeImage,
  addDocuments,
  removeDocument,
  findDocument,
  streamDocument,
  suggest,
  exportCsv,
  exportXlsx,
  exportPdf,
};
