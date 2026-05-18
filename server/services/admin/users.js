const { HttpError } = require('../../middleware/errors');
const sellersRepo = require('../../db/queries/sellers');
const buyersRepo = require('../../db/queries/users_buyers');
const documentUpload = require('../files/documentUpload');
const excel = require('../files/excel');
const pdf = require('../files/pdf');

async function listSellers(filters) {
  const { rows, total } = await sellersRepo.listForAdmin(filters);
  return {
    data: rows.map(toSellerListItem),
    page: filters.page,
    pageSize: filters.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / filters.pageSize)),
  };
}

async function getSeller(id) {
  const seller = await sellersRepo.findWithListingCount(id);
  if (!seller) throw new HttpError(404, 'NOT_FOUND', 'Seller not found');
  const [recent, documents] = await Promise.all([
    sellersRepo.listRecentPropertiesForSeller(id, { limit: 5 }),
    documentUpload.listSellerDocuments(id),
  ]);
  return toSellerDetail(seller, recent, documents);
}

async function updateSeller(id, payload) {
  const seller = await sellersRepo.findById(id);
  if (!seller) throw new HttpError(404, 'NOT_FOUND', 'Seller not found');

  if (payload.email && payload.email !== seller.email) {
    const existing = await sellersRepo.findByEmail(payload.email);
    if (existing && existing.id !== seller.id) {
      throw new HttpError(409, 'EMAIL_TAKEN', 'This email is already linked to another seller.');
    }
  }

  const isOwner = seller.user_type === 'owner';
  await sellersRepo.adminUpdateProfile(id, {
    fullName: payload.fullName,
    email: payload.email,
    alternateContact: payload.alternateContact,
    agencyName: isOwner ? null : payload.agencyName,
    businessAddress: isOwner ? null : payload.businessAddress,
    area: payload.area,
  });
  return getSeller(id);
}

async function setSellerActive(id, isActive) {
  const seller = await sellersRepo.findById(id);
  if (!seller) throw new HttpError(404, 'NOT_FOUND', 'Seller not found');
  await sellersRepo.setActive(id, isActive);
  return getSeller(id);
}

async function removeSeller(id) {
  const seller = await sellersRepo.findById(id);
  if (!seller) throw new HttpError(404, 'NOT_FOUND', 'Seller not found');
  await sellersRepo.softDelete(id);
}

function sellerStatusLabel(r) {
  if (!r.is_active) return 'Inactive';
  return r.is_verified ? 'Active' : 'Unverified';
}

function formatDateIN(value) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
  });
}

// Single source of truth for the Sellers report — CSV / XLSX / PDF.
const SELLER_COLUMNS = [
  { label: 'Sr. No.',    key: 'sr',         width: 8,  pdf: { weight: 0.7, align: 'center' },
    value: (_r, i) => i + 1 },
  { label: 'Type',       key: 'type',       width: 10, pdf: { weight: 0.9, align: 'center' },
    value: (r) => r.user_type === 'agent' ? 'Agent' : 'Owner' },
  { label: 'Name',       key: 'name',       width: 24, pdf: { weight: 2.0 },
    value: (r) => r.full_name || '' },
  { label: 'Mobile',     key: 'mobile',     width: 14, excelText: true, pdf: { weight: 1.5, noWrap: true },
    value: (r) => r.mobile_number || '' },
  { label: 'Email',      key: 'email',      width: 28, pdf: { weight: 2.2 },
    value: (r) => r.email || '' },
  { label: 'Agency',     key: 'agency',     width: 22, pdf: { weight: 1.6 },
    value: (r) => r.agency_name || '' },
  { label: 'Area',       key: 'area',       width: 18, pdf: { weight: 1.2 },
    value: (r) => r.area || '' },
  { label: 'Listings',   key: 'listings',   width: 10, pdf: { weight: 0.8, align: 'center' },
    value: (r) => Number(r.listing_count || 0) },
  { label: 'Status',     key: 'status',     width: 12, pdf: { weight: 1.0, align: 'center' },
    value: sellerStatusLabel },
  { label: 'Registered', key: 'registered', width: 14, pdf: { weight: 1.3, noWrap: true },
    value: (r) => formatDateIN(r.created_at) },
  { label: 'Alt. Contact',     key: 'alternateContact', width: 16, excelText: true,
    value: (r) => r.alternate_contact || '' },
  { label: 'Business Address', key: 'businessAddress',  width: 32,
    value: (r) => r.business_address || '' },
];

function prepareSellerReport(rawRows) {
  return rawRows.map((r, i) => {
    const out = {};
    for (const col of SELLER_COLUMNS) out[col.key] = col.value(r, i);
    return out;
  });
}

async function exportSellersCsv(filters) {
  const rows = await sellersRepo.listForExport(filters);
  const data = prepareSellerReport(rows);
  const BOM = '﻿';
  const lines = [SELLER_COLUMNS.map((c) => c.label).join(',')];
  for (const row of data) {
    lines.push(SELLER_COLUMNS.map((col) => csvCell(row[col.key], col)).join(','));
  }
  return BOM + lines.join('\r\n');
}

async function exportSellersXlsx(filters) {
  const rows = await sellersRepo.listForExport(filters);
  const data = prepareSellerReport(rows);
  return excel.buildWorkbookFromColumns({
    sheetName: 'Sellers',
    columns: SELLER_COLUMNS.map((c) => ({
      label: c.label,
      key: c.key,
      width: c.width,
      type: c.excelText ? 's' : undefined,
    })),
    rows: data,
  });
}

const SELLER_PDF_KEYS = ['sr', 'type', 'name', 'mobile', 'email', 'agency', 'area', 'listings', 'status', 'registered'];
const SELLER_PDF_COLUMNS = SELLER_COLUMNS
  .filter((c) => SELLER_PDF_KEYS.includes(c.key))
  .map((c) => ({ label: c.label, key: c.key, ...(c.pdf || {}) }));

async function exportSellersPdf(filters) {
  const rows = await sellersRepo.listForExport(filters);
  const data = prepareSellerReport(rows);
  return pdf.buildTablePdf({
    title: 'Sellers',
    subtitle: `${rows.length} seller record${rows.length === 1 ? '' : 's'}`,
    columns: SELLER_PDF_COLUMNS,
    rows: data,
  });
}

function csvCell(value, col) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (col.excelText && s !== '') return `="${s.replace(/"/g, '""')}"`;
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

async function listBuyers(filters) {
  const { rows, total } = await buyersRepo.listAggregated(filters);
  return {
    data: rows.map(toBuyerListItem),
    page: filters.page,
    pageSize: filters.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / filters.pageSize)),
  };
}

function toSellerListItem(row) {
  return {
    id: row.id,
    userType: row.user_type,
    fullName: row.full_name,
    mobile: row.mobile_number,
    email: row.email,
    alternateContact: row.alternate_contact,
    agencyName: row.agency_name,
    businessAddress: row.business_address,
    area: row.area,
    isActive: Boolean(row.is_active),
    isVerified: Boolean(row.is_verified),
    listingCount: Number(row.listing_count || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toSellerDetail(row, recent, documents = []) {
  return {
    ...toSellerListItem(row),
    recentListings: recent.map((p) => ({
      id: p.id,
      propertyCode: p.property_code,
      title: p.title,
      location: p.location,
      price: Number(p.price),
      approvalStatus: p.approval_status,
      isActive: Boolean(p.is_active),
      createdAt: p.created_at,
    })),
    documents: documents.map((d) => ({
      id: d.id,
      originalName: d.original_name,
      mimeType: d.mime_type,
      sizeBytes: Number(d.size_bytes),
      downloadPath: `/admin/users/sellers/${row.id}/documents/${d.id}`,
      createdAt: d.created_at,
    })),
  };
}

function toBuyerListItem(row) {
  return {
    mobile: row.mobile,
    email: row.email,
    name: row.last_name,
    leadCount: Number(row.lead_count || 0),
    newCount: Number(row.new_count || 0),
    contactedCount: Number(row.contacted_count || 0),
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
}

module.exports = {
  listSellers,
  getSeller,
  updateSeller,
  setSellerActive,
  removeSeller,
  exportSellersCsv,
  exportSellersXlsx,
  exportSellersPdf,
  listBuyers,
};
