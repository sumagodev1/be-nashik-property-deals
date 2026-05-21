const { HttpError } = require('../../middleware/errors');
const publicProps = require('../../db/queries/public_properties');
const propertyFiles = require('../../db/queries/property_files');

const PUBLIC_URL_PREFIX = '/uploads/public';

async function listPublic(query) {
  const { rows, total } = await publicProps.list(query);
  return {
    data: rows.map(toListItem),
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
  };
}

async function getPublic(identifier) {
  const row = await publicProps.findByIdentifier(identifier);
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Property not found');
  const [images, amenityFiles] = await Promise.all([
    propertyFiles.listForProperty(null, 'website', row.id),
    propertyFiles.listAmenitiesForProperty(null, 'website', row.id),
  ]);
  return toDetail(row, images, amenityFiles);
}

async function featured({ limit = 6 } = {}) {
  const rows = await publicProps.listFeatured({ limit: Math.min(20, Math.max(1, limit)) });
  return rows.map(toListItem);
}

async function latest({ limit = 6 } = {}) {
  const rows = await publicProps.listLatest({ limit: Math.min(20, Math.max(1, limit)) });
  return rows.map(toListItem);
}

function coverUrl(stored) {
  return stored ? `${PUBLIC_URL_PREFIX}/${stored}` : null;
}

function toListItem(row) {
  return {
    id: row.id,
    propertyCode: row.property_code,
    title: row.title,
    description: row.description || null,
    propertyType: row.property_type,
    transactionType: row.transaction_type,
    location: row.location,
    // Lat/lng on list items so the website's Map view can plot pins from
    // the listing payload without firing a detail request per property.
    latitude: row.latitude !== null && row.latitude !== undefined ? Number(row.latitude) : null,
    longitude: row.longitude !== null && row.longitude !== undefined ? Number(row.longitude) : null,
    areaValue: row.area_value !== null && row.area_value !== undefined ? Number(row.area_value) : null,
    areaUnit: row.area_unit,
    bhk: row.bhk,
    price: Number(row.price),
    isFeatured: Boolean(row.is_featured),
    approvedAt: row.approved_at,
    coverImageUrl: coverUrl(row.cover_stored_name),
    images: Array.isArray(row.image_list)
      ? row.image_list.map((i) => ({ id: i.id, url: `${PUBLIC_URL_PREFIX}/${i.storedName}` }))
      : [],
  };
}

function toDetail(row, images, amenityFiles = []) {
  const details = parseDetailsField(row.details);
  return {
    ...toListItem(row),
    description: row.description,
    latitude: row.latitude !== null && row.latitude !== undefined ? Number(row.latitude) : null,
    longitude: row.longitude !== null && row.longitude !== undefined ? Number(row.longitude) : null,
    landmark: typeof details.landmark === 'string' ? details.landmark : null,
    details,
    images: images.map((f) => ({
      id: f.id,
      url: `${PUBLIC_URL_PREFIX}/${f.stored_name}`,
      originalName: f.original_name,
      mimeType: f.mime_type,
    })),
    // Per-amenity image cards — the seller types a name and uploads a thumb
    // on /seller/add-property; we surface them here so the detail page can
    // render a grid of `[{ id, name, imageUrl }]`.
    amenities: amenityFiles.map((f) => ({
      id: f.id,
      name: f.original_name,
      imageUrl: `${PUBLIC_URL_PREFIX}/${f.stored_name}`,
      sortOrder: f.sort_order,
    })),
  };
}

function parseDetailsField(raw) {
  if (raw === null || raw === undefined) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw) || {}; } catch { return {}; }
}

module.exports = { listPublic, getPublic, featured, latest };
