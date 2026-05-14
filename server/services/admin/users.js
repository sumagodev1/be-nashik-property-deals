const { HttpError } = require('../../middleware/errors');
const sellersRepo = require('../../db/queries/sellers');
const buyersRepo = require('../../db/queries/users_buyers');
const documentUpload = require('../files/documentUpload');
const excel = require('../files/excel');

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

const SELLER_HEADERS = [
  'seller_id', 'user_type', 'full_name', 'mobile', 'email',
  'alternate_contact', 'agency_name', 'business_address', 'area',
  'is_active', 'is_verified', 'listing_count', 'created_at',
];

function sellerRowValues(r) {
  return [
    r.id,
    r.user_type,
    r.full_name || '',
    r.mobile_number || '',
    r.email || '',
    r.alternate_contact || '',
    r.agency_name || '',
    r.business_address || '',
    r.area || '',
    r.is_active ? 1 : 0,
    r.is_verified ? 1 : 0,
    Number(r.listing_count || 0),
    r.created_at,
  ];
}

async function exportSellersCsv(filters) {
  const rows = await sellersRepo.listForExport(filters);
  const lines = [SELLER_HEADERS.join(',')];
  for (const r of rows) {
    lines.push(sellerRowValues(r).map(csvField).join(','));
  }
  return lines.join('\r\n');
}

async function exportSellersXlsx(filters) {
  const rows = await sellersRepo.listForExport(filters);
  return excel.buildWorkbook({
    sheetName: 'Sellers',
    headers: SELLER_HEADERS,
    rows: rows.map(sellerRowValues),
  });
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

function csvField(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
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
  listBuyers,
};
