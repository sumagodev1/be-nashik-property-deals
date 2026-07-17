const { pool } = require('../pool');

const SORTABLE_COLUMNS = {
  created_at: 'wp.created_at',
  price: 'wp.price',
  location: 'wp.location',
  property_type: 'wp.property_type',
  title: 'wp.title',
  approved_at: 'wp.approved_at',
};

function buildOrderBy(sort) {
  const [col, dir] = (sort || 'created_at:desc').split(':');
  const safeCol = SORTABLE_COLUMNS[col] || 'wp.created_at';
  const safeDir = dir && dir.toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  return `ORDER BY ${safeCol} ${safeDir}, wp.id DESC`;
}

async function list({
  page,
  pageSize,
  search,
  propertyType,
  transactionType,
  propertyVariety,
  approvalStatus,
  isActive,
  isFeatured,
  location,
  district,
  taluka,
  shivar,
  ownerSearch,
  priceMin,
  priceMax,
  dateFrom,
  dateTo,
  sort,
}) {
  const offset = (page - 1) * pageSize;
  const where = ['wp.deleted_at IS NULL'];
  const params = [];

  if (search) {
    where.push(
      '(wp.property_code LIKE ? OR wp.title LIKE ? OR wp.location LIKE ? OR wp.property_type LIKE ? OR s.full_name LIKE ? OR s.email LIKE ? OR s.mobile_number LIKE ?)',
    );
    const s = `%${search}%`;
    params.push(s, s, s, s, s, s, s);
  }
  if (propertyType) { where.push('wp.property_type = ?'); params.push(propertyType); }
  if (transactionType) { where.push('wp.transaction_type = ?'); params.push(transactionType); }
  // property_variety lives inside the details JSON blob (the public
  // AddPropertyPage writes payload.details.property_variety at submit time);
  // no dedicated column exists on website_properties. Filter with a JSON
  // path lookup so the migration surface stays minimal.
  if (propertyVariety) {
    where.push("JSON_UNQUOTE(JSON_EXTRACT(wp.details, '$.property_variety')) = ?");
    params.push(propertyVariety);
  }
  if (approvalStatus) { where.push('wp.approval_status = ?'); params.push(approvalStatus); }
  if (typeof isActive === 'boolean') { where.push('wp.is_active = ?'); params.push(isActive ? 1 : 0); }
  if (typeof isFeatured === 'boolean') { where.push('wp.is_featured = ?'); params.push(isFeatured ? 1 : 0); }
  if (location) { where.push('wp.location LIKE ?'); params.push(`%${location}%`); }
  if (district) { where.push('wp.district = ?'); params.push(district); }
  if (taluka) { where.push('wp.taluka = ?'); params.push(taluka); }
  if (shivar) { where.push('wp.shivar = ?'); params.push(shivar); }
  // Owner Search — matches ONLY owner / contact fields on the joined
  // sellers row. Never touches wp.title / wp.description / wp.location /
  // wp.property_type / etc. Separate from `search` above, which is the
  // broader property-level search.
  if (ownerSearch) {
    where.push(
      '(s.full_name LIKE ? OR s.mobile_number LIKE ? OR s.alternate_contact LIKE ? OR s.email LIKE ? OR s.agency_name LIKE ?)',
    );
    const o = `%${ownerSearch}%`;
    params.push(o, o, o, o, o);
  }
  if (priceMin !== undefined) { where.push('wp.price >= ?'); params.push(priceMin); }
  if (priceMax !== undefined) { where.push('wp.price <= ?'); params.push(priceMax); }
  if (dateFrom) { where.push('wp.created_at >= ?'); params.push(dateFrom); }
  if (dateTo) { where.push('wp.created_at < DATE_ADD(?, INTERVAL 1 DAY)'); params.push(dateTo); }

  const whereSql = `WHERE ${where.join(' AND ')}`;
  const orderSql = buildOrderBy(sort);

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM website_properties wp LEFT JOIN sellers s ON s.id = wp.seller_id ${whereSql}`,
    params,
  );

  const [rows] = await pool.query(
    `SELECT
       wp.id, wp.property_code, wp.title, wp.property_type, wp.transaction_type, wp.location,
       wp.district, wp.taluka, wp.shivar, wp.pincode,
       wp.area_value, wp.area_unit, wp.bhk, wp.price, wp.details,
       wp.approval_status, wp.is_active, wp.is_featured,
       wp.approved_at, wp.rejection_reason, wp.created_at, wp.updated_at,
       wp.seller_id, s.full_name AS seller_name, s.user_type AS seller_type, s.email AS seller_email, s.mobile_number AS seller_mobile,
       (SELECT COUNT(*) FROM leads l WHERE l.website_property_id = wp.id AND l.deleted_at IS NULL) AS leads_count
     FROM website_properties wp
     LEFT JOIN sellers s ON s.id = wp.seller_id
     ${whereSql}
     ${orderSql}
     LIMIT ? OFFSET ?`,
    [...params, pageSize, offset],
  );

  return { rows, total };
}

async function findById(id) {
  const [rows] = await pool.query(
    `SELECT
       wp.*,
       s.full_name AS seller_name, s.user_type AS seller_type,
       s.email AS seller_email, s.mobile_number AS seller_mobile, s.agency_name AS seller_agency,
       (SELECT COUNT(*) FROM leads l WHERE l.website_property_id = wp.id AND l.deleted_at IS NULL) AS leads_count
     FROM website_properties wp
     LEFT JOIN sellers s ON s.id = wp.seller_id
     WHERE wp.id = ? AND wp.deleted_at IS NULL
     LIMIT 1`,
    [id],
  );
  return rows[0] || null;
}

async function create(payload) {
  const detailsJson = payload.details && Object.keys(payload.details).length
    ? JSON.stringify(payload.details)
    : null;
  const [result] = await pool.query(
    `INSERT INTO website_properties
     (property_code, seller_id, title, description, property_type, transaction_type, location,
      district, taluka, shivar, pincode,
      latitude, longitude, area_value, area_unit, bhk, price,
      approval_status, is_active, details)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      payload.propertyCode,
      payload.sellerId,
      payload.title,
      payload.description || null,
      payload.propertyType,
      payload.transactionType,
      payload.location,
      payload.district || null,
      payload.taluka || null,
      payload.shivar || null,
      payload.pincode || null,
      payload.latitude ?? null,
      payload.longitude ?? null,
      payload.areaValue ?? null,
      payload.areaUnit || null,
      payload.bhk || null,
      payload.price,
      payload.approvalStatus || 'pending',
      payload.isActive === false ? 0 : 1,
      detailsJson,
    ],
  );
  return result.insertId;
}

async function updatePropertyCode(id, code) {
  await pool.query('UPDATE website_properties SET property_code = ? WHERE id = ?', [code, id]);
}

async function update(id, payload) {
  const detailsJson = payload.details && Object.keys(payload.details).length
    ? JSON.stringify(payload.details)
    : null;
  // Location cascade columns use COALESCE(?, existing) so callers that omit
  // them (e.g. the admin edit form, which doesn't render the cascade) don't
  // silently wipe the seller-provided values. Passing an explicit '' or a
  // fresh code still overwrites.
  await pool.query(
    `UPDATE website_properties SET
       title = ?, description = ?, property_type = ?, transaction_type = ?, location = ?,
       district = COALESCE(?, district),
       taluka   = COALESCE(?, taluka),
       shivar   = COALESCE(?, shivar),
       pincode  = COALESCE(?, pincode),
       latitude = ?, longitude = ?, area_value = ?, area_unit = ?, bhk = ?, price = ?,
       details = ?
     WHERE id = ? AND deleted_at IS NULL`,
    [
      payload.title,
      payload.description || null,
      payload.propertyType,
      payload.transactionType,
      payload.location,
      payload.district === undefined ? null : (payload.district || null),
      payload.taluka === undefined ? null : (payload.taluka || null),
      payload.shivar === undefined ? null : (payload.shivar || null),
      payload.pincode === undefined ? null : (payload.pincode || null),
      payload.latitude ?? null,
      payload.longitude ?? null,
      payload.areaValue ?? null,
      payload.areaUnit || null,
      payload.bhk || null,
      payload.price,
      detailsJson,
      id,
    ],
  );
}

async function approve(id, approvedByAdminId) {
  await pool.query(
    `UPDATE website_properties
     SET approval_status = 'approved', approved_by_admin_id = ?, approved_at = NOW(), rejection_reason = NULL
     WHERE id = ? AND deleted_at IS NULL`,
    [approvedByAdminId, id],
  );
}

async function reject(id, approvedByAdminId, reason) {
  await pool.query(
    `UPDATE website_properties
     SET approval_status = 'rejected', approved_by_admin_id = ?, approved_at = NOW(), rejection_reason = ?
     WHERE id = ? AND deleted_at IS NULL`,
    [approvedByAdminId, reason || null, id],
  );
}

async function setActive(id, isActive) {
  await pool.query(
    `UPDATE website_properties SET is_active = ? WHERE id = ? AND deleted_at IS NULL`,
    [isActive ? 1 : 0, id],
  );
}

async function setFeatured(id, isFeatured) {
  await pool.query(
    `UPDATE website_properties SET is_featured = ? WHERE id = ? AND deleted_at IS NULL`,
    [isFeatured ? 1 : 0, id],
  );
}

async function softDelete(id) {
  await pool.query(
    `UPDATE website_properties SET deleted_at = NOW(), is_active = 0 WHERE id = ? AND deleted_at IS NULL`,
    [id],
  );
}

module.exports = {
  list,
  findById,
  create,
  updatePropertyCode,
  update,
  approve,
  reject,
  setActive,
  setFeatured,
  softDelete,
};
