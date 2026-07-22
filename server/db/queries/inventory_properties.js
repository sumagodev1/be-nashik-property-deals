const { pool } = require('../pool');

// Fix C: sortable columns qualified with `ip.` because the list SQL now
// LEFT JOINs the classification masters, and `created_at` / `id` exist
// on the master tables too. Other columns are inventory-only but the
// prefix is safe / clear.
const SORTABLE_COLUMNS = {
  created_at:    'ip.created_at',
  price:         'ip.price',
  location:      'ip.location',
  property_type: 'ip.property_type',
  title:         'ip.title',
};

function buildOrderBy(sort) {
  const [col, dir] = (sort || 'created_at:desc').split(':');
  const safeCol = SORTABLE_COLUMNS[col] || 'ip.created_at';
  const safeDir = dir && dir.toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  return `ORDER BY ${safeCol} ${safeDir}, ip.id DESC`;
}

async function list({
  page,
  pageSize,
  search,
  propertyType,
  transactionType,
  // Cascading filter additions (2026-07-14). All four are OPTIONAL and
  // compose with `search` and every other existing filter via AND.
  //
  //   district / taluka / shivar   Master CODES (VARCHAR columns store
  //                                master_lookups.code, NOT display labels).
  //                                Sent by the frontend cascade dropdowns
  //                                after the user picks District → Taluka →
  //                                Village. Exact-match with '='.
  //
  //   propertyTypeIn               Comma-separated list of STRIPPED form
  //                                labels (e.g. "Flat [Resale Rent Out],
  //                                Flat [New Rent Out]"). Computed on the
  //                                frontend by walking the chooser tree +
  //                                resolveMdFormConfig — see
  //                                InventoryListFilterBar.jsx. Backend
  //                                translates to WHERE property_type IN (?,
  //                                ?, …). Required because the chooser
  //                                tree's Property Type name ("Bungalow",
  //                                "Paying Guest") doesn't always match a
  //                                stored label prefix — e.g. Bungalow rows
  //                                are stored as "Bunglow [...]".
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
  // Owner Search filter - see WHERE branch below.
  ownerSearch,
}) {
  const offset = (page - 1) * pageSize;
  // Fix C: WHERE clauses need `ip.` prefixes on columns that also exist on
  // the joined master tables (deleted_at, description, created_at). Other
  // column names are unique to inventory_properties and stay unqualified.
  const where = ['ip.deleted_at IS NULL'];
  const params = [];

  if (search) {
    // Global PROPERTY search — every property-related field, but NEVER
    // owner/contact info (that's what `ownerSearch` below is for; keeping
    // the two disjoint avoids duplicate hits and makes "phone appears in
    // main search" a bug we can never regress into). Covers:
    //   - identity: property_code, title, description
    //   - classification: property_type, transaction_type, transaction_variant,
    //     status, status_note
    //   - location: free-text location + hierarchical district / taluka /
    //     shivar (village) master codes + pincode
    //   - specs (columns): bhk master code, area_unit code
    //   - numeric columns: price + area_value CAST to string so digits
    //     match (e.g. "5000" hits any row where 5000 appears in price/area)
    //   - dynamic-form fields: EVERY per-form field (facing, shape, layout,
    //     gut/survey/CTS number, wing, tower, flat number, budget, deposit,
    //     amenities, etc.) lives in the `details` JSON column — a text
    //     LIKE against the serialised JSON blob picks all of them up
    //     without a separate index-per-field.
    // Owner/contact exclusion:
    //   * The `owner_name / agent_name / owner_contact / agent_contact`
    //     columns are deliberately absent from the OR list.
    //   * `details` is searched via JSON_REMOVE that strips the three
    //     contact-bearing paths (contacts[], keyPersons[], and the
    //     referenceSourceOfLead free-text) BEFORE serialising to CHAR, so
    //     a phone/name/email typed into a contact card never leaks into a
    //     main-search hit. JSON_REMOVE tolerates missing paths, so rows
    //     whose details don't have contacts/keyPersons still work.
    // Trade-off: full-column scans (details LIKE + CAST(JSON_REMOVE(...))
    // LIKE) are fine at the property-record scale we're operating at
    // (thousands, not millions). If this becomes hot, promote
    // frequently-searched details keys to dedicated columns or add a
    // FULLTEXT / generated-column index.
    // Fix C: `description` is qualified because master tables also carry
    // a `description` column (migration 057). Every other column here is
    // unique to inventory_properties.
    where.push(`(
      property_code LIKE ? OR title LIKE ? OR ip.description LIKE ?
      OR location LIKE ?
      OR property_type LIKE ? OR transaction_type LIKE ? OR transaction_variant LIKE ?
      OR status LIKE ? OR status_note LIKE ?
      OR district LIKE ? OR taluka LIKE ? OR shivar LIKE ? OR pincode LIKE ?
      OR bhk LIKE ? OR area_unit LIKE ?
      OR CAST(price AS CHAR) LIKE ? OR CAST(area_value AS CHAR) LIKE ?
      OR CAST(JSON_REMOVE(details, '$.dynamicData.contacts', '$.dynamicData.keyPersons', '$.dynamicData.referenceSourceOfLead') AS CHAR) LIKE ?
    )`);
    const s = `%${search}%`;
    for (let i = 0; i < 18; i++) params.push(s);
  }
  if (propertyType) {
    where.push('property_type = ?');
    params.push(propertyType);
  }
  if (transactionType) {
    where.push('transaction_type = ?');
    params.push(transactionType);
  }
  // Owner Search (T-2026-032, additive). Owner-only LIKE - matches
  // owner_name (Owner Name) and owner_contact (Mobile/Phone). MySQL's
  // JSON_SEARCH walks the details blob restricted to contact/keyPerson
  // paths so a secondary contact card's name/phone/mobile/whatsapp/email
  // still matches WITHOUT letting a hit on amenities/remarks/description/
  // etc. leak through. Deliberately NOT touching property_type/title/
  // description/location/price/etc. Composes with the global `search`
  // param via AND when both are supplied.
  if (typeof ownerSearch === 'string' && ownerSearch.trim() !== '') {
    const like = `%${ownerSearch.trim()}%`;
    where.push(`(
      owner_name LIKE ? OR owner_contact LIKE ?
      OR JSON_SEARCH(details, 'one', ?, NULL, '$.dynamicData.contacts[*].name') IS NOT NULL
      OR JSON_SEARCH(details, 'one', ?, NULL, '$.dynamicData.contacts[*].phones[*]') IS NOT NULL
      OR JSON_SEARCH(details, 'one', ?, NULL, '$.dynamicData.contacts[*].mobiles[*]') IS NOT NULL
      OR JSON_SEARCH(details, 'one', ?, NULL, '$.dynamicData.contacts[*].emails[*]') IS NOT NULL
      OR JSON_SEARCH(details, 'one', ?, NULL, '$.dynamicData.keyPersons[*].name') IS NOT NULL
      OR JSON_SEARCH(details, 'one', ?, NULL, '$.dynamicData.keyPersons[*].phones[*]') IS NOT NULL
      OR JSON_SEARCH(details, 'one', ?, NULL, '$.dynamicData.keyPersons[*].mobiles[*]') IS NOT NULL
      OR JSON_SEARCH(details, 'one', ?, NULL, '$.dynamicData.keyPersons[*].emails[*]') IS NOT NULL
    )`);
    params.push(like, like, like, like, like, like, like, like, like, like);
  }
  // Cascading filter — see the signature comment above. `propertyTypeIn` is
  // pre-computed by the frontend to the exact set of stripped labels the
  // DB stores; we split, dedupe, cap, and pass through as an IN() list.
  if (typeof propertyTypeIn === 'string' && propertyTypeIn.trim() !== '') {
    const labels = Array.from(new Set(
      propertyTypeIn.split(',').map((s) => s.trim()).filter(Boolean),
    )).slice(0, 200); // hard cap — matches the largest realistic tree slice
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
    // Fix C: `created_at` qualified because every joined master table also has it.
    where.push('ip.created_at >= ?');
    params.push(dateFrom);
  }
  if (dateTo) {
    where.push('ip.created_at < DATE_ADD(?, INTERVAL 1 DAY)');
    params.push(dateTo);
  }
  if (typeof isDraft === 'boolean') {
    where.push('is_draft = ?');
    params.push(isDraft ? 1 : 0);
  }

  const whereSql = `WHERE ${where.join(' AND ')}`;
  const orderSql = buildOrderBy(sort);

  // Fix C: COUNT uses the same alias as the list SELECT so the shared
  // whereSql (with `ip.` prefixes) resolves correctly. No JOINs needed
  // here — the WHERE clauses only touch inventory_properties columns.
  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM inventory_properties ip ${whereSql}`,
    params,
  );

  // List rows now include the full `description` + `details` JSON blob so
  // the frontend receives every field the admin submitted. The `details`
  // column can be a few KB per row for MD-engine forms — at pageSize 100
  // that's still under a few hundred KB total, well within a reasonable
  // API response. If this ever grows painful, add an opt-in `?slim=1`
  // param that falls back to the compact projection.
  // Fix C (T-2026-057): LEFT JOIN the classification masters and COALESCE
  // the resolved name so pre-T-2026-055 rows (which have NULL snapshot
  // columns) always render a human label instead of a blank cell / raw
  // code. Legacy rows still store the code/label under `property_type`,
  // `transaction_type`, `transaction_variant`; the joins match by ID
  // (preferred) OR by code (fallback). If NEITHER matches (masters row
  // was hard-deleted), we fall through to the raw stored code.
  //
  // Aliases used downstream by toListItem:
  //   resolved_property_type_name   — persisted name if present, else master.label
  //   resolved_transaction_type_name — same shape
  //   resolved_property_variety_name — same shape
  const [rows] = await pool.query(
    `SELECT ip.id, ip.property_code, ip.registration_date, ip.title, ip.description,
            ip.property_type, ip.property_type_id, ip.property_type_name,
            ip.transaction_type, ip.transaction_type_id, ip.transaction_type_name,
            ip.transaction_variant, ip.property_variety_id, ip.property_variety_name,
            ip.location, ip.district, ip.taluka, ip.shivar, ip.latitude, ip.longitude, ip.formatted_address, ip.pincode,
            ip.area_value, ip.area_unit, ip.bhk, ip.price, ip.status, ip.status_note, ip.status_changed_at,
            ip.is_draft, ip.owner_name, ip.owner_contact,
            ip.agent_name, ip.agent_contact, ip.details, ip.created_at, ip.updated_at,
            COALESCE(ip.property_type_name, mpt_id.label, mpt_code.label) AS resolved_property_type_name,
            COALESCE(ip.transaction_type_name, mtt_id.label, mtt_code.label) AS resolved_transaction_type_name,
            COALESCE(ip.property_variety_name, mpv_id.label, mpv_code.label) AS resolved_property_variety_name
     FROM inventory_properties ip
     LEFT JOIN master_property_types mpt_id      ON mpt_id.id     = ip.property_type_id       AND mpt_id.deleted_at IS NULL
     LEFT JOIN master_property_types mpt_code    ON mpt_code.code = ip.property_type          AND mpt_code.deleted_at IS NULL
     LEFT JOIN master_transaction_types mtt_id   ON mtt_id.id     = ip.transaction_type_id    AND mtt_id.deleted_at IS NULL
     LEFT JOIN master_transaction_types mtt_code ON mtt_code.code = ip.transaction_type       AND mtt_code.deleted_at IS NULL
     LEFT JOIN master_lookups mpv_id             ON mpv_id.id     = ip.property_variety_id    AND mpv_id.deleted_at IS NULL AND mpv_id.master_key = 'property_variety'
     LEFT JOIN master_lookups mpv_code           ON mpv_code.code = ip.transaction_variant    AND mpv_code.deleted_at IS NULL AND mpv_code.master_key = 'property_variety'
     ${whereSql}
     ${orderSql}
     LIMIT ? OFFSET ?`,
    [...params, pageSize, offset],
  );

  return { rows, total };
}

// Fix C (T-2026-057): single-row view/edit reads must also benefit from
// the master COALESCE resolution — otherwise the View page renders a
// blank Property Type / Variety cell for pre-T-2026-055 rows even
// though the List page (which now uses the JOIN in `list()` above) shows
// the correct label. Keeps the historical `SELECT *` behaviour by
// appending the same three resolved_* aliases; downstream consumers
// (toListItem / toDetail) ignore anything they don't recognise.
const SELECT_WITH_RESOLVED_NAMES = `
  SELECT ip.*,
         COALESCE(ip.property_type_name, mpt_id.label, mpt_code.label) AS resolved_property_type_name,
         COALESCE(ip.transaction_type_name, mtt_id.label, mtt_code.label) AS resolved_transaction_type_name,
         COALESCE(ip.property_variety_name, mpv_id.label, mpv_code.label) AS resolved_property_variety_name
    FROM inventory_properties ip
    LEFT JOIN master_property_types mpt_id      ON mpt_id.id     = ip.property_type_id       AND mpt_id.deleted_at IS NULL
    LEFT JOIN master_property_types mpt_code    ON mpt_code.code = ip.property_type          AND mpt_code.deleted_at IS NULL
    LEFT JOIN master_transaction_types mtt_id   ON mtt_id.id     = ip.transaction_type_id    AND mtt_id.deleted_at IS NULL
    LEFT JOIN master_transaction_types mtt_code ON mtt_code.code = ip.transaction_type       AND mtt_code.deleted_at IS NULL
    LEFT JOIN master_lookups mpv_id             ON mpv_id.id     = ip.property_variety_id    AND mpv_id.deleted_at IS NULL AND mpv_id.master_key = 'property_variety'
    LEFT JOIN master_lookups mpv_code           ON mpv_code.code = ip.transaction_variant    AND mpv_code.deleted_at IS NULL AND mpv_code.master_key = 'property_variety'
`;

async function findById(id) {
  const [rows] = await pool.query(
    `${SELECT_WITH_RESOLVED_NAMES}
     WHERE ip.id = ? AND ip.deleted_at IS NULL LIMIT 1`,
    [id],
  );
  return rows[0] || null;
}

async function findByIdForConn(conn, id) {
  const [rows] = await conn.query(
    `${SELECT_WITH_RESOLVED_NAMES}
     WHERE ip.id = ? AND ip.deleted_at IS NULL LIMIT 1`,
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
     (property_code, registration_date, title, description, property_type, property_type_id, property_type_name,
      transaction_type, transaction_type_id, transaction_type_name, transaction_variant, property_variety_id, property_variety_name,
      location, district, taluka, shivar,
      latitude, longitude, formatted_address, pincode,
      area_value, area_unit, bhk, price, status, is_draft,
      owner_name, owner_contact, agent_name, agent_contact, details, created_by_admin_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      payload.propertyCode,
      payload.registrationDate || null,
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
       property_type = ?, property_type_id = ?, property_type_name = ?,
       transaction_type = ?, transaction_type_id = ?, transaction_type_name = ?,
       transaction_variant = ?, property_variety_id = ?, property_variety_name = ?,
       location = ?, district = ?, taluka = ?, shivar = ?,
       latitude = ?, longitude = ?, formatted_address = ?, pincode = ?,
       area_value = ?, area_unit = ?, bhk = ?, price = ?, status = ?, is_draft = ?,
       owner_name = ?, owner_contact = ?, agent_name = ?, agent_contact = ?, details = ?
     WHERE id = ? AND deleted_at IS NULL`,
    [
      payload.registrationDate || null,
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

async function softDeleteForConn(conn, id) {
  await conn.query(
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
  softDeleteForConn,
};
