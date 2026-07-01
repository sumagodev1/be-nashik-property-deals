const { pool } = require('../pool');

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
    where.push(
      '(property_code LIKE ? OR title LIKE ? OR location LIKE ? OR property_type LIKE ? OR owner_name LIKE ? OR agent_name LIKE ? OR owner_contact LIKE ? OR agent_contact LIKE ?)',
    );
    const s = `%${search}%`;
    params.push(s, s, s, s, s, s, s, s);
  }
  if (propertyType) {
    where.push('property_type = ?');
    params.push(propertyType);
  }
  if (transactionType) {
    where.push('transaction_type = ?');
    params.push(transactionType);
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
    `SELECT COUNT(*) AS total FROM inventory_properties ${whereSql}`,
    params,
  );

  const [rows] = await pool.query(
    `SELECT id, property_code, registration_date, title,
            property_type, transaction_type, transaction_variant,
            location, district, taluka, shivar, latitude, longitude, pincode,
            area_value, area_unit, bhk, price, status, status_note, status_changed_at,
            is_draft, owner_name, owner_contact,
            agent_name, agent_contact, created_at, updated_at
     FROM inventory_properties
     ${whereSql}
     ${orderSql}
     LIMIT ? OFFSET ?`,
    [...params, pageSize, offset],
  );

  return { rows, total };
}

async function findById(id) {
  const [rows] = await pool.query(
    `SELECT * FROM inventory_properties WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
    [id],
  );
  return rows[0] || null;
}

async function findByIdForConn(conn, id) {
  const [rows] = await conn.query(
    `SELECT * FROM inventory_properties WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
    [id],
  );
  return rows[0] || null;
}

async function create(payload) {
  const detailsJson = payload.details && Object.keys(payload.details).length
    ? JSON.stringify(payload.details)
    : null;
  const [result] = await pool.query(
    `INSERT INTO inventory_properties
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
  await pool.query('UPDATE inventory_properties SET property_code = ? WHERE id = ?', [code, id]);
}

async function update(id, payload) {
  const detailsJson = payload.details && Object.keys(payload.details).length
    ? JSON.stringify(payload.details)
    : null;
  await pool.query(
    `UPDATE inventory_properties SET
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
    `UPDATE inventory_properties
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
    `UPDATE inventory_properties SET deleted_at = NOW() WHERE id = ? AND deleted_at IS NULL`,
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
