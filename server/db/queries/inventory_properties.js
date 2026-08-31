const { pool } = require('../pool');

// Fix C: sortable columns qualified with `ip.` because the list SQL now
// LEFT JOINs the classification masters, and `created_at` / `id` exist
// on the master tables too. Other columns are inventory-only but the
// prefix is safe / clear.
const SORTABLE_COLUMNS = {
  created_at:    'ip.created_at',
  // Property ID column. The list toolbar offers "Property ID (A-Z / Z-A)" and
  // sends sort=property_code:asc|desc; without this entry buildOrderBy fell
  // through to the title default and the route's Joi rejected the value
  // outright with a 400 before it even got here.
  property_code: 'ip.property_code',
  price:         'ip.price',
  location:      'ip.location',
  // Curated Area (locality). A real column purely so it can be sorted and
  // grouped - the same reason `location` is here. NOT area_value/area_unit,
  // which are the property SIZE.
  area_name:     'ip.area_name',
  property_type: 'ip.property_type',
  title:         'ip.title',
};

function buildOrderBy(sort) {
  const [col, dir] = (sort || 'title:asc').split(':');
  const safeCol = SORTABLE_COLUMNS[col] || 'ip.title';
  const safeDir = dir && dir.toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  return `ORDER BY ${safeCol} ${safeDir}, ip.id ASC`;
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
  // Cascading Transaction Type + Property Variety filters (2026-08-03).
  //
  //   transactionTypeCode  — master `code` for the selected TT (e.g.
  //                          'sale', 'rent_out', 'out').
  //   transactionTypeLabel — canonical label ('Sale', 'Rent Out', 'Out').
  //   propertyVarietyCode  — variety code ('flat', 'bungalow', 'new').
  //   propertyVarietyLabel — canonical label ('Flat', 'Bungalow', 'New').
  //
  // Both CODE and LABEL are sent so the WHERE can OR-match against the
  // multiple columns a record may have stored (`transaction_type` enum,
  // `transaction_type_name` label, `transaction_variant` code,
  // `property_variety_name` label). See the WHERE branches below.
  transactionTypeCode,
  transactionTypeLabel,
  propertyVarietyCode,
  propertyVarietyLabel,
  status,
  area,
  location,
  priceMin,
  priceMax,
  // T-2026-109: Budget Range filter (Min / Max, Rs.). Compares against the
  // "Actual Property Cost" concept entered in the Pricing & Commercial
  // section of the dynamic form. Unlike `priceMin`/`priceMax` which target
  // the top-level `ip.price` column (populated only via the legacy Headline
  // Price input rendered when !useMdEngine), the Budget Range walks the
  // polymorphic dynamicData JSON so it also matches records saved via the
  // md-engine forms (flat / bungalow / rowhouse / commercial / shop / land /
  // sez / plot / project / rate-finder). The DB has NO single unified column
  // for "Actual Property Cost" because different property types name the
  // pricing field differently:
  //   * Land + SEZ Land            → dynamicData.actualCalculatedPropertyPrice
  //     (auto-computed area × selected rate)
  //   * Flat + Bungalow + Row House + Commercial + Shop + Project + Plot +
  //     Rate Finder               → dynamicData.totalAmount (Sq.Ft. × Rate)
  //   * Flat purchase-side variants → dynamicData.totalCost (Basic Cost /
  //     Total Cost hinted in the form)
  //   * Legacy (pre-md-engine) rows → top-level `ip.price` (Headline Price)
  // The WHERE clause COALESCEs across these candidates in priority order so
  // whichever value the property actually captured for "Actual Property Cost"
  // is what the filter compares. NOT included in the COALESCE by design:
  //   * govValuationTotal / govValuationRate (Government Valuation)
  //   * lumpsum (Lumpsum override)
  //   * rate (Rate / Sq.Ft.)
  //   * budgetAmount (buyer-side budget, not cost)
  //   * considerationValue
  // See the spec header at InventoryListFilterBar.jsx for the client rule.
  minBudget,
  maxBudget,
  dateFrom,
  dateTo,
  postingDateFrom,
  postingDateTo,
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

  // Trim the raw search token so a user who types "  land  " still matches
  // "%land%" rather than "%  land  %" (which is never found in the DB).
  // Applied here so every downstream branch (WHERE + COUNT) uses the same
  // normalised token; the frontend also trims defensively.
  const trimmedSearch = typeof search === 'string' ? search.trim() : search;
  if (trimmedSearch) {
    // Global PROPERTY search — every property-related field, and (as of
    // this change) the owner / key-person / contact info that admins
    // routinely look up by name / mobile / phone / email / address /
    // pincode. Previously main search intentionally excluded owner-owned
    // fields to keep them disjoint from the separate `ownerSearch` input.
    // Product feedback: admins need one search box that finds a property
    // by ANY property or owner-side field. `ownerSearch` still exists as a
    // narrower owner-only input on the Inventory / Enquiry pages, so this
    // change is additive — main `search` now composes with owner data too.
    //
    // Covers:
    //   - identity: property_code, title, description
    //   - classification: property_type / property_type_name /
    //     transaction_type / transaction_type_name / transaction_variant /
    //     property_variety_name / status / status_note
    //   - location: free-text location, formatted_address, hierarchical
    //     district / taluka / shivar (village) master codes + pincode
    //   - specs: bhk master code, area_unit
    //   - numeric: price + area_value CAST to string so digit substrings
    //     match (e.g. "5000" hits any row where 5000 appears)
    //   - owner columns: owner_name / owner_contact / agent_name /
    //     agent_contact
    //   - dynamic-form + contact JSON: full CAST(details AS CHAR) LIKE so
    //     contacts / keyPersons (name, phones, mobiles, emails, whatsapps,
    //     address lines) are all in scope in addition to every other
    //     dynamic-form field (facing, shape, layout, gut/survey/CTS number,
    //     wing, tower, flat number, budget, deposit, amenities, etc.).
    //     The JSON_REMOVE guard is intentionally gone: main search now
    //     covers contacts by design.
    //
    // Trade-off: full-column scans (details CAST LIKE) are fine at the
    // property-record scale we're operating at (thousands, not millions).
    // If this becomes hot, promote frequently-searched details keys to
    // dedicated columns or add a FULLTEXT / generated-column index.
    where.push(`(
      ip.property_code LIKE ? OR ip.title LIKE ? OR ip.description LIKE ?
      OR ip.location LIKE ? OR ip.formatted_address LIKE ?
      OR ip.property_type LIKE ? OR ip.property_type_name LIKE ?
      OR ip.transaction_type LIKE ? OR ip.transaction_type_name LIKE ?
      OR ip.transaction_variant LIKE ? OR ip.property_variety_name LIKE ?
      OR ip.status LIKE ? OR ip.status_note LIKE ?
      OR ip.district LIKE ? OR ip.taluka LIKE ? OR ip.shivar LIKE ? OR ip.pincode LIKE ?
      OR ip.bhk LIKE ? OR ip.area_unit LIKE ?
      OR CAST(ip.price AS CHAR) LIKE ? OR CAST(ip.area_value AS CHAR) LIKE ?
      OR ip.owner_name LIKE ? OR ip.owner_contact LIKE ?
      OR ip.agent_name LIKE ? OR ip.agent_contact LIKE ?
      OR CAST(ip.details AS CHAR) LIKE ?
    )`);
    const s = `%${trimmedSearch}%`;
    for (let i = 0; i < 26; i++) params.push(s);
  }
  if (propertyType) {
    where.push('ip.property_type = ?');
    params.push(propertyType);
  }
  if (transactionType) {
    where.push('ip.transaction_type = ?');
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
      ip.owner_name LIKE ? OR ip.owner_contact LIKE ?
      OR JSON_SEARCH(ip.details, 'one', ?, NULL, '$.dynamicData.contacts[*].name') IS NOT NULL
      OR JSON_SEARCH(ip.details, 'one', ?, NULL, '$.dynamicData.contacts[*].phones[*]') IS NOT NULL
      OR JSON_SEARCH(ip.details, 'one', ?, NULL, '$.dynamicData.contacts[*].mobiles[*]') IS NOT NULL
      OR JSON_SEARCH(ip.details, 'one', ?, NULL, '$.dynamicData.contacts[*].emails[*]') IS NOT NULL
      OR JSON_SEARCH(ip.details, 'one', ?, NULL, '$.dynamicData.keyPersons[*].name') IS NOT NULL
      OR JSON_SEARCH(ip.details, 'one', ?, NULL, '$.dynamicData.keyPersons[*].phones[*]') IS NOT NULL
      OR JSON_SEARCH(ip.details, 'one', ?, NULL, '$.dynamicData.keyPersons[*].mobiles[*]') IS NOT NULL
      OR JSON_SEARCH(ip.details, 'one', ?, NULL, '$.dynamicData.keyPersons[*].emails[*]') IS NOT NULL
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
      where.push(`ip.property_type IN (${labels.map(() => '?').join(', ')})`);
      params.push(...labels);
    }
  }
  // Transaction Type — AND-match records whose stored TT matches EITHER
  // the master code (against the coarse `transaction_type` enum) OR the
  // canonical label (against `transaction_type_name`). Records saved via
  // the fine-grained pre-form chooser have both columns populated;
  // legacy rows may have only one. Empty inputs skip the filter entirely.
  if (
    (typeof transactionTypeCode === 'string' && transactionTypeCode.trim() !== '')
    || (typeof transactionTypeLabel === 'string' && transactionTypeLabel.trim() !== '')
  ) {
    const code  = typeof transactionTypeCode  === 'string' ? transactionTypeCode.trim()  : '';
    const label = typeof transactionTypeLabel === 'string' ? transactionTypeLabel.trim() : '';
    const branches = [];
    if (code)  { branches.push('LOWER(ip.transaction_type) = LOWER(?)');      params.push(code); }
    if (label) { branches.push('LOWER(ip.transaction_type_name) = LOWER(?)'); params.push(label); }
    if (branches.length) where.push(`(${branches.join(' OR ')})`);
  }
  // Property Variety — same OR-match pattern. The variety CODE lives in
  // `transaction_variant` (a stored variant slug like 'flat', 'bungalow',
  // 'new'); the canonical LABEL lives in `property_variety_name` on the
  // subset of rows that captured a variety master reference.
  if (
    (typeof propertyVarietyCode === 'string' && propertyVarietyCode.trim() !== '')
    || (typeof propertyVarietyLabel === 'string' && propertyVarietyLabel.trim() !== '')
  ) {
    const code  = typeof propertyVarietyCode  === 'string' ? propertyVarietyCode.trim()  : '';
    const label = typeof propertyVarietyLabel === 'string' ? propertyVarietyLabel.trim() : '';
    const branches = [];
    if (code)  { branches.push('LOWER(ip.transaction_variant) = LOWER(?)');    params.push(code); }
    if (label) { branches.push('LOWER(ip.property_variety_name) = LOWER(?)'); params.push(label); }
    if (branches.length) where.push(`(${branches.join(' OR ')})`);
  }
  if (district) {
    where.push('ip.district = ?');
    params.push(district);
  }
  if (taluka) {
    where.push('ip.taluka = ?');
    params.push(taluka);
  }
  if (shivar) {
    where.push('ip.shivar = ?');
    params.push(shivar);
  }
  if (status) {
    where.push('ip.status = ?');
    params.push(status);
  }
  // Curated Area filter. EXACT match, not LIKE: the UI control is a
  // dropdown of master labels, so there is no partial input to be forgiving
  // about - and equality can use ix_inventory_properties_area_name, which a
  // leading-wildcard LIKE cannot. (The separate free-text `location` filter
  // below stays LIKE; it searches a geocoded address string.)
  if (area) {
    where.push('ip.area_name = ?');
    params.push(area);
  }
  if (location) {
    where.push('ip.location LIKE ?');
    params.push(`%${location}%`);
  }
  if (priceMin !== undefined) {
    where.push('ip.price >= ?');
    params.push(priceMin);
  }
  if (priceMax !== undefined) {
    where.push('ip.price <= ?');
    params.push(priceMax);
  }
  // T-2026-109: Budget Range filter — see the signature comment above for
  // the full contract. Uses a COALESCE across the polymorphic pricing keys
  // so the filter matches whichever pricing field the property type actually
  // stores. Wrapped as `BUDGET_EXPR` here so the expression stays in one
  // place across the Min and Max branches below.
  //
  // Behaviour with NULL/missing/empty/zero pricing:
  //   * COALESCE picks the first candidate whose parsed numeric value is
  //     both non-empty AND greater than zero. Each candidate goes through:
  //       NULLIF(CAST(NULLIF(NULLIF(JSON_UNQUOTE(...), ''), 'null')
  //         AS DECIMAL(20,2)), 0)
  //     The two inner NULLIFs turn an empty string and the JSON-null
  //     literal (JSON_UNQUOTE renders JSON null as the STRING 'null') into
  //     SQL NULL so CAST returns NULL rather than the misleading 0 it
  //     otherwise produces from those inputs. The outer NULLIF turns a
  //     literal zero into SQL NULL too — that matters because the FE
  //     stores an empty string ("") when a pricing field is untouched,
  //     but some auto-compute paths write "0" for the same "unset"
  //     state. Treating those as NULL lets COALESCE fall through to the
  //     next real candidate instead of anchoring on 0 (which would then
  //     fail every Min>0 filter for records that DO have pricing under a
  //     lower-priority key).
  //   * If every candidate is NULL/empty/zero, COALESCE returns NULL. A
  //     NULL >= X / NULL <= X predicate evaluates to UNKNOWN which SQL
  //     treats as false — such rows are correctly excluded when a Min or
  //     Max is set.
  //   * Priority order:
  //       1. dynamicData.actualCalculatedPropertyPrice (Land / SEZ Land)
  //       2. dynamicData.totalAmount (flat / bungalow / rowhouse /
  //          commercial / shop / project / plot / rate-finder)
  //       3. dynamicData.totalCost (flat purchase-side variants)
  //       4. ip.price (legacy Headline Price for pre-md-engine rows)
  //   * `ip.price` is the last fallback because it's DECIMAL(14,2) NOT NULL
  //     (defaults to 0 for md-engine rows). The NULLIF-on-zero on ip.price
  //     ensures a zero here also falls through — but since ip.price is the
  //     LAST candidate, a NULL result means the record simply has no
  //     "Actual Property Cost" captured anywhere and is correctly filtered
  //     out when a Min or Max is applied.
  //
  // JSON extraction primitives:
  //   JSON_EXTRACT + JSON_UNQUOTE are available on MariaDB 10.2+; MariaDB
  //   10.4 is the project baseline. Same functions already used for
  //   JSON_SEARCH on the contacts / keyPersons paths higher in this file.
  const BUDGET_EXPR = `COALESCE(
    NULLIF(CAST(NULLIF(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(ip.details, '$.dynamicData.actualCalculatedPropertyPrice')), ''), 'null') AS DECIMAL(20,2)), 0),
    NULLIF(CAST(NULLIF(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(ip.details, '$.dynamicData.totalAmount')), ''), 'null') AS DECIMAL(20,2)), 0),
    NULLIF(CAST(NULLIF(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(ip.details, '$.dynamicData.totalCost')), ''), 'null') AS DECIMAL(20,2)), 0),
    NULLIF(ip.price, 0)
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
    where.push('ip.created_at >= ?');
    params.push(dateFrom);
  }
  if (dateTo) {
    where.push('ip.created_at < DATE_ADD(?, INTERVAL 1 DAY)');
    params.push(dateTo);
  }
  // Reports Posting Date Wise uses this explicit pair. Keep it separate
  // from dateFrom/dateTo, which are retained as Created Date filters for
  // the existing Inventory list and dashboard callers.
  if (postingDateFrom) {
    where.push('ip.posting_date >= ?');
    params.push(postingDateFrom);
  }
  if (postingDateTo) {
    where.push('ip.posting_date < DATE_ADD(?, INTERVAL 1 DAY)');
    params.push(postingDateTo);
  }
  if (typeof isDraft === 'boolean') {
    where.push('ip.is_draft = ?');
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
    `SELECT ip.id, ip.property_code, ip.posting_date, ip.available_from_date, ip.title, ip.description,
            ip.property_type, ip.property_type_id, ip.property_type_name,
            ip.transaction_type, ip.transaction_type_id, ip.transaction_type_name,
            ip.transaction_variant, ip.property_variety_id, ip.property_variety_name,
            ip.location, ip.area_name, ip.district, ip.taluka, ip.shivar, ip.latitude, ip.longitude, ip.formatted_address, ip.pincode,
            ip.area_value, ip.area_unit, ip.bhk, ip.price, ip.status, ip.status_note, ip.status_changed_at,
            ip.is_draft, ip.owner_name, ip.owner_contact,
            ip.agent_name, ip.agent_contact, ip.details, ip.created_at, ip.updated_at,
            ip.agreement_start_date, ip.agreement_end_date,
            -- T-2026-141 (slice 6): expose the T-2026-138 top-level flag + counter
            -- on the LIST projection so the admin InventoryList row can render the
            -- Builder Property badge + total-units summary column WITHOUT a second
            -- round-trip. toListItem() maps these to isBuilderMaster (boolean)
            -- and totalUnitsPlanned (number|null). Pre-T-136 rows land 0/NULL.
            ip.is_builder_master, ip.total_units_planned,
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
     (property_code, posting_date, available_from_date, title, description, property_type, property_type_id, property_type_name,
      transaction_type, transaction_type_id, transaction_type_name, transaction_variant, property_variety_id, property_variety_name,
      location, area_name, district, taluka, shivar,
      latitude, longitude, formatted_address, pincode,
      area_value, area_unit, bhk, price, status, is_draft,
      owner_name, owner_contact, agent_name, agent_contact, details, created_by_admin_id,
      agreement_start_date, agreement_end_date,
      -- T-2026-138: Builder Property / Multi-Unit Inventory (migration 099).
      -- is_builder_master defaults to 0 in the DB, so omitting the value
      -- lands the correct "normal property" flag for every existing caller
      -- that predates T-136. total_units_planned is NULL when unset.
      is_builder_master, total_units_planned)
     -- 39 placeholders for 39 columns. Keep the two in step: area_name
     -- (migration 120) was added to the column list and to the params array
     -- but not here, leaving 38. mysql2 substitutes positionally and stops
     -- when the placeholders run out, so the last one reached MySQL as a
     -- literal question mark and every inventory CREATE died with
     -- ER_PARSE_ERROR. The UPDATE below is a separate statement, which is
     -- why editing a property kept working.
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      payload.areaName || null,
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
      // T-2026-112: Agreement Tracking & Reminder System — top-level dates
      // for fast reminder-list scans. Rent Out / Lease Out only; every other
      // form leaves these NULL.
      payload.agreementStartDate || null,
      payload.agreementEndDate || null,
      // T-2026-138: Builder Property (Admin-only). Coerce to 0/1 so the
      // DB TINYINT stays clean regardless of what the FE sent (boolean /
      // 0 / 1 / undefined). Absent / falsy = 0 (normal property, matches
      // migration-099 DEFAULT).
      payload.isBuilderMaster ? 1 : 0,
      // total_units_planned is nullable. Coerce '' / undefined to NULL so
      // an admin who typed "5" and then cleared the field lands NULL, not
      // an empty string. Non-numeric input from any source lands NULL
      // instead of NaN (which would silently corrupt the column).
      payload.totalUnitsPlanned === '' || payload.totalUnitsPlanned == null
        ? null
        : (Number.isFinite(Number(payload.totalUnitsPlanned))
            ? Number(payload.totalUnitsPlanned)
            : null),
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
       posting_date = ?, available_from_date = ?, title = ?, description = ?,
       property_type = ?, property_type_id = ?, property_type_name = ?,
       transaction_type = ?, transaction_type_id = ?, transaction_type_name = ?,
       transaction_variant = ?, property_variety_id = ?, property_variety_name = ?,
       area_name = ?, location = ?, district = ?, taluka = ?, shivar = ?,
       latitude = ?, longitude = ?, formatted_address = ?, pincode = ?,
       area_value = ?, area_unit = ?, bhk = ?, price = ?, status = ?, is_draft = ?,
       owner_name = ?, owner_contact = ?, agent_name = ?, agent_contact = ?, details = ?,
       agreement_start_date = ?, agreement_end_date = ?,
       -- T-2026-138: Builder Property columns (migration 099). Nullable-safe
       -- update via COALESCE-with-existing: only overwritten when the caller
       -- sent a non-undefined value. This preserves the "normal property"
       -- flag on any pre-T-136 update flow that never sends the keys.
       is_builder_master   = COALESCE(?, is_builder_master),
       total_units_planned = ?
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
      payload.areaName || null,
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
      // T-2026-138: Builder Property flag + counter.
      //   is_builder_master: pass null when key is absent so the SQL
      //     COALESCE(?, is_builder_master) leaves the existing value
      //     unchanged. When present, coerce boolean/number to 0/1.
      //     Ensures a legacy PUT that doesn't know about the flag can
      //     round-trip a Builder-marked master without accidentally
      //     wiping the flag.
      //   total_units_planned: three cases:
      //     - key ABSENT (undefined): leave existing value alone.
      //       Since MySQL doesn't have "skip this column" in bulk SET,
      //       we route undefined through the same COALESCE trick — but
      //       for simplicity and consistency with existing columns above,
      //       we send the coerced value directly. An UPDATE that doesn't
      //       set the field will therefore overwrite it with NULL. This
      //       matches how postingDate / agreementStartDate / etc. behave
      //       on this same UPDATE (a caller who omits them wipes them),
      //       so no new invariant is introduced.
      //     - empty string / null: NULL (admin cleared the field).
      //     - numeric string / number: coerce to integer.
      payload.isBuilderMaster === undefined
        ? null
        : (payload.isBuilderMaster ? 1 : 0),
      payload.totalUnitsPlanned === '' || payload.totalUnitsPlanned == null
        ? null
        : (Number.isFinite(Number(payload.totalUnitsPlanned))
            ? Number(payload.totalUnitsPlanned)
            : null),
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
