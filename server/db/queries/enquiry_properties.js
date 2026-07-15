const { pool } = require('../pool');

// Structural mirror of db/queries/inventory_properties.js — same shape,
// same sortable columns, same list filters, same soft-delete convention.
// The only difference is the target table: enquiry_properties (see
// migrations/048_enquiry_properties.sql). Kept as a sibling module rather
// than a factory so a search for "SELECT ... FROM enquiry_properties" lands
// directly on the code path that runs it.

const SORTABLE_COLUMNS = {
  created_at: 'created_at',
  price: 'price',
  location: 'location',
  property_type: 'property_type',
  title: 'title',
};

function buildOrderBy(sort) {
  const [col, dir] = (sort || 'created_at:desc').split(':');
  const safeCol = SORTABLE_COLUMNS[col] || 'created_at';
  const safeDir = dir && dir.toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  return `ORDER BY ${safeCol} ${safeDir}, id DESC`;
}

async function list({
  page,
  pageSize,
  search,
  propertyType,
  transactionType,
  // Cascading filter additions (2026-07-14) — kept in sync with the
  // parallel block in db/queries/inventory_properties.js. See that file
  // for the full contract; the two list functions are mirrors by design.
  district,
  taluka,
  shivar,
  propertyTypeIn,
  status,
  location,
  priceMin,
  priceMax,
  dateFrom,
  dateTo,
  sort,
  isDraft,
}) {
  const offset = (page - 1) * pageSize;
  const where = ['deleted_at IS NULL'];
  const params = [];

  if (search) {
    // Mirrors the Global Search rules on inventory_properties — see the
    // parallel comment block there for the full field list and rationale.
    // Kept identical (not factored) because the SQL runs against a
    // different table; extracting a shared string would add indirection
    // without saving code.
    where.push(`(
      property_code LIKE ? OR title LIKE ? OR description LIKE ?
      OR location LIKE ?
      OR property_type LIKE ? OR transaction_type LIKE ? OR transaction_variant LIKE ?
      OR status LIKE ? OR status_note LIKE ?
      OR district LIKE ? OR taluka LIKE ? OR shivar LIKE ? OR pincode LIKE ?
      OR bhk LIKE ? OR area_unit LIKE ?
      OR owner_name LIKE ? OR agent_name LIKE ?
      OR owner_contact LIKE ? OR agent_contact LIKE ?
      OR CAST(price AS CHAR) LIKE ? OR CAST(area_value AS CHAR) LIKE ?
      OR details LIKE ?
    )`);
    const s = `%${search}%`;
    for (let i = 0; i < 22; i++) params.push(s);
  }
  if (propertyType) {
    where.push('property_type = ?');
    params.push(propertyType);
  }
  if (transactionType) {
    where.push('transaction_type = ?');
    params.push(transactionType);
  }
  // Cascading filter — mirror of db/queries/inventory_properties.js.
  if (typeof propertyTypeIn === 'string' && propertyTypeIn.trim() !== '') {
    const labels = Array.from(new Set(
      propertyTypeIn.split(',').map((s) => s.trim()).filter(Boolean),
    )).slice(0, 200);
    if (labels.length > 0) {
      where.push(`property_type IN (${labels.map(() => '?').join(', ')})`);
      params.push(...labels);
    }
  }
  if (district) {
    where.push('district = ?');
    params.push(district);
  }
  if (taluka) {
    where.push('taluka = ?');
    params.push(taluka);
  }
  if (shivar) {
    where.push('shivar = ?');
    params.push(shivar);
  }
  if (status) {
    where.push('status = ?');
    params.push(status);
  }
  if (location) {
    where.push('location LIKE ?');
    params.push(`%${location}%`);
  }
  if (priceMin !== undefined) {
    where.push('price >= ?');
    params.push(priceMin);
  }
  if (priceMax !== undefined) {
    where.push('price <= ?');
    params.push(priceMax);
  }
  if (dateFrom) {
    where.push('created_at >= ?');
    params.push(dateFrom);
  }
  if (dateTo) {
    where.push('created_at < DATE_ADD(?, INTERVAL 1 DAY)');
    params.push(dateTo);
  }
  if (typeof isDraft === 'boolean') {
    where.push('is_draft = ?');
    params.push(isDraft ? 1 : 0);
  }

  const whereSql = `WHERE ${where.join(' AND ')}`;
  const orderSql = buildOrderBy(sort);

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM enquiry_properties ${whereSql}`,
    params,
  );

  const [rows] = await pool.query(
    `SELECT id, property_code, registration_date, title, description,
            property_type, transaction_type, transaction_variant,
            location, district, taluka, shivar, latitude, longitude, pincode,
            area_value, area_unit, bhk, price, status, status_note, status_changed_at,
            is_draft, owner_name, owner_contact,
            agent_name, agent_contact, details, created_at, updated_at
     FROM enquiry_properties
     ${whereSql}
     ${orderSql}
     LIMIT ? OFFSET ?`,
    [...params, pageSize, offset],
  );

  return { rows, total };
}

async function findById(id) {
  const [rows] = await pool.query(
    `SELECT * FROM enquiry_properties WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
    [id],
  );
  return rows[0] || null;
}

async function findByIdForConn(conn, id) {
  const [rows] = await conn.query(
    `SELECT * FROM enquiry_properties WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
    [id],
  );
  return rows[0] || null;
}

async function create(payload) {
  const detailsJson = payload.details && Object.keys(payload.details).length
    ? JSON.stringify(payload.details)
    : null;
  const [result] = await pool.query(
    `INSERT INTO enquiry_properties
     (property_code, registration_date, title, description, property_type,
      transaction_type, transaction_variant, location, district, taluka, shivar,
      latitude, longitude, pincode,
      area_value, area_unit, bhk, price, status, is_draft,
      owner_name, owner_contact, agent_name, agent_contact, details, created_by_admin_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      payload.propertyCode,
      payload.registrationDate || null,
      payload.title,
      payload.description || null,
      payload.propertyType,
      payload.transactionType,
      payload.transactionVariant || null,
      payload.location,
      payload.district || null,
      payload.taluka || null,
      payload.shivar || null,
      payload.latitude ?? null,
      payload.longitude ?? null,
      payload.pincode || null,
      payload.areaValue ?? null,
      payload.areaUnit || null,
      payload.bhk || null,
      payload.price,
      payload.status || 'available',
      payload.isDraft ? 1 : 0,
      payload.ownerName || null,
      payload.ownerContact || null,
      payload.agentName || null,
      payload.agentContact || null,
      detailsJson,
      payload.createdByAdminId || null,
    ],
  );
  return result.insertId;
}

async function updatePropertyCode(id, code) {
  await pool.query('UPDATE enquiry_properties SET property_code = ? WHERE id = ?', [code, id]);
}

async function update(id, payload) {
  const detailsJson = payload.details && Object.keys(payload.details).length
    ? JSON.stringify(payload.details)
    : null;
  await pool.query(
    `UPDATE enquiry_properties SET
       registration_date = ?, title = ?, description = ?,
       property_type = ?, transaction_type = ?, transaction_variant = ?,
       location = ?, district = ?, taluka = ?, shivar = ?,
       latitude = ?, longitude = ?, pincode = ?,
       area_value = ?, area_unit = ?, bhk = ?, price = ?, status = ?, is_draft = ?,
       owner_name = ?, owner_contact = ?, agent_name = ?, agent_contact = ?, details = ?
     WHERE id = ? AND deleted_at IS NULL`,
    [
      payload.registrationDate || null,
      payload.title,
      payload.description || null,
      payload.propertyType,
      payload.transactionType,
      payload.transactionVariant || null,
      payload.location,
      payload.district || null,
      payload.taluka || null,
      payload.shivar || null,
      payload.latitude ?? null,
      payload.longitude ?? null,
      payload.pincode || null,
      payload.areaValue ?? null,
      payload.areaUnit || null,
      payload.bhk || null,
      payload.price,
      payload.status,
      payload.isDraft ? 1 : 0,
      payload.ownerName || null,
      payload.ownerContact || null,
      payload.agentName || null,
      payload.agentContact || null,
      detailsJson,
      id,
    ],
  );
}

async function updateStatus(id, status, note, changedBy) {
  await pool.query(
    `UPDATE enquiry_properties
        SET status            = ?,
            status_note       = ?,
            status_changed_at = NOW(),
            status_changed_by = ?
      WHERE id = ? AND deleted_at IS NULL`,
    [status, note && note.trim() ? note.trim() : null, changedBy || null, id],
  );
}

async function softDelete(id) {
  await pool.query(
    `UPDATE enquiry_properties SET deleted_at = NOW() WHERE id = ? AND deleted_at IS NULL`,
    [id],
  );
}

module.exports = {
  list,
  findById,
  findByIdForConn,
  create,
  updatePropertyCode,
  update,
  updateStatus,
  softDelete,
};
