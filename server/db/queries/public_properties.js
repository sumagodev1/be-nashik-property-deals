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
  // Multi-select aware. The route layer passes either a single code
  // ("flat") or a comma-separated list ("flat,villa,land") — collapse into
  // an IN clause so a buyer can shortlist several property types at once.
  if (propertyType) {
    const types = String(propertyType)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (types.length === 1) {
      where.push('wp.property_type = ?');
      params.push(types[0]);
    } else if (types.length > 1) {
      where.push(`wp.property_type IN (${types.map(() => '?').join(',')})`);
      params.push(...types);
    }
  }
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

/**
 * Atomically bump the view counter on a public property. Used by the public
 * detail endpoint for seller analytics. Failures are non-fatal — the detail
 * response should still serve even if the counter update hiccups.
 */
async function incrementViewCount(id) {
  await pool.query(
    `UPDATE website_properties SET view_count = view_count + 1
     WHERE id = ? AND approval_status = 'approved' AND is_active = 1 AND deleted_at IS NULL`,
    [id],
  );
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

/**
 * Pick `limit` other approved listings similar to the given property. Match
 * rules in priority order:
 *   1. same propertyType + transactionType + price within ±30%
 *   2. fallback: same propertyType only
 *   3. fallback: same transactionType only
 * Excludes the source property itself. Newest first within each tier.
 */
async function listSimilar({ excludeId, propertyType, transactionType, price, limit = 4 }) {
  const cappedLimit = Math.min(20, Math.max(1, limit));
  const priceMin = price ? Number(price) * 0.7 : null;
  const priceMax = price ? Number(price) * 1.3 : null;

  const baseSelect = `
    SELECT wp.id, wp.property_code, wp.title, wp.description, wp.property_type, wp.transaction_type,
           wp.location, wp.latitude, wp.longitude, wp.price, wp.bhk, wp.area_value, wp.area_unit,
           wp.is_featured, wp.approved_at,
           (SELECT pf.stored_name FROM property_files pf
            WHERE pf.property_kind = 'website' AND pf.property_id = wp.id AND pf.file_kind = 'image'
            ORDER BY pf.sort_order ASC, pf.id ASC LIMIT 1) AS cover_stored_name
    FROM website_properties wp
    WHERE ${PUBLIC_WHERE} AND wp.id <> ?
  `;

  // Tier 1: same type + transaction + price window
  let rows = [];
  if (price && propertyType && transactionType) {
    const [t1] = await pool.query(
      `${baseSelect}
         AND wp.property_type = ?
         AND wp.transaction_type = ?
         AND wp.price BETWEEN ? AND ?
       ORDER BY wp.approved_at DESC, wp.id DESC
       LIMIT ?`,
      [excludeId, propertyType, transactionType, priceMin, priceMax, cappedLimit],
    );
    rows = t1;
  }

  // Tier 2: same propertyType only — top up if tier 1 was thin
  if (rows.length < cappedLimit && propertyType) {
    const need = cappedLimit - rows.length;
    const seenIds = rows.map((r) => r.id);
    const [t2] = await pool.query(
      `${baseSelect}
         AND wp.property_type = ?
         ${seenIds.length ? 'AND wp.id NOT IN (?)' : ''}
       ORDER BY wp.approved_at DESC, wp.id DESC
       LIMIT ?`,
      seenIds.length ? [excludeId, propertyType, seenIds, need] : [excludeId, propertyType, need],
    );
    rows = rows.concat(t2);
  }

  // Tier 3: same transactionType — final top-up
  if (rows.length < cappedLimit && transactionType) {
    const need = cappedLimit - rows.length;
    const seenIds = rows.map((r) => r.id);
    const [t3] = await pool.query(
      `${baseSelect}
         AND wp.transaction_type = ?
         ${seenIds.length ? 'AND wp.id NOT IN (?)' : ''}
       ORDER BY wp.approved_at DESC, wp.id DESC
       LIMIT ?`,
      seenIds.length ? [excludeId, transactionType, seenIds, need] : [excludeId, transactionType, need],
    );
    rows = rows.concat(t3);
  }

  await attachImageList(rows);
  return rows;
}

module.exports = { list, findByIdentifier, listFeatured, listLatest, findActiveById, listSimilar, incrementViewCount };
