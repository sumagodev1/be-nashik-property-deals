const crypto = require('crypto');
const { HttpError } = require('../../middleware/errors');
const wp = require('../../db/queries/website_properties');
const sellers = require('../../db/queries/sellers');
const propertyFiles = require('../../db/queries/property_files');
const imageUpload = require('../files/imageUpload');
const documentUpload = require('../files/documentUpload');
const excel = require('../files/excel');
const { buildTablePdf } = require('../files/pdf');
const { assignUniqueCode } = require('../properties/propertyCode');
const masters = require('../masters/management');
const { trySendMail } = require('../email/transporter');
const { renderEmail, sectionTitle, kvRow, kvTable, infoCard, quoteBlock, BRAND } = require('../email/emailTemplate');

async function validateMasterCodes(payload) {
  await masters.assertActiveCode('property_type', payload.propertyType);
  await masters.assertActiveCode('transaction_type', payload.transactionType);
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

  // property_code is UNIQUE in MySQL. Insert with a UUID placeholder so
  // concurrent creates can never collide on the constraint, then assign
  // the final NSK-<TYPE>-YY-XXXXXX code with retry-on-collision.
  const tmpCode = `TMP-${crypto.randomUUID()}`;
  const id = await wp.create({ ...payload, propertyCode: tmpCode });
  await assignUniqueCode(payload.propertyType, async (code) => {
    try {
      await wp.updatePropertyCode(id, code);
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
  const existing = await wp.findById(id);
  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Property not found');
  await wp.update(id, payload);
  return getProperty(id);
}

async function approveProperty(id, adminId) {
  const existing = await wp.findById(id);
  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Property not found');
  await wp.approve(id, adminId);
  // Tell the seller the good news — fire-and-forget so an email hiccup
  // never blocks the approval itself.
  void notifySellerOnApproval(existing).catch((err) => {
    // eslint-disable-next-line no-console
    console.warn('[property-approved] seller email failed:', err.message);
  });
  return getProperty(id);
}

async function rejectProperty(id, adminId, reason) {
  const existing = await wp.findById(id);
  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Property not found');
  await wp.reject(id, adminId, reason);
  void notifySellerOnRejection(existing, reason).catch((err) => {
    // eslint-disable-next-line no-console
    console.warn('[property-rejected] seller email failed:', err.message);
  });
  return getProperty(id);
}

/**
 * Seller-facing email when their submission is approved and goes live on
 * the public site. Best-effort — the approval transaction commits before
 * we attempt to email, so SMTP issues never block the workflow.
 */
async function notifySellerOnApproval(prop) {
  if (!prop?.seller_email) return;
  const publicUrl = `${process.env.PUBLIC_BASE_URL || ''}/properties/${prop.id}`;
  const subject = `Your listing ${prop.property_code} is live`;
  const text = [
    `Hi ${prop.seller_name || 'there'},`,
    '',
    `Great news — your property has been approved and is now live on Nashik Property Deals.`,
    '',
    `Property: ${prop.property_code} — ${prop.title}`,
    `View it:  ${publicUrl}`,
    '',
    `Buyers can now contact you through the platform.`,
    '',
    `— Nashik Property Deals team`,
  ].join('\n');
  const html = renderEmail({
    preheader: `Your listing ${prop.property_code} is approved and live`,
    title: `Hi ${prop.seller_name || 'there'}, your listing is now live`,
    intro: 'Great news — your property has been approved and is now visible to buyers on Nashik Property Deals.',
    bodyHtml: `
      ${infoCard({
        eyebrow: 'Your listing',
        title: prop.property_code,
        subtitle: prop.title,
        accent: '#10b981',
      })}
      ${sectionTitle('What happens next')}
      <p style="margin:8px 0 0 0;font-size:13.5px;line-height:1.6;color:${BRAND.text};">
        Buyers can now click <strong>Contact Seller</strong> or <strong>View Location</strong>
        on your listing. Every enquiry comes through our team — we verify the buyer with an
        OTP, then route the lead to you.
      </p>
    `,
    ctaHref: publicUrl,
    ctaLabel: 'View your live listing',
    accentColor: '#10b981',
    footerNote: 'Need to make changes? Log in and visit My Listed Properties.',
  });
  await trySendMail({ to: prop.seller_email, subject, text, html });
}

/**
 * Seller-facing email when their submission is rejected. The rejection
 * reason (if the admin typed one) is surfaced as a block-quoted note so
 * the seller knows what to fix before re-submitting.
 */
async function notifySellerOnRejection(prop, reason) {
  if (!prop?.seller_email) return;
  const profileUrl = `${process.env.PUBLIC_BASE_URL || ''}/seller/profile`;
  const subject = `Update on your listing ${prop.property_code}`;
  const text = [
    `Hi ${prop.seller_name || 'there'},`,
    '',
    `Your submitted property could not be approved at this time.`,
    '',
    `Property: ${prop.property_code} — ${prop.title}`,
    reason ? `\nReviewer's note:\n${reason}\n` : '',
    `You can edit the listing and re-submit it from your profile: ${profileUrl}`,
    '',
    `— Nashik Property Deals team`,
  ].join('\n');
  const html = renderEmail({
    preheader: `Your listing ${prop.property_code} needs changes before it can go live`,
    title: `Hi ${prop.seller_name || 'there'}, your listing needs some changes`,
    intro: 'Your property submission was reviewed but could not be approved as-is. You can update it and re-submit from your profile.',
    bodyHtml: `
      ${infoCard({
        eyebrow: 'Listing reviewed',
        title: prop.property_code,
        subtitle: prop.title,
        accent: '#ef4444',
      })}
      ${reason ? `${sectionTitle('Reviewer\'s note')}${quoteBlock(reason)}` : ''}
      ${sectionTitle('What to do next')}
      <p style="margin:8px 0 0 0;font-size:13.5px;line-height:1.6;color:${BRAND.text};">
        Open the listing from <strong>My Listed Properties</strong>, address the points above,
        and submit it again — our team will review the updated version.
      </p>
    `,
    ctaHref: profileUrl,
    ctaLabel: 'Edit and re-submit',
    accentColor: '#ef4444',
    footerNote: 'Need help? Reply to this notification address or reach us through Contact Us.',
  });
  await trySendMail({ to: prop.seller_email, subject, text, html });
}

async function setActive(id, isActive) {
  const existing = await wp.findById(id);
  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Property not found');
  await wp.setActive(id, isActive);
  return getProperty(id);
}

async function setFeatured(id, isFeatured) {
  const existing = await wp.findById(id);
  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Property not found');
  await wp.setFeatured(id, isFeatured);
  return getProperty(id);
}

async function removeProperty(id) {
  const existing = await wp.findById(id);
  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Property not found');
  await wp.softDelete(id);
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
    location: row.location,
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

function toDetail(row, images, documents = []) {
  return {
    ...toListItem(row),
    description: row.description,
    latitude: row.latitude !== null ? Number(row.latitude) : null,
    longitude: row.longitude !== null ? Number(row.longitude) : null,
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
  { key: 'leads_count',     label: 'Leads',       weight: 0.8, align: 'right', headerAlign: 'right', noWrap: true },
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
