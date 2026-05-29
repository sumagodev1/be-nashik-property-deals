const { pool } = require('../pool');

async function findById(id) {
  const [rows] = await pool.query(
    `SELECT id, user_type, full_name, mobile_number, email, alternate_contact,
            agency_name, business_address, area, is_active, is_verified, created_at, updated_at
     FROM sellers
     WHERE id = ? AND deleted_at IS NULL
     LIMIT 1`,
    [id],
  );
  return rows[0] || null;
}

async function findActiveById(id) {
  const [rows] = await pool.query(
    `SELECT id, user_type, full_name, mobile_number, email, alternate_contact,
            agency_name, business_address, area, is_active, is_verified
     FROM sellers
     WHERE id = ? AND deleted_at IS NULL AND is_active = 1
     LIMIT 1`,
    [id],
  );
  return rows[0] || null;
}

async function findByMobile(mobileNumber) {
  const [rows] = await pool.query(
    `SELECT id, user_type, full_name, mobile_number, email, is_active, is_verified
     FROM sellers
     WHERE mobile_number = ? AND deleted_at IS NULL
     LIMIT 1`,
    [mobileNumber],
  );
  return rows[0] || null;
}

async function findByEmail(email) {
  const [rows] = await pool.query(
    `SELECT id, user_type, full_name, mobile_number, email, is_active, is_verified
     FROM sellers
     WHERE email = ? AND deleted_at IS NULL
     LIMIT 1`,
    [email],
  );
  return rows[0] || null;
}

async function findActiveVerifiedByEmail(email) {
  const [rows] = await pool.query(
    `SELECT id, user_type, full_name, mobile_number, email, is_active, is_verified
     FROM sellers
     WHERE email = ? AND deleted_at IS NULL AND is_active = 1 AND is_verified = 1
     LIMIT 1`,
    [email],
  );
  return rows[0] || null;
}

async function findActiveVerifiedByMobile(mobileNumber) {
  const [rows] = await pool.query(
    `SELECT id, user_type, full_name, mobile_number, email, is_active, is_verified
     FROM sellers
     WHERE mobile_number = ? AND deleted_at IS NULL AND is_active = 1 AND is_verified = 1
     LIMIT 1`,
    [mobileNumber],
  );
  return rows[0] || null;
}

// Verified-but-possibly-inactive lookup — used by the login flow so we can
// distinguish "no such account / not verified" (silent OTP no-op) from
// "account was deactivated by admin" (explicit error to the user).
async function findVerifiedByMobile(mobileNumber) {
  const [rows] = await pool.query(
    `SELECT id, user_type, full_name, mobile_number, email, is_active, is_verified
     FROM sellers
     WHERE mobile_number = ? AND deleted_at IS NULL AND is_verified = 1
     LIMIT 1`,
    [mobileNumber],
  );
  return rows[0] || null;
}

// Same as findVerifiedByMobile but keyed by email. Used by email-based login
// so we can tell apart "no such account" / "deactivated" / "active".
async function findVerifiedByEmail(email) {
  const [rows] = await pool.query(
    `SELECT id, user_type, full_name, mobile_number, email, is_active, is_verified
     FROM sellers
     WHERE email = ? AND deleted_at IS NULL AND is_verified = 1
     LIMIT 1`,
    [email],
  );
  return rows[0] || null;
}

async function create(payload) {
  const [result] = await pool.query(
    `INSERT INTO sellers
       (user_type, full_name, mobile_number, email, alternate_contact, agency_name, business_address, area, is_verified)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    [
      payload.userType,
      payload.fullName,
      payload.mobileNumber,
      payload.email,
      payload.alternateContact || null,
      payload.agencyName || null,
      payload.businessAddress || null,
      payload.area || null,
    ],
  );
  return result.insertId;
}

async function updateRegistrationDraft(id, payload) {
  await pool.query(
    `UPDATE sellers SET
       user_type = ?, full_name = ?, email = ?, agency_name = ?, business_address = ?, area = ?
     WHERE id = ? AND deleted_at IS NULL AND is_verified = 0`,
    [
      payload.userType,
      payload.fullName,
      payload.email,
      payload.agencyName || null,
      payload.businessAddress || null,
      payload.area || null,
      id,
    ],
  );
}

async function markVerified(id) {
  await pool.query(
    `UPDATE sellers SET is_verified = 1 WHERE id = ? AND deleted_at IS NULL`,
    [id],
  );
}

async function updateProfile(id, payload) {
  await pool.query(
    `UPDATE sellers SET
       full_name = ?, email = ?, alternate_contact = ?, agency_name = ?, business_address = ?, area = ?
     WHERE id = ? AND deleted_at IS NULL`,
    [
      payload.fullName,
      payload.email,
      payload.alternateContact || null,
      payload.agencyName || null,
      payload.businessAddress || null,
      payload.area || null,
      id,
    ],
  );
}

/**
 * Admin user-management list. Joins website_properties for listing counts.
 */
async function listForAdmin({ page, pageSize, search, userType, isActive, isVerified, dateFrom, dateTo, sort }) {
  const where = ['s.deleted_at IS NULL'];
  const params = [];

  if (search) {
    where.push('(s.full_name LIKE ? OR s.mobile_number LIKE ? OR s.email LIKE ? OR s.agency_name LIKE ?)');
    const t = `%${search}%`;
    params.push(t, t, t, t);
  }
  if (userType) { where.push('s.user_type = ?'); params.push(userType); }
  if (typeof isActive === 'boolean') { where.push('s.is_active = ?'); params.push(isActive ? 1 : 0); }
  if (typeof isVerified === 'boolean') { where.push('s.is_verified = ?'); params.push(isVerified ? 1 : 0); }
  if (dateFrom) { where.push('s.created_at >= ?'); params.push(dateFrom); }
  if (dateTo) { where.push('s.created_at < DATE_ADD(?, INTERVAL 1 DAY)'); params.push(dateTo); }

  const whereSql = `WHERE ${where.join(' AND ')}`;

  // Sort whitelist — no user-supplied column names ever touch SQL.
  const SORT = {
    'created_at:desc': 's.created_at DESC, s.id DESC',
    'created_at:asc': 's.created_at ASC, s.id ASC',
    'full_name:asc': 's.full_name ASC, s.id DESC',
    'full_name:desc': 's.full_name DESC, s.id DESC',
    'listing_count:desc': 'listing_count DESC, s.id DESC',
  };
  const orderSql = `ORDER BY ${SORT[sort] || SORT['created_at:desc']}`;
  const offset = (page - 1) * pageSize;

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM sellers s ${whereSql}`,
    params,
  );

  const [rows] = await pool.query(
    `SELECT s.id, s.user_type, s.full_name, s.mobile_number, s.email,
            s.alternate_contact, s.agency_name, s.business_address, s.area,
            s.is_active, s.is_verified, s.created_at, s.updated_at,
            (SELECT COUNT(*) FROM website_properties wp
             WHERE wp.seller_id = s.id AND wp.deleted_at IS NULL) AS listing_count
     FROM sellers s
     ${whereSql}
     ${orderSql}
     LIMIT ? OFFSET ?`,
    [...params, pageSize, offset],
  );

  return { rows, total };
}

async function listForExport(filters) {
  // Reuse the same WHERE assembly via list() but skip pagination.
  const { rows } = await listForAdmin({ ...filters, page: 1, pageSize: 5000 });
  return rows;
}

async function findWithListingCount(id) {
  const [rows] = await pool.query(
    `SELECT s.*, (SELECT COUNT(*) FROM website_properties wp
                  WHERE wp.seller_id = s.id AND wp.deleted_at IS NULL) AS listing_count
     FROM sellers s
     WHERE s.id = ? AND s.deleted_at IS NULL
     LIMIT 1`,
    [id],
  );
  return rows[0] || null;
}

async function countActiveListingsForSeller(sellerId) {
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS n
     FROM website_properties
     WHERE seller_id = ? AND deleted_at IS NULL`,
    [sellerId],
  );
  return Number(rows[0]?.n || 0);
}

async function listRecentPropertiesForSeller(sellerId, { limit = 5 } = {}) {
  const [rows] = await pool.query(
    `SELECT id, property_code, title, location, price, approval_status, is_active, created_at
     FROM website_properties
     WHERE seller_id = ? AND deleted_at IS NULL
     ORDER BY created_at DESC, id DESC
     LIMIT ?`,
    [sellerId, limit],
  );
  return rows;
}

async function adminUpdateProfile(id, payload) {
  await pool.query(
    `UPDATE sellers SET
       full_name = ?, email = ?, alternate_contact = ?, agency_name = ?, business_address = ?, area = ?
     WHERE id = ? AND deleted_at IS NULL`,
    [
      payload.fullName,
      payload.email,
      payload.alternateContact || null,
      payload.agencyName || null,
      payload.businessAddress || null,
      payload.area || null,
      id,
    ],
  );
}

async function setActive(id, isActive) {
  await pool.query(
    `UPDATE sellers SET is_active = ? WHERE id = ? AND deleted_at IS NULL`,
    [isActive ? 1 : 0, id],
  );
}

async function softDelete(id) {
  // Free the mobile_number slot on the soft-deleted row by rewriting it
  // to a guaranteed-unique placeholder (`_DEL_<id>`). MySQL's unique index
  // ignores `deleted_at`, so without this rewrite a soft-deleted seller's
  // number permanently blocks re-registration with the same number.
  // VARCHAR(20) limit easily fits `_DEL_<id>` for any realistic id.
  await pool.query(
    `UPDATE sellers
       SET mobile_number = CONCAT('_DEL_', id),
           deleted_at = NOW(),
           is_active = 0
     WHERE id = ? AND deleted_at IS NULL`,
    [id],
  );
}

// Catch-up helper for sellers that were soft-deleted BEFORE the above fix
// was deployed (their mobile_number is still the original value, blocking
// re-registration). Called from the seller registerStart flow just before
// INSERT so a fresh signup with the same number succeeds.
async function releaseSoftDeletedMobile(mobileNumber) {
  await pool.query(
    `UPDATE sellers
       SET mobile_number = CONCAT('_DEL_', id)
     WHERE mobile_number = ? AND deleted_at IS NOT NULL`,
    [mobileNumber],
  );
}

module.exports = {
  findById,
  findActiveById,
  findByMobile,
  findByEmail,
  findActiveVerifiedByEmail,
  findActiveVerifiedByMobile,
  findVerifiedByMobile,
  findVerifiedByEmail,
  create,
  updateRegistrationDraft,
  markVerified,
  updateProfile,
  listForAdmin,
  listForExport,
  findWithListingCount,
  countActiveListingsForSeller,
  listRecentPropertiesForSeller,
  adminUpdateProfile,
  setActive,
  softDelete,
  releaseSoftDeletedMobile,
};
