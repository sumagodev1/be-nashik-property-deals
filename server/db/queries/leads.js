const { pool } = require('../pool');

const SORTABLE_COLUMNS = {
  created_at: 'l.created_at',
  status: 'l.status',
};

function buildOrderBy(sort) {
  const [col, dir] = (sort || 'created_at:desc').split(':');
  const safeCol = SORTABLE_COLUMNS[col] || 'l.created_at';
  const safeDir = dir && dir.toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  return `ORDER BY ${safeCol} ${safeDir}, l.id DESC`;
}

function buildWhere({ status, actionType, propertyId, propertyCode, search, dateFrom, dateTo, assignedTo }) {
  const where = ['l.deleted_at IS NULL'];
  const params = [];

  if (status) { where.push('l.status = ?'); params.push(status); }
  if (actionType) { where.push('l.action_type = ?'); params.push(actionType); }
  if (propertyId !== undefined) { where.push('l.website_property_id = ?'); params.push(propertyId); }
  if (propertyCode) { where.push('wp.property_code = ?'); params.push(propertyCode); }
  if (assignedTo === 'unassigned') {
    where.push('l.assigned_sub_admin_id IS NULL');
  } else if (assignedTo !== undefined && assignedTo !== null && assignedTo !== '') {
    where.push('l.assigned_sub_admin_id = ?');
    params.push(assignedTo);
  }
  if (search) {
    where.push('(l.buyer_name LIKE ? OR l.buyer_mobile LIKE ? OR l.buyer_email LIKE ? OR l.message LIKE ? OR wp.property_code LIKE ? OR wp.title LIKE ?)');
    const s = `%${search}%`;
    params.push(s, s, s, s, s, s);
  }
  if (dateFrom) { where.push('l.created_at >= ?'); params.push(dateFrom); }
  if (dateTo) { where.push('l.created_at < DATE_ADD(?, INTERVAL 1 DAY)'); params.push(dateTo); }

  return { whereSql: `WHERE ${where.join(' AND ')}`, params };
}

const BASE_SELECT = `
  SELECT l.id, l.website_property_id, l.action_type, l.buyer_name, l.buyer_mobile, l.buyer_email,
         l.message, l.status, l.closed_reason, l.notes, l.assigned_sub_admin_id,
         l.created_at, l.updated_at,
         wp.property_code, wp.title AS property_title, wp.location AS property_location,
         sa.full_name AS assigned_admin_name, sa.email AS assigned_admin_email
  FROM leads l
  LEFT JOIN website_properties wp ON wp.id = l.website_property_id
  LEFT JOIN sub_admins sa ON sa.id = l.assigned_sub_admin_id
`;

async function create({ websitePropertyId, actionType, buyerName, buyerMobile, buyerEmail, message }) {
  const [result] = await pool.query(
    `INSERT INTO leads (website_property_id, action_type, buyer_name, buyer_mobile, buyer_email, message)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [websitePropertyId, actionType, buyerName, buyerMobile, buyerEmail, message || null],
  );
  return result.insertId;
}

async function findById(id) {
  const [rows] = await pool.query(
    `${BASE_SELECT}
     WHERE l.id = ? AND l.deleted_at IS NULL
     LIMIT 1`,
    [id],
  );
  return rows[0] || null;
}

async function list(filters) {
  const { whereSql, params } = buildWhere(filters);
  const orderSql = buildOrderBy(filters.sort);
  const offset = (filters.page - 1) * filters.pageSize;

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total
     FROM leads l LEFT JOIN website_properties wp ON wp.id = l.website_property_id
     ${whereSql}`,
    params,
  );

  const [rows] = await pool.query(
    `${BASE_SELECT}
     ${whereSql}
     ${orderSql}
     LIMIT ? OFFSET ?`,
    [...params, filters.pageSize, offset],
  );

  return { rows, total };
}

async function listForExport(filters) {
  const { whereSql, params } = buildWhere(filters);
  const orderSql = buildOrderBy(filters.sort);

  // Cap export size; bigger needs go through pagination + multiple downloads.
  const [rows] = await pool.query(
    `${BASE_SELECT}
     ${whereSql}
     ${orderSql}
     LIMIT 5000`,
    params,
  );
  return rows;
}

async function updateStatus(id, status) {
  await pool.query(
    `UPDATE leads SET status = ? WHERE id = ? AND deleted_at IS NULL`,
    [status, id],
  );
}

async function updateNotes(id, notes) {
  await pool.query(
    `UPDATE leads SET notes = ? WHERE id = ? AND deleted_at IS NULL`,
    [notes || null, id],
  );
}

async function updateAssignment(id, assignedAdminId) {
  await pool.query(
    `UPDATE leads SET assigned_sub_admin_id = ? WHERE id = ? AND deleted_at IS NULL`,
    [assignedAdminId || null, id],
  );
}

async function softDelete(id) {
  await pool.query(
    `UPDATE leads SET deleted_at = NOW() WHERE id = ? AND deleted_at IS NULL`,
    [id],
  );
}

/**
 * Bulk-close every still-open lead on the same property, EXCEPT the lead
 * that just got won. Used when a sale closes — the property is going off
 * the market so any other buyers in the funnel are implicitly lost.
 * Returns the count of rows updated.
 */
async function closeSiblingsAsLost(websitePropertyId, exceptLeadId) {
  if (!websitePropertyId) return 0;
  const [result] = await pool.query(
    `UPDATE leads
        SET status = 'closed_lost',
            closed_reason = 'sibling_won'
      WHERE website_property_id = ?
        AND id <> ?
        AND status IN ('new', 'contacted', 'site_visit')
        AND deleted_at IS NULL`,
    [websitePropertyId, exceptLeadId],
  );
  return result.affectedRows || 0;
}

/**
 * Look up the seller (owner) of the property tied to a lead. Returns null
 * for general enquiries (no property), unverified-deleted sellers, etc.
 * Used by the lead-status notifier to email the seller when an admin marks
 * their lead as "contacted".
 */
async function findSellerForLead(leadId) {
  const [rows] = await pool.query(
    `SELECT s.id AS seller_id, s.full_name AS seller_name, s.email AS seller_email,
            s.user_type, wp.property_code, wp.title AS property_title
     FROM leads l
     INNER JOIN website_properties wp ON wp.id = l.website_property_id
     INNER JOIN sellers s ON s.id = wp.seller_id
     WHERE l.id = ?
       AND l.deleted_at IS NULL
       AND s.deleted_at IS NULL
       AND s.is_active = 1
     LIMIT 1`,
    [leadId],
  );
  return rows[0] || null;
}

module.exports = {
  create,
  findById,
  list,
  listForExport,
  updateStatus,
  updateNotes,
  updateAssignment,
  softDelete,
  findSellerForLead,
  closeSiblingsAsLost,
};
