const { pool } = require('../pool');

const SORTABLE_COLUMNS = {
  latest: 'wp.created_at',
  approved_at: 'wp.approved_at',
  price: 'wp.price',
};

function buildOrderBy(sort) {
  // Defaults to newest approved listings.
  if (sort === 'price_asc') return 'ORDER BY wp.price ASC, wp.id DESC';
  if (sort === 'price_desc') return 'ORDER BY wp.price DESC, wp.id DESC';
  return 'ORDER BY wp.approved_at DESC, wp.id DESC';
}

const PUBLIC_WHERE = `
  wp.approval_status = 'approved'
  AND wp.is_active = 1
  AND wp.deleted_at IS NULL
`;

async function list({ page, pageSize, search, propertyType, transactionType, location, priceMin, priceMax, sort }) {
  const offset = (page - 1) * pageSize;
  const where = [PUBLIC_WHERE];
  const params = [];

  if (search) {
    where.push('(wp.title LIKE ? OR wp.location LIKE ? OR wp.property_type LIKE ? OR wp.property_code LIKE ?)');
    const s = `%${search}%`;
    params.push(s, s, s, s);
  }
  if (propertyType) { where.push('wp.property_type = ?'); params.push(propertyType); }
  if (transactionType) { where.push('wp.transaction_type = ?'); params.push(transactionType); }
  if (location) { where.push('wp.location LIKE ?'); params.push(`%${location}%`); }
  if (priceMin !== undefined) { where.push('wp.price >= ?'); params.push(priceMin); }
  if (priceMax !== undefined) { where.push('wp.price <= ?'); params.push(priceMax); }

  const whereSql = `WHERE ${where.join(' AND ')}`;
  const orderSql = buildOrderBy(sort);

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM website_properties wp ${whereSql}`,
    params,
  );

  const [rows] = await pool.query(
    `SELECT wp.id, wp.property_code, wp.title, wp.description, wp.property_type, wp.transaction_type,
            wp.location, wp.latitude, wp.longitude, wp.area_value, wp.area_unit, wp.bhk, wp.price,
            wp.is_featured, wp.approved_at, wp.created_at,
            (SELECT pf.stored_name FROM property_files pf
             WHERE pf.property_kind = 'website' AND pf.property_id = wp.id AND pf.file_kind = 'image'
             ORDER BY pf.sort_order ASC, pf.id ASC LIMIT 1) AS cover_stored_name
     FROM website_properties wp
     ${whereSql}
     ${orderSql}
     LIMIT ? OFFSET ?`,
    [...params, pageSize, offset],
  );

  // Bulk-fetch the rest of each row's images (first 8) in one round-trip.
  if (rows.length > 0) {
    const ids = rows.map((r) => r.id);
    const [imgRows] = await pool.query(
      `SELECT property_id, id, stored_name, sort_order
       FROM property_files
       WHERE property_kind = 'website' AND file_kind = 'image' AND property_id IN (?)
       ORDER BY property_id ASC, sort_order ASC, id ASC`,
      [ids],
    );
    const byProperty = new Map(ids.map((id) => [id, []]));
    for (const r of imgRows) {
      const arr = byProperty.get(Number(r.property_id));
      if (arr && arr.length < 8) {
        arr.push({ id: r.id, storedName: r.stored_name });
      }
    }
    for (const row of rows) {
      row.image_list = byProperty.get(Number(row.id)) || [];
    }
  }

  return { rows, total };
}

async function findByIdentifier(identifier) {
  // Accept numeric id OR property code.
  const numeric = /^\d+$/.test(String(identifier));
  const [rows] = await pool.query(
    `SELECT wp.id, wp.property_code, wp.title, wp.description, wp.property_type, wp.transaction_type,
            wp.location, wp.latitude, wp.longitude, wp.area_value, wp.area_unit, wp.bhk, wp.price,
            wp.is_featured, wp.approved_at, wp.created_at, wp.details
     FROM website_properties wp
     WHERE ${PUBLIC_WHERE} AND (${numeric ? 'wp.id = ?' : 'wp.property_code = ?'})
     LIMIT 1`,
    [identifier],
  );
  return rows[0] || null;
}

async function attachImageList(rows) {
  if (rows.length === 0) return rows;
  const ids = rows.map((r) => r.id);
  const [imgRows] = await pool.query(
    `SELECT property_id, id, stored_name, sort_order
     FROM property_files
     WHERE property_kind = 'website' AND file_kind = 'image' AND property_id IN (?)
     ORDER BY property_id ASC, sort_order ASC, id ASC`,
    [ids],
  );
  const byProperty = new Map(ids.map((id) => [id, []]));
  for (const r of imgRows) {
    const arr = byProperty.get(Number(r.property_id));
    if (arr && arr.length < 8) arr.push({ id: r.id, storedName: r.stored_name });
  }
  for (const row of rows) row.image_list = byProperty.get(Number(row.id)) || [];
  return rows;
}

async function listFeatured({ limit }) {
  const [rows] = await pool.query(
    `SELECT wp.id, wp.property_code, wp.title, wp.description, wp.property_type, wp.transaction_type,
            wp.location, wp.price, wp.bhk, wp.area_value, wp.area_unit, wp.approved_at,
            (SELECT pf.stored_name FROM property_files pf
             WHERE pf.property_kind = 'website' AND pf.property_id = wp.id AND pf.file_kind = 'image'
             ORDER BY pf.sort_order ASC, pf.id ASC LIMIT 1) AS cover_stored_name
     FROM website_properties wp
     WHERE ${PUBLIC_WHERE} AND wp.is_featured = 1
     ORDER BY wp.approved_at DESC, wp.id DESC
     LIMIT ?`,
    [limit],
  );
  await attachImageList(rows);
  return rows;
}

async function listLatest({ limit }) {
  const [rows] = await pool.query(
    `SELECT wp.id, wp.property_code, wp.title, wp.description, wp.property_type, wp.transaction_type,
            wp.location, wp.price, wp.bhk, wp.area_value, wp.area_unit, wp.approved_at,
            (SELECT pf.stored_name FROM property_files pf
             WHERE pf.property_kind = 'website' AND pf.property_id = wp.id AND pf.file_kind = 'image'
             ORDER BY pf.sort_order ASC, pf.id ASC LIMIT 1) AS cover_stored_name
     FROM website_properties wp
     WHERE ${PUBLIC_WHERE}
     ORDER BY wp.approved_at DESC, wp.id DESC
     LIMIT ?`,
    [limit],
  );
  await attachImageList(rows);
  return rows;
}

async function findActiveById(id) {
  // PUBLIC_WHERE uses the `wp` alias; this query doesn't alias the table, so
  // we inline the visibility conditions instead of using PUBLIC_WHERE.
  const [rows] = await pool.query(
    `SELECT id, property_code, title
     FROM website_properties
     WHERE id = ?
       AND approval_status = 'approved'
       AND is_active = 1
       AND deleted_at IS NULL
     LIMIT 1`,
    [id],
  );
  return rows[0] || null;
}

module.exports = { list, findByIdentifier, listFeatured, listLatest, findActiveById };
