const { pool } = require('../pool');

// Structural mirror of db/queries/inventory_properties.js — same shape,
// same sortable columns, same list filters, same soft-delete convention.
// The only difference is the target table: enquiry_properties (see
// migrations/048_enquiry_properties.sql). Kept as a sibling module rather
// than a factory so a search for "SELECT ... FROM enquiry_properties" lands
// directly on the code path that runs it.

// Fix C (T-2026-057): same JOIN-and-coalesce pattern as
// inventory_properties.js — see comments there for the full rationale.
// Sortable columns and where-clause references qualified with `ep.`
// because the LIST SQL below LEFT JOINs the classification masters.
const SORTABLE_COLUMNS = {
  created_at:    'ep.created_at',
  // Property ID column. The list toolbar offers "Property ID (A-Z / Z-A)" and
  // sends sort=property_code:asc|desc; without this entry buildOrderBy fell
  // through to the title default and the route's Joi rejected the value
  // outright with a 400 before it even got here.
  property_code: 'ep.property_code',
  price:         'ep.price',
  location:      'ep.location',
  property_type: 'ep.property_type',
  title:         'ep.title',
};

function buildOrderBy(sort) {
  const [col, dir] = (sort || 'title:asc').split(':');
  const safeCol = SORTABLE_COLUMNS[col] || 'ep.title';
  const safeDir = dir && dir.toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  return `ORDER BY ${safeCol} ${safeDir}, ep.id ASC`;
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
  // Cascading Transaction Type + Property Variety filters (2026-08-03).
  // Mirror of the sibling block in db/queries/inventory_properties.js —
  // see that file for the full contract.
  transactionTypeCode,
  transactionTypeLabel,
  propertyVarietyCode,
  propertyVarietyLabel,
  status,
  area,
  location,
  priceMin,
  priceMax,
  // T-2026-109: Budget Range filter (Min / Max, Rs.). Mirror of the
  // sibling block in db/queries/inventory_properties.js — see the full
  // contract there. Uses the SAME COALESCE priority across
  // dynamicData.actualCalculatedPropertyPrice / totalAmount / totalCost /
  // top-level `ep.price` so Inventory and Enquiry filter behaviour stays
  // byte-identical. NOT compared against govValuation / lumpsum /
  // rate / budgetAmount / considerationValue by design.
  minBudget,
  maxBudget,
  dateFrom,
  dateTo,
  sort,
  isDraft,
  // Owner Search filter - see WHERE branch below.
  ownerSearch,
}) {
  const offset = (page - 1) * pageSize;
  // Fix C: WHERE prefixes match inventory_properties.js — `ep.` qualifies
  // columns that also live on the joined master tables (deleted_at,
  // description, created_at). Other names are unique to enquiry_properties.
  const where = ['ep.deleted_at IS NULL'];
  const params = [];

  // Trim so leading / trailing whitespace on the incoming token doesn't
  // silently kill matches. Frontend also trims — kept here defensively.
  const trimmedSearch = typeof search === 'string' ? search.trim() : search;
  if (trimmedSearch) {
    // Mirrors the Global PROPERTY Search rules on inventory_properties —
    // see the parallel comment block there for the full field list and
    // rationale. Owner / key-person / contact JSON is now in-scope for
    // main search (previously only reachable via the narrower `ownerSearch`
    // input); admins expect a single search box to find records by any
    // property or owner-side field.
    where.push(`(
      ep.property_code LIKE ? OR ep.title LIKE ? OR ep.description LIKE ?
      OR ep.location LIKE ? OR ep.formatted_address LIKE ?
      OR ep.property_type LIKE ? OR ep.property_type_name LIKE ?
      OR ep.transaction_type LIKE ? OR ep.transaction_type_name LIKE ?
      OR ep.transaction_variant LIKE ? OR ep.property_variety_name LIKE ?
      OR ep.status LIKE ? OR ep.status_note LIKE ?
      OR ep.district LIKE ? OR ep.taluka LIKE ? OR ep.shivar LIKE ? OR ep.pincode LIKE ?
      OR ep.bhk LIKE ? OR ep.area_unit LIKE ?
      OR CAST(ep.price AS CHAR) LIKE ? OR CAST(ep.area_value AS CHAR) LIKE ?
      OR ep.owner_name LIKE ? OR ep.owner_contact LIKE ?
      OR ep.agent_name LIKE ? OR ep.agent_contact LIKE ?
      OR CAST(ep.details AS CHAR) LIKE ?
    )`);
    const s = `%${trimmedSearch}%`;
    for (let i = 0; i < 26; i++) params.push(s);
  }
  if (propertyType) {
    where.push('ep.property_type = ?');
    params.push(propertyType);
  }
  if (transactionType) {
    where.push('ep.transaction_type = ?');
    params.push(transactionType);
  }
  // Owner Search (T-2026-032, additive). Owner-only LIKE - mirror of
  // db/queries/inventory_properties.js. See there for the full contract
  // and the JSON_SEARCH path restriction. Composes with `search` via AND.
  // T-2026-081: qualified with `ep.` alongside the global-search fix
  // above so master_lookups joins never make owner_name / owner_contact /
  // details ambiguous.
  if (typeof ownerSearch === 'string' && ownerSearch.trim() !== '') {
    const like = `%${ownerSearch.trim()}%`;
    where.push(`(
      ep.owner_name LIKE ? OR ep.owner_contact LIKE ?
      OR JSON_SEARCH(ep.details, 'one', ?, NULL, '$.dynamicData.contacts[*].name') IS NOT NULL
      OR JSON_SEARCH(ep.details, 'one', ?, NULL, '$.dynamicData.contacts[*].phones[*]') IS NOT NULL
      OR JSON_SEARCH(ep.details, 'one', ?, NULL, '$.dynamicData.contacts[*].mobiles[*]') IS NOT NULL
      OR JSON_SEARCH(ep.details, 'one', ?, NULL, '$.dynamicData.contacts[*].emails[*]') IS NOT NULL
      OR JSON_SEARCH(ep.details, 'one', ?, NULL, '$.dynamicData.keyPersons[*].name') IS NOT NULL
      OR JSON_SEARCH(ep.details, 'one', ?, NULL, '$.dynamicData.keyPersons[*].phones[*]') IS NOT NULL
      OR JSON_SEARCH(ep.details, 'one', ?, NULL, '$.dynamicData.keyPersons[*].mobiles[*]') IS NOT NULL
      OR JSON_SEARCH(ep.details, 'one', ?, NULL, '$.dynamicData.keyPersons[*].emails[*]') IS NOT NULL
    )`);
    params.push(like, like, like, like, like, like, like, like, like, like);
  }
  // Cascading filter — mirror of db/queries/inventory_properties.js.
  if (typeof propertyTypeIn === 'string' && propertyTypeIn.trim() !== '') {
    const labels = Array.from(new Set(
      propertyTypeIn.split(',').map((s) => s.trim()).filter(Boolean),
    )).slice(0, 200);
    if (labels.length > 0) {
      where.push(`ep.property_type IN (${labels.map(() => '?').join(', ')})`);
      params.push(...labels);
    }
  }
  // Transaction Type — mirror of the sibling branch in
  // db/queries/inventory_properties.js. See there for the full rationale.
  if (
    (typeof transactionTypeCode === 'string' && transactionTypeCode.trim() !== '')
    || (typeof transactionTypeLabel === 'string' && transactionTypeLabel.trim() !== '')
  ) {
    const code  = typeof transactionTypeCode  === 'string' ? transactionTypeCode.trim()  : '';
    const label = typeof transactionTypeLabel === 'string' ? transactionTypeLabel.trim() : '';
    const branches = [];
    if (code)  { branches.push('LOWER(ep.transaction_type) = LOWER(?)');      params.push(code); }
    if (label) { branches.push('LOWER(ep.transaction_type_name) = LOWER(?)'); params.push(label); }
    if (branches.length) where.push(`(${branches.join(' OR ')})`);
  }
  // Property Variety — mirror of the sibling branch.
  if (
    (typeof propertyVarietyCode === 'string' && propertyVarietyCode.trim() !== '')
    || (typeof propertyVarietyLabel === 'string' && propertyVarietyLabel.trim() !== '')
  ) {
    const code  = typeof propertyVarietyCode  === 'string' ? propertyVarietyCode.trim()  : '';
    const label = typeof propertyVarietyLabel === 'string' ? propertyVarietyLabel.trim() : '';
    const branches = [];
    if (code)  { branches.push('LOWER(ep.transaction_variant) = LOWER(?)');    params.push(code); }
    if (label) { branches.push('LOWER(ep.property_variety_name) = LOWER(?)'); params.push(label); }
    if (branches.length) where.push(`(${branches.join(' OR ')})`);
  }
  if (district) {
    where.push('ep.district = ?');
    params.push(district);
  }
  if (taluka) {
    where.push('ep.taluka = ?');
    params.push(taluka);
  }
  if (shivar) {
    where.push('ep.shivar = ?');
    params.push(shivar);
  }
  if (status) {
    where.push('ep.status = ?');
    params.push(status);
  }
  // Curated Area filter. On THIS surface the Area dropdown persists into
  // the EXISTING location column (its dualMode value is scalarized into it
  // on submit), so the shared `area` param maps here rather than to a
  // separate column - Enquiry needs no new column at all.
  //
  // EXACT match: the control is a dropdown of master labels, so there is no
  // partial input to be forgiving about. The free-text `location` filter
  // below keeps its LIKE, which is a different job.
  if (area) {
    // The Area dropdown is a checkbox MULTI-select on the Enquiry form, so a
    // requirement covering several areas stores them comma-joined in this one
    // column ("nashik,pune"). FIND_IN_SET keeps the filter exact — it matches
    // whole list members only, so filtering by "pune" finds that row without
    // a LIKE's false positives (e.g. "punawale").
    //
    // Single-area rows are unaffected: FIND_IN_SET('nashik', 'nashik') is a
    // hit, exactly like the previous `=` comparison. Every pre-existing
    // enquiry keeps matching the same filter values it always did.
    where.push('FIND_IN_SET(?, ep.location)');
    params.push(area);
  }
  if (location) {
    where.push('ep.location LIKE ?');
    params.push(`%${location}%`);
  }
  if (priceMin !== undefined) {
    where.push('ep.price >= ?');
    params.push(priceMin);
  }
  if (priceMax !== undefined) {
    where.push('ep.price <= ?');
    params.push(priceMax);
  }
  // T-2026-109: Budget Range filter — mirror of the sibling block in
  // db/queries/inventory_properties.js. See there for the full contract
  // (COALESCE priority, NULLIF-on-empty/'null'/zero to skip unset
  // candidates, NULL-safe fallthrough when no candidate has real pricing).
  // Priority order preserved: actualCalculatedPropertyPrice (Land / SEZ) →
  // totalAmount (most md-engine forms) → totalCost (some flat variants) →
  // ep.price (legacy Headline Price fallback).
  const BUDGET_EXPR = `COALESCE(
    NULLIF(CAST(NULLIF(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(ep.details, '$.dynamicData.actualCalculatedPropertyPrice')), ''), 'null') AS DECIMAL(20,2)), 0),
    NULLIF(CAST(NULLIF(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(ep.details, '$.dynamicData.totalAmount')), ''), 'null') AS DECIMAL(20,2)), 0),
    NULLIF(CAST(NULLIF(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(ep.details, '$.dynamicData.totalCost')), ''), 'null') AS DECIMAL(20,2)), 0),
    NULLIF(ep.price, 0)
  )`;
  if (minBudget !== undefined && minBudget !== null && minBudget !== '') {
    where.push(`${BUDGET_EXPR} >= ?`);
    params.push(minBudget);
  }
  if (maxBudget !== undefined && maxBudget !== null && maxBudget !== '') {
    where.push(`${BUDGET_EXPR} <= ?`);
    params.push(maxBudget);
  }
  if (dateFrom) {
    where.push('ep.created_at >= ?');
    params.push(dateFrom);
  }
  if (dateTo) {
    where.push('ep.created_at < DATE_ADD(?, INTERVAL 1 DAY)');
    params.push(dateTo);
  }
  if (typeof isDraft === 'boolean') {
    where.push('ep.is_draft = ?');
    params.push(isDraft ? 1 : 0);
  }

  const whereSql = `WHERE ${where.join(' AND ')}`;
  const orderSql = buildOrderBy(sort);

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM enquiry_properties ep ${whereSql}`,
    params,
  );

  // Fix C: LEFT JOIN + COALESCE mirrors inventory_properties.js. See
  // that file for the full explanation.
  const [rows] = await pool.query(
    `SELECT ep.id, ep.property_code, ep.posting_date, ep.available_from_date, ep.title, ep.description,
            ep.property_type, ep.property_type_id, ep.property_type_name,
            ep.transaction_type, ep.transaction_type_id, ep.transaction_type_name,
            ep.transaction_variant, ep.property_variety_id, ep.property_variety_name,
            ep.location, ep.district, ep.taluka, ep.shivar, ep.latitude, ep.longitude, ep.formatted_address, ep.pincode,
            ep.area_value, ep.area_unit, ep.bhk, ep.price, ep.status, ep.status_note, ep.status_changed_at,
            ep.is_draft, ep.owner_name, ep.owner_contact,
            ep.agent_name, ep.agent_contact, ep.details, ep.created_at, ep.updated_at,
            ep.agreement_start_date, ep.agreement_end_date,
            COALESCE(ep.property_type_name, mpt_id.label, mpt_code.label) AS resolved_property_type_name,
            COALESCE(ep.transaction_type_name, mtt_id.label, mtt_code.label) AS resolved_transaction_type_name,
            COALESCE(ep.property_variety_name, mpv_id.label, mpv_code.label) AS resolved_property_variety_name
     FROM enquiry_properties ep
     LEFT JOIN master_property_types mpt_id      ON mpt_id.id     = ep.property_type_id       AND mpt_id.deleted_at IS NULL
     LEFT JOIN master_property_types mpt_code    ON mpt_code.code = ep.property_type          AND mpt_code.deleted_at IS NULL
     LEFT JOIN master_transaction_types mtt_id   ON mtt_id.id     = ep.transaction_type_id    AND mtt_id.deleted_at IS NULL
     LEFT JOIN master_transaction_types mtt_code ON mtt_code.code = ep.transaction_type       AND mtt_code.deleted_at IS NULL
     LEFT JOIN master_lookups mpv_id             ON mpv_id.id     = ep.property_variety_id    AND mpv_id.deleted_at IS NULL AND mpv_id.master_key = 'property_variety'
     LEFT JOIN master_lookups mpv_code           ON mpv_code.code = ep.transaction_variant    AND mpv_code.deleted_at IS NULL AND mpv_code.master_key = 'property_variety'
     ${whereSql}
     ${orderSql}
     LIMIT ? OFFSET ?`,
    [...params, pageSize, offset],
  );

  return { rows, total };
}

// Fix C: findById also joins the masters so View/Edit render the same
// resolved names as the List.
const SELECT_WITH_RESOLVED_NAMES = `
  SELECT ep.*,
         COALESCE(ep.property_type_name, mpt_id.label, mpt_code.label) AS resolved_property_type_name,
         COALESCE(ep.transaction_type_name, mtt_id.label, mtt_code.label) AS resolved_transaction_type_name,
         COALESCE(ep.property_variety_name, mpv_id.label, mpv_code.label) AS resolved_property_variety_name
    FROM enquiry_properties ep
    LEFT JOIN master_property_types mpt_id      ON mpt_id.id     = ep.property_type_id       AND mpt_id.deleted_at IS NULL
    LEFT JOIN master_property_types mpt_code    ON mpt_code.code = ep.property_type          AND mpt_code.deleted_at IS NULL
    LEFT JOIN master_transaction_types mtt_id   ON mtt_id.id     = ep.transaction_type_id    AND mtt_id.deleted_at IS NULL
    LEFT JOIN master_transaction_types mtt_code ON mtt_code.code = ep.transaction_type       AND mtt_code.deleted_at IS NULL
    LEFT JOIN master_lookups mpv_id             ON mpv_id.id     = ep.property_variety_id    AND mpv_id.deleted_at IS NULL AND mpv_id.master_key = 'property_variety'
    LEFT JOIN master_lookups mpv_code           ON mpv_code.code = ep.transaction_variant    AND mpv_code.deleted_at IS NULL AND mpv_code.master_key = 'property_variety'
`;

async function findById(id) {
  const [rows] = await pool.query(
    `${SELECT_WITH_RESOLVED_NAMES}
     WHERE ep.id = ? AND ep.deleted_at IS NULL LIMIT 1`,
    [id],
  );
  return rows[0] || null;
}

async function findByIdForConn(conn, id) {
  const [rows] = await conn.query(
    `${SELECT_WITH_RESOLVED_NAMES}
     WHERE ep.id = ? AND ep.deleted_at IS NULL LIMIT 1`,
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
     (property_code, posting_date, available_from_date, title, description, property_type, property_type_id, property_type_name,
      transaction_type, transaction_type_id, transaction_type_name, transaction_variant, property_variety_id, property_variety_name,
      location, district, taluka, shivar,
      latitude, longitude, formatted_address, pincode,
      area_value, area_unit, bhk, price, status, is_draft,
      owner_name, owner_contact, agent_name, agent_contact, details, created_by_admin_id,
      agreement_start_date, agreement_end_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      payload.propertyCode,
      payload.postingDate || null,
      payload.availableFromDate || null,
      payload.title,
      payload.description || null,
      payload.propertyType,
      // T-2026-055: {id, name} pair columns
      payload.propertyTypeId || null,
      payload.propertyTypeName || null,
      payload.transactionType,
      payload.transactionTypeId || null,
      payload.transactionTypeName || null,
      payload.transactionVariant || null,
      payload.propertyVarietyId || null,
      payload.propertyVarietyName || null,
      payload.location,
      payload.district || null,
      payload.taluka || null,
      payload.shivar || null,
      payload.latitude ?? null,
      payload.longitude ?? null,
      payload.formattedAddress || null,
      payload.pincode || null,
      payload.areaValue ?? null,
      payload.areaUnit || null,
      payload.bhk || null,
      payload.price,
      // T-2026-086: fallback aligned with the enquiry_status master
      // (T-2026-080 split). The Joi schema in routes/admin/enquiry-
      // properties.js already defaults to 'new_enquiry' when the FE omits
      // status; this fallback covers the edge case where the payload
      // reaches this query with status=='' (Joi's default only fires on
      // undefined). 'available' would fail assertActiveCode on the
      // enquiry side and is preserved only as an INACTIVE label-resolver
      // row for legacy records.
      payload.status || 'new_enquiry',
      payload.isDraft ? 1 : 0,
      payload.ownerName || null,
      payload.ownerContact || null,
      payload.agentName || null,
      payload.agentContact || null,
      detailsJson,
      payload.createdByAdminId || null,
      // T-2026-112: Agreement Tracking & Reminder System — top-level dates
      // for fast reminder-list scans. Rent Out / Lease Out only; every other
      // form leaves these NULL.
      payload.agreementStartDate || null,
      payload.agreementEndDate || null,
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
       posting_date = ?, available_from_date = ?, title = ?, description = ?,
       property_type = ?, property_type_id = ?, property_type_name = ?,
       transaction_type = ?, transaction_type_id = ?, transaction_type_name = ?,
       transaction_variant = ?, property_variety_id = ?, property_variety_name = ?,
       location = ?, district = ?, taluka = ?, shivar = ?,
       latitude = ?, longitude = ?, formatted_address = ?, pincode = ?,
       area_value = ?, area_unit = ?, bhk = ?, price = ?, status = ?, is_draft = ?,
       owner_name = ?, owner_contact = ?, agent_name = ?, agent_contact = ?, details = ?,
       agreement_start_date = ?, agreement_end_date = ?
     WHERE id = ? AND deleted_at IS NULL`,
    [
      payload.postingDate || null,
      payload.availableFromDate || null,
      payload.title,
      payload.description || null,
      payload.propertyType,
      // T-2026-055: {id, name} pair columns
      payload.propertyTypeId || null,
      payload.propertyTypeName || null,
      payload.transactionType,
      payload.transactionTypeId || null,
      payload.transactionTypeName || null,
      payload.transactionVariant || null,
      payload.propertyVarietyId || null,
      payload.propertyVarietyName || null,
      payload.location,
      payload.district || null,
      payload.taluka || null,
      payload.shivar || null,
      payload.latitude ?? null,
      payload.longitude ?? null,
      payload.formattedAddress || null,
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
      // T-2026-112: Agreement dates. Empty string coerces to NULL so the
      // FE can clear the field simply by not setting it.
      payload.agreementStartDate || null,
      payload.agreementEndDate || null,
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

async function softDeleteForConn(conn, id) {
  await conn.query(
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
  softDeleteForConn,
};
