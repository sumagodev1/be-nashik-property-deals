/**
 * Seller-scoped property operations. Every function takes the authenticated
 * seller id and refuses to touch rows owned by someone else.
 */

const crypto = require('crypto');
const { pool } = require('../../db/pool');
const { HttpError } = require('../../middleware/errors');
const wp = require('../../db/queries/website_properties');
const propertyFiles = require('../../db/queries/property_files');
const imageUpload = require('../files/imageUpload');
const { assignUniqueCode } = require('../properties/propertyCode');
const masters = require('../masters/management');

async function validateMasterCodes(payload) {
  await masters.assertActiveCode('property_type', payload.propertyType);
  await masters.assertActiveCode('transaction_type', payload.transactionType);
  await masters.assertActiveCode('flat_type', payload.bhk);
}

const { PUBLIC_URL_PREFIX } = require('../files/publicUrl');
const SORTABLE_COLUMNS = {
  created_at: 'created_at',
  price: 'price',
  approval_status: 'approval_status',
};

function buildOrderBy(sort) {
  const [col, dir] = (sort || 'created_at:desc').split(':');
  const safeCol = SORTABLE_COLUMNS[col] || 'created_at';
  const safeDir = dir && dir.toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  return `ORDER BY ${safeCol} ${safeDir}, id DESC`;
}

async function listOwn(sellerId, { page, pageSize, sort }) {
  const offset = (page - 1) * pageSize;
  const orderSql = buildOrderBy(sort);

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM website_properties WHERE seller_id = ? AND deleted_at IS NULL`,
    [sellerId],
  );

  const [rows] = await pool.query(
    `SELECT id, property_code, title, property_type, transaction_type, location,
            area_value, area_unit, bhk, price, approval_status, is_active, is_featured,
            approved_at, rejection_reason, created_at, updated_at
     FROM website_properties
     WHERE seller_id = ? AND deleted_at IS NULL
     ${orderSql}
     LIMIT ? OFFSET ?`,
    [sellerId, pageSize, offset],
  );

  return {
    data: rows.map(toListItem),
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

async function getOwn(sellerId, id) {
  const property = await loadOwnOrThrow(sellerId, id);
  const [images, amenityFiles] = await Promise.all([
    propertyFiles.listForProperty(null, 'website', property.id),
    propertyFiles.listAmenitiesForProperty(null, 'website', property.id),
  ]);
  return toDetail(property, images, amenityFiles);
}

async function createOwn(sellerId, payload) {
  await validateMasterCodes(payload);
  // property_code is UNIQUE in MySQL. Insert with a UUID placeholder so
  // concurrent submissions can never collide on the constraint, then assign
  // the final NSK-<TYPE>-YY-XXXXXX code with retry-on-collision.
  const tmpCode = `TMP-${crypto.randomUUID()}`;
  const id = await wp.create({
    ...payload,
    sellerId,
    propertyCode: tmpCode,
    approvalStatus: 'pending',
    isActive: true,
  });
  await assignUniqueCode(payload.propertyType, async (code) => {
    try {
      await wp.updatePropertyCode(id, code);
      return true;
    } catch (err) {
      if (err && err.code === 'ER_DUP_ENTRY') return false;
      throw err;
    }
  });
  return getOwn(sellerId, id);
}

async function updateOwn(sellerId, id, payload) {
  await validateMasterCodes(payload);
  const existing = await loadOwnOrThrow(sellerId, id);
  if (existing.approval_status === 'approved') {
    throw new HttpError(
      409,
      'NOT_EDITABLE',
      'This listing is already approved and live. Contact support to request a change.',
    );
  }
  await wp.update(id, payload);
  return getOwn(sellerId, id);
}

async function removeOwn(sellerId, id) {
  await loadOwnOrThrow(sellerId, id);
  await wp.softDelete(id);
}

async function addImages(sellerId, id, files) {
  await loadOwnOrThrow(sellerId, id);
  await imageUpload.persistImages({ propertyKind: 'website', propertyId: id, files });
  return getOwn(sellerId, id);
}

// Add amenity thumbnails. `names` is a string[] in the same order as `files`
// — each name is stamped into the file's `originalname` so it persists into
// `property_files.original_name` and serves as the amenity label.
async function addAmenities(sellerId, id, files, names) {
  await loadOwnOrThrow(sellerId, id);
  if (!files || files.length === 0) {
    throw new HttpError(400, 'NO_FILES', 'No amenity images uploaded');
  }
  if (!Array.isArray(names) || names.length !== files.length) {
    throw new HttpError(400, 'NAMES_MISMATCH', 'One name required per amenity image');
  }
  const tagged = files.map((f, i) => {
    const label = String(names[i] || '').trim();
    if (!label) throw new HttpError(400, 'EMPTY_AMENITY_NAME', `Amenity #${i + 1} is missing a name`);
    return { ...f, originalname: label.slice(0, 100) };
  });
  await imageUpload.persistImages({
    propertyKind: 'website',
    propertyId: id,
    files: tagged,
    fileKind: 'amenity',
  });
  return getOwn(sellerId, id);
}

async function removeAmenity(sellerId, id, fileId) {
  await loadOwnOrThrow(sellerId, id);
  await imageUpload.deleteImage({ fileId, propertyKind: 'website', propertyId: id });
  return getOwn(sellerId, id);
}

async function removeImage(sellerId, id, fileId) {
  await loadOwnOrThrow(sellerId, id);
  await imageUpload.deleteImage({ fileId, propertyKind: 'website', propertyId: id });
  return getOwn(sellerId, id);
}

async function loadOwnOrThrow(sellerId, id) {
  const row = await wp.findById(id);
  if (!row || Number(row.seller_id) !== Number(sellerId)) {
    // Mirror the "not found" response for both unknown and not-owned rows
    // so seller can't probe other sellers' property ids.
    throw new HttpError(404, 'NOT_FOUND', 'Property not found');
  }
  return row;
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toDetail(row, images, amenityFiles = []) {
  return {
    ...toListItem(row),
    description: row.description,
    latitude: row.latitude !== null ? Number(row.latitude) : null,
    longitude: row.longitude !== null ? Number(row.longitude) : null,
    details: parseDetailsField(row.details),
    images: images.map((f) => ({
      id: f.id,
      url: `${PUBLIC_URL_PREFIX}/${f.stored_name}`,
      originalName: f.original_name,
      mimeType: f.mime_type,
      sizeBytes: Number(f.size_bytes),
      sortOrder: f.sort_order,
    })),
    // Amenity thumbnails — { id, name, imageUrl } per item. Name lives in
    // original_name. UI renders them in a grid below the main gallery.
    amenities: amenityFiles.map((f) => ({
      id: f.id,
      name: f.original_name,
      imageUrl: `${PUBLIC_URL_PREFIX}/${f.stored_name}`,
      sortOrder: f.sort_order,
    })),
  };
}

// MySQL JSON columns can come back either as a parsed object (newer mysql2
// builds) or as a raw string. Normalise so the API always returns an object.
function parseDetailsField(raw) {
  if (raw === null || raw === undefined) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw) || {}; } catch { return {}; }
}

module.exports = {
  listOwn,
  getOwn,
  createOwn,
  updateOwn,
  removeOwn,
  addImages,
  removeImage,
  addAmenities,
  removeAmenity,
};
