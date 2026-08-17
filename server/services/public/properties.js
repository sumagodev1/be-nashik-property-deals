// ============================================================
// services/public/properties.js — public-facing property service layer
// ============================================================
// PUBLIC / ADMIN BOUNDARY (T-2026-141):
//   This service serves the public website's property list + detail
//   endpoints (/api/public/properties/*). It composes only against
//   `website_properties` (via publicProps below). It MUST NOT import
//   or touch inventory_properties or inventory_property_units. Builder
//   Property masters and their units are ADMIN-ONLY per T-2026-136
//   spec sections 12 / 26 / T13-T14. See the header comment in
//   db/queries/public_properties.js for the enforcement rules that
//   MUST be applied if a future ticket ever adds an inventory-backed
//   public surface.
// ============================================================

const { HttpError } = require('../../middleware/errors');
const publicProps = require('../../db/queries/public_properties');
const propertyFiles = require('../../db/queries/property_files');
// T-2026-171: reuse the SAME Key PIN source of truth that gates admin
// View/Edit/Delete/Share. No parallel PIN system — the /verify contract
// (bcrypt-compare over active hashes, 401 INVALID_PIN on miss) is
// invoked directly at the service layer so the route only wires
// Joi + rate-limit around it.
const keyPins = require('../security/key_pins');

const { PUBLIC_URL_PREFIX } = require('../files/publicUrl');

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
  // Fire-and-forget view counter bump for seller analytics. Detail response
  // serves regardless of whether the counter update succeeds.
  publicProps.incrementViewCount(row.id).catch((err) => {
    // eslint-disable-next-line no-console
    console.warn('[view-count] increment failed:', err.message);
  });
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

async function similar({ id, limit = 4 }) {
  const source = await publicProps.findByIdentifier(String(id));
  if (!source) throw new HttpError(404, 'NOT_FOUND', 'Property not found');
  const rows = await publicProps.listSimilar({
    excludeId: source.id,
    propertyType: source.property_type,
    transactionType: source.transaction_type,
    price: source.price,
    limit,
  });
  return rows.map(toListItem);
}

/**
 * T-2026-171: reveal the owner block for a public property, guarded by
 * the shared 6-digit Key PIN.
 *
 * Called by POST /api/public/properties/:identifier/owner-details.
 *
 * Order matters:
 *   1. VERIFY THE PIN FIRST. A wrong PIN must not leak whether the
 *      property exists (though existence is otherwise public through the
 *      GET detail endpoint, keeping the ordering keeps the failure
 *      surface uniform + means the timing side-channel on the property
 *      lookup can't be probed unauthenticated).
 *   2. Look up the property + seller via the SAME PUBLIC_WHERE gates
 *      the rest of the public surface uses (approved + active + not
 *      deleted). Any drift here would leak drafts.
 *   3. Return ONLY owner-facing fields. Never include seller_id (the
 *      internal PK is admin-scoped concern) or any timestamps.
 *
 * Response shape:
 *   { owner: { fullName, userType, mobileNumber, alternateContact?,
 *              email?, agencyName?, businessAddress?, area? } }
 * Nullable fields are OMITTED (not sent as null) so the FE doesn't
 * render empty "Email: —" rows for sellers who haven't filled optional
 * fields. `fullName`, `userType`, `mobileNumber` are always required
 * (the sellers table constrains them NOT NULL).
 */
async function revealOwnerDetails(identifier, { pin } = {}) {
  // 1. PIN check first — throws HttpError(401, 'INVALID_PIN', ...) on miss.
  //    keyPins.verify also validates PIN shape (400 INVALID_PIN if not 6 digits).
  await keyPins.verify({ pin });

  // 2. Property + seller lookup.
  const row = await publicProps.findPublicPropertyOwner(identifier);
  if (!row) {
    // Consistent with the GET /:identifier 404.
    throw new HttpError(404, 'NOT_FOUND', 'Property not found');
  }

  // 3. Shape the response — omit falsy/nullish optionals.
  const owner = {
    fullName: row.full_name,
    userType: row.user_type,
    mobileNumber: row.mobile_number,
  };
  if (row.alternate_contact) owner.alternateContact = row.alternate_contact;
  if (row.email) owner.email = row.email;
  if (row.agency_name) owner.agencyName = row.agency_name;
  if (row.business_address) owner.businessAddress = row.business_address;
  if (row.area) owner.area = row.area;

  return { owner };
}

module.exports = { listPublic, getPublic, featured, latest, similar, revealOwnerDetails };
