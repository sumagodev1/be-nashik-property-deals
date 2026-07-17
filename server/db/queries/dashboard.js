const { pool } = require('../pool');

/**
 * All counts ignore soft-deleted rows.
 */
async function counters() {
  const [[seller]] = await pool.query(`
    SELECT
      SUM(deleted_at IS NULL) AS total_sellers,
      SUM(deleted_at IS NULL AND user_type = 'owner') AS total_owners,
      SUM(deleted_at IS NULL AND user_type = 'agent') AS total_agents,
      SUM(deleted_at IS NULL AND is_verified = 1) AS total_verified_sellers,
      SUM(deleted_at IS NULL AND is_active = 1) AS total_active_sellers
    FROM sellers
  `);

  const [[website]] = await pool.query(`
    SELECT
      SUM(deleted_at IS NULL) AS total_website,
      SUM(deleted_at IS NULL AND approval_status = 'pending') AS pending_approvals,
      SUM(deleted_at IS NULL AND approval_status = 'approved' AND is_active = 1) AS live_listings,
      SUM(deleted_at IS NULL AND is_featured = 1) AS featured_listings
    FROM website_properties
  `);

  const [[inventory]] = await pool.query(`
    SELECT
      SUM(deleted_at IS NULL) AS total_inventory,
      SUM(deleted_at IS NULL AND status = 'available') AS available_inventory
    FROM inventory_properties
  `);

  const [[leads]] = await pool.query(`
    SELECT
      SUM(deleted_at IS NULL) AS total_leads,
      SUM(deleted_at IS NULL AND status = 'new')          AS new_leads,
      SUM(deleted_at IS NULL AND status = 'contacted')    AS contacted_leads,
      SUM(deleted_at IS NULL AND status = 'site_visit')   AS site_visit_leads,
      SUM(deleted_at IS NULL AND status = 'closed_won')   AS closed_won_leads,
      SUM(deleted_at IS NULL AND status = 'closed_lost')  AS closed_lost_leads
    FROM leads
  `);

  return {
    sellers: {
      total: num(seller.total_sellers),
      owners: num(seller.total_owners),
      agents: num(seller.total_agents),
      verified: num(seller.total_verified_sellers),
      active: num(seller.total_active_sellers),
    },
    websiteProperties: {
      total: num(website.total_website),
      pendingApprovals: num(website.pending_approvals),
      liveListings: num(website.live_listings),
      featured: num(website.featured_listings),
    },
    inventoryProperties: {
      total: num(inventory.total_inventory),
      available: num(inventory.available_inventory),
    },
    leads: {
      total: num(leads.total_leads),
      new: num(leads.new_leads),
      contacted: num(leads.contacted_leads),
      siteVisit: num(leads.site_visit_leads),
      closedWon: num(leads.closed_won_leads),
      closedLost: num(leads.closed_lost_leads),
    },
  };
}

async function listingsByDay({ days = 30 } = {}) {
  const [website] = await pool.query(
    `SELECT DATE(created_at) AS day, COUNT(*) AS count
     FROM website_properties
     WHERE deleted_at IS NULL
       AND created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
     GROUP BY DATE(created_at)
     ORDER BY day ASC`,
    [days],
  );
  const [inventory] = await pool.query(
    `SELECT DATE(created_at) AS day, COUNT(*) AS count
     FROM inventory_properties
     WHERE deleted_at IS NULL
       AND created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
     GROUP BY DATE(created_at)
     ORDER BY day ASC`,
    [days],
  );

  // Backfill missing days with 0 so the chart x-axis is continuous.
  const days_keys = [];
  const start = new Date();
  start.setUTCDate(start.getUTCDate() - (days - 1));
  for (let i = 0; i < days; i += 1) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    days_keys.push(d.toISOString().slice(0, 10));
  }
  const websiteByDay = Object.fromEntries(website.map((r) => [String(r.day).slice(0, 10), Number(r.count)]));
  const inventoryByDay = Object.fromEntries(inventory.map((r) => [String(r.day).slice(0, 10), Number(r.count)]));

  return days_keys.map((day) => ({
    day,
    website: websiteByDay[day] || 0,
    inventory: inventoryByDay[day] || 0,
  }));
}

async function listingsByPropertyType() {
  // Website + Inventory unioned to a single distribution.
  const [rows] = await pool.query(`
    SELECT property_type AS type, SUM(cnt) AS count
    FROM (
      SELECT property_type, COUNT(*) AS cnt FROM website_properties
       WHERE deleted_at IS NULL GROUP BY property_type
      UNION ALL
      SELECT property_type, COUNT(*) AS cnt FROM inventory_properties
       WHERE deleted_at IS NULL GROUP BY property_type
    ) t
    GROUP BY property_type
    ORDER BY count DESC
  `);
  return rows.map((r) => ({ type: r.type, count: Number(r.count) }));
}

async function listingsByTransactionType() {
  const [rows] = await pool.query(`
    SELECT transaction_type AS type, SUM(cnt) AS count
    FROM (
      SELECT transaction_type, COUNT(*) AS cnt FROM website_properties
       WHERE deleted_at IS NULL GROUP BY transaction_type
      UNION ALL
      SELECT transaction_type, COUNT(*) AS cnt FROM inventory_properties
       WHERE deleted_at IS NULL GROUP BY transaction_type
    ) t
    GROUP BY transaction_type
    ORDER BY count DESC
  `);
  return rows.map((r) => ({ type: r.type, count: Number(r.count) }));
}

async function topAreas({ limit = 10 } = {}) {
  const [rows] = await pool.query(
    `SELECT location, SUM(cnt) AS count
     FROM (
       SELECT location, COUNT(*) AS cnt FROM website_properties
        WHERE deleted_at IS NULL GROUP BY location
       UNION ALL
       SELECT location, COUNT(*) AS cnt FROM inventory_properties
        WHERE deleted_at IS NULL GROUP BY location
     ) t
     GROUP BY location
     ORDER BY count DESC, location ASC
     LIMIT ?`,
    [limit],
  );
  return rows.map((r) => ({ location: r.location, count: Number(r.count) }));
}

// Website-only top areas. Used by the dashboard's split "Top areas" cards
// so admin can see hotspots in seller-submitted listings vs the admin-
// curated inventory side-by-side instead of as one merged total.
async function topAreasWebsite({ limit = 10 } = {}) {
  const [rows] = await pool.query(
    `SELECT location, COUNT(*) AS count
     FROM website_properties
     WHERE deleted_at IS NULL AND location IS NOT NULL AND location != ''
     GROUP BY location
     ORDER BY count DESC, location ASC
     LIMIT ?`,
    [limit],
  );
  return rows.map((r) => ({ location: r.location, count: Number(r.count) }));
}

async function topAreasInventory({ limit = 10 } = {}) {
  const [rows] = await pool.query(
    `SELECT location, COUNT(*) AS count
     FROM inventory_properties
     WHERE deleted_at IS NULL AND location IS NOT NULL AND location != ''
     GROUP BY location
     ORDER BY count DESC, location ASC
     LIMIT ?`,
    [limit],
  );
  return rows.map((r) => ({ location: r.location, count: Number(r.count) }));
}

/**
 * Aggregated listings (website + inventory side-by-side) at a chosen bucket
 * granularity. Buckets are continuous — days/weeks/months with zero rows
 * are backfilled so the chart x-axis stays gap-free.
 */
async function listingsByBucket({ granularity = 'daily', dateFrom = null, dateTo = null } = {}) {
  let bucketSql;
  let labelFn;
  let buckets;

  if (granularity === 'weekly') {
    // Last 12 ISO weeks (Mon-start).
    bucketSql = "DATE_FORMAT(DATE_SUB(created_at, INTERVAL WEEKDAY(created_at) DAY), '%Y-%m-%d')";
    buckets = buildWeekBuckets(12);
    labelFn = (b) => b;
  } else if (granularity === 'monthly') {
    bucketSql = "DATE_FORMAT(created_at, '%Y-%m')";
    buckets = buildMonthBuckets(12);
    labelFn = (b) => b;
  } else if (granularity === 'custom' && dateFrom && dateTo) {
    bucketSql = "DATE_FORMAT(created_at, '%Y-%m-%d')";
    buckets = buildDayBucketsBetween(dateFrom, dateTo);
    labelFn = (b) => b;
  } else {
    bucketSql = "DATE_FORMAT(created_at, '%Y-%m-%d')";
    const days = granularity === 'daily' && dateFrom && dateTo ? null : 30;
    buckets = days ? buildDayBuckets(days) : buildDayBucketsBetween(dateFrom, dateTo);
    labelFn = (b) => b;
  }

  // Both queries filter to the earliest bucket boundary to keep result rows small.
  const since = buckets.length > 0 ? buckets[0] : new Date().toISOString().slice(0, 10);

  const [websiteRows] = await pool.query(
    `SELECT ${bucketSql} AS bucket, COUNT(*) AS count
     FROM website_properties
     WHERE deleted_at IS NULL AND created_at >= ?
     GROUP BY bucket
     ORDER BY bucket ASC`,
    [since],
  );
  const [inventoryRows] = await pool.query(
    `SELECT ${bucketSql} AS bucket, COUNT(*) AS count
     FROM inventory_properties
     WHERE deleted_at IS NULL AND created_at >= ?
     GROUP BY bucket
     ORDER BY bucket ASC`,
    [since],
  );

  const websiteMap = Object.fromEntries(websiteRows.map((r) => [String(r.bucket), Number(r.count)]));
  const inventoryMap = Object.fromEntries(inventoryRows.map((r) => [String(r.bucket), Number(r.count)]));

  return buckets.map((b) => ({
    bucket: labelFn(b),
    website: websiteMap[b] || 0,
    inventory: inventoryMap[b] || 0,
  }));
}

function buildDayBuckets(days) {
  const out = [];
  const start = new Date();
  start.setUTCDate(start.getUTCDate() - (days - 1));
  for (let i = 0; i < days; i += 1) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function buildDayBucketsBetween(fromYmd, toYmd) {
  const out = [];
  const start = new Date(`${fromYmd}T00:00:00Z`);
  const end = new Date(`${toYmd}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return [];
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(new Date(d).toISOString().slice(0, 10));
  }
  // Cap absurdly long ranges to protect the chart axis.
  return out.length > 366 ? out.slice(-366) : out;
}

function buildWeekBuckets(weeks) {
  const out = [];
  const now = new Date();
  // Find current week's Monday in UTC.
  const day = (now.getUTCDay() + 6) % 7;
  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() - day);
  monday.setUTCHours(0, 0, 0, 0);
  for (let i = weeks - 1; i >= 0; i -= 1) {
    const d = new Date(monday);
    d.setUTCDate(monday.getUTCDate() - i * 7);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function buildMonthBuckets(months) {
  const out = [];
  const now = new Date();
  for (let i = months - 1; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push(d.toISOString().slice(0, 7));
  }
  return out;
}

async function sellersByArea({ limit = 10 } = {}) {
  const [rows] = await pool.query(
    `SELECT COALESCE(NULLIF(TRIM(area), ''), '(no area set)') AS area, COUNT(*) AS count
     FROM sellers
     WHERE deleted_at IS NULL
     GROUP BY area
     ORDER BY count DESC, area ASC
     LIMIT ?`,
    [Math.min(50, Math.max(1, limit))],
  );
  return rows.map((r) => ({ area: r.area, count: Number(r.count) }));
}

/**
 * Same shape as listingsByBucket but on the sellers table, with the count split
 * between owners and agents (the chart shows both series).
 *
 * Returns: [{ bucket, owners, agents }, ...]
 */
async function sellerOnboardingByBucket({ granularity = 'daily', dateFrom = null, dateTo = null } = {}) {
  let bucketSql;
  let buckets;

  if (granularity === 'weekly') {
    bucketSql = "DATE_FORMAT(DATE_SUB(created_at, INTERVAL WEEKDAY(created_at) DAY), '%Y-%m-%d')";
    buckets = buildWeekBuckets(12);
  } else if (granularity === 'monthly') {
    bucketSql = "DATE_FORMAT(created_at, '%Y-%m')";
    buckets = buildMonthBuckets(12);
  } else if (granularity === 'custom' && dateFrom && dateTo) {
    bucketSql = "DATE_FORMAT(created_at, '%Y-%m-%d')";
    buckets = buildDayBucketsBetween(dateFrom, dateTo);
  } else {
    bucketSql = "DATE_FORMAT(created_at, '%Y-%m-%d')";
    buckets = buildDayBuckets(30);
  }

  const since = buckets.length > 0 ? buckets[0] : new Date().toISOString().slice(0, 10);

  const [rows] = await pool.query(
    `SELECT ${bucketSql} AS bucket,
            SUM(user_type = 'owner') AS owners,
            SUM(user_type = 'agent') AS agents
     FROM sellers
     WHERE deleted_at IS NULL AND created_at >= ?
     GROUP BY bucket
     ORDER BY bucket ASC`,
    [since],
  );

  const lookup = Object.fromEntries(rows.map((r) => [
    String(r.bucket),
    { o: Number(r.owners || 0), a: Number(r.agents || 0) },
  ]));

  return buckets.map((b) => ({
    bucket: b,
    owners: lookup[b]?.o || 0,
    agents: lookup[b]?.a || 0,
  }));
}

async function sellerOnboardingByDay({ days = 30 } = {}) {
  const [rows] = await pool.query(
    `SELECT DATE(created_at) AS day,
            SUM(user_type = 'owner') AS owners,
            SUM(user_type = 'agent') AS agents
     FROM sellers
     WHERE deleted_at IS NULL
       AND created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
     GROUP BY DATE(created_at)
     ORDER BY day ASC`,
    [days],
  );
  const days_keys = [];
  const start = new Date();
  start.setUTCDate(start.getUTCDate() - (days - 1));
  for (let i = 0; i < days; i += 1) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    days_keys.push(d.toISOString().slice(0, 10));
  }
  const lookup = Object.fromEntries(rows.map((r) => [String(r.day).slice(0, 10), { o: Number(r.owners || 0), a: Number(r.agents || 0) }]));
  return days_keys.map((day) => ({
    day,
    owners: lookup[day]?.o || 0,
    agents: lookup[day]?.a || 0,
  }));
}

function num(v) {
  return Number(v || 0);
}

/* ──────────────────────────────────────────────────────────────────
 * Per-surface counters and charts.
 *
 * The dashboard is split into two isolated views (Website + Inventory)
 * so admins can focus on one property surface at a time — the payloads
 * below never mix data across the two tables.
 * ────────────────────────────────────────────────────────────────── */

async function websiteCounters() {
  const [[website]] = await pool.query(`
    SELECT
      SUM(deleted_at IS NULL) AS total_website,
      SUM(deleted_at IS NULL AND approval_status = 'pending') AS pending_approvals,
      SUM(deleted_at IS NULL AND approval_status = 'approved' AND is_active = 1) AS live_listings,
      SUM(deleted_at IS NULL AND approval_status = 'rejected') AS rejected_listings,
      SUM(deleted_at IS NULL AND is_featured = 1) AS featured_listings
    FROM website_properties
  `);
  return {
    total: num(website.total_website),
    pendingApprovals: num(website.pending_approvals),
    liveListings: num(website.live_listings),
    rejected: num(website.rejected_listings),
    featured: num(website.featured_listings),
  };
}

async function inventoryCounters() {
  const [[inventory]] = await pool.query(`
    SELECT
      SUM(deleted_at IS NULL) AS total_inventory,
      SUM(deleted_at IS NULL AND status = 'available') AS available_inventory,
      SUM(deleted_at IS NULL AND status = 'sold') AS sold_inventory,
      SUM(deleted_at IS NULL AND status = 'rented') AS rented_inventory,
      SUM(deleted_at IS NULL AND status = 'on_hold') AS on_hold_inventory
    FROM inventory_properties
  `);
  return {
    total: num(inventory.total_inventory),
    available: num(inventory.available_inventory),
    sold: num(inventory.sold_inventory),
    rented: num(inventory.rented_inventory),
    onHold: num(inventory.on_hold_inventory),
  };
}

// Same shape as inventoryCounters, restricted to the enquiry_properties
// table. Kept as a separate function (rather than a factory over table
// name) so future divergence (e.g. enquiry-only status like 'contacted')
// can happen here without dragging inventory along.
async function enquiryCounters() {
  const [[enquiry]] = await pool.query(`
    SELECT
      SUM(deleted_at IS NULL) AS total_enquiry,
      SUM(deleted_at IS NULL AND status = 'available') AS available_enquiry,
      SUM(deleted_at IS NULL AND status = 'sold') AS sold_enquiry,
      SUM(deleted_at IS NULL AND status = 'rented') AS rented_enquiry,
      SUM(deleted_at IS NULL AND status = 'on_hold') AS on_hold_enquiry
    FROM enquiry_properties
  `);
  return {
    total: num(enquiry.total_enquiry),
    available: num(enquiry.available_enquiry),
    sold: num(enquiry.sold_enquiry),
    rented: num(enquiry.rented_enquiry),
    onHold: num(enquiry.on_hold_enquiry),
  };
}

async function topAreasEnquiry({ limit = 10 } = {}) {
  const [rows] = await pool.query(
    `SELECT location, COUNT(*) AS count
     FROM enquiry_properties
     WHERE deleted_at IS NULL AND location IS NOT NULL AND location != ''
     GROUP BY location
     ORDER BY count DESC, location ASC
     LIMIT ?`,
    [limit],
  );
  return rows.map((r) => ({ location: r.location, count: Number(r.count) }));
}

/**
 * Listings-over-time restricted to a single table. Same bucket logic as
 * listingsByBucket but the result is a single `count` series (no cross-
 * surface mixing).
 */
async function listingsByBucketSingle(table, { granularity = 'daily', dateFrom = null, dateTo = null } = {}) {
  // Whitelist the table name — this string is interpolated into SQL below,
  // so an unexpected value would be a SQL injection. All callers pass a
  // literal ('website_properties' | 'inventory_properties' |
  // 'enquiry_properties'); the guard is defense in depth against a future
  // caller passing user input.
  if (table !== 'website_properties' && table !== 'inventory_properties' && table !== 'enquiry_properties') {
    throw new Error(`Unsupported table for listingsByBucketSingle: ${table}`);
  }

  let bucketSql;
  let buckets;

  if (granularity === 'weekly') {
    bucketSql = "DATE_FORMAT(DATE_SUB(created_at, INTERVAL WEEKDAY(created_at) DAY), '%Y-%m-%d')";
    buckets = buildWeekBuckets(12);
  } else if (granularity === 'monthly') {
    bucketSql = "DATE_FORMAT(created_at, '%Y-%m')";
    buckets = buildMonthBuckets(12);
  } else if (granularity === 'custom' && dateFrom && dateTo) {
    bucketSql = "DATE_FORMAT(created_at, '%Y-%m-%d')";
    buckets = buildDayBucketsBetween(dateFrom, dateTo);
  } else {
    bucketSql = "DATE_FORMAT(created_at, '%Y-%m-%d')";
    buckets = buildDayBuckets(30);
  }

  const since = buckets.length > 0 ? buckets[0] : new Date().toISOString().slice(0, 10);

  const [rows] = await pool.query(
    `SELECT ${bucketSql} AS bucket, COUNT(*) AS count
     FROM ${table}
     WHERE deleted_at IS NULL AND created_at >= ?
     GROUP BY bucket
     ORDER BY bucket ASC`,
    [since],
  );

  const map = Object.fromEntries(rows.map((r) => [String(r.bucket), Number(r.count)]));
  return buckets.map((b) => ({ bucket: b, count: map[b] || 0 }));
}

async function listingsByPropertyTypeSingle(table) {
  if (table !== 'website_properties' && table !== 'inventory_properties' && table !== 'enquiry_properties') {
    throw new Error(`Unsupported table: ${table}`);
  }
  const [rows] = await pool.query(
    `SELECT property_type AS type, COUNT(*) AS count
     FROM ${table}
     WHERE deleted_at IS NULL
     GROUP BY property_type
     ORDER BY count DESC`,
  );
  return rows.map((r) => ({ type: r.type, count: Number(r.count) }));
}

async function listingsByTransactionTypeSingle(table) {
  if (table !== 'website_properties' && table !== 'inventory_properties' && table !== 'enquiry_properties') {
    throw new Error(`Unsupported table: ${table}`);
  }
  const [rows] = await pool.query(
    `SELECT transaction_type AS type, COUNT(*) AS count
     FROM ${table}
     WHERE deleted_at IS NULL
     GROUP BY transaction_type
     ORDER BY count DESC`,
  );
  return rows.map((r) => ({ type: r.type, count: Number(r.count) }));
}

/**
 * By-Property-Variety distribution.
 *
 * Variety is not a dedicated column on any of the three surfaces today.
 * inventory_properties + enquiry_properties expose it via
 * `transaction_variant` (see migration 027 comment: "Resale vs New Sale,
 * Joint Venture, Hostel Let"). website_properties has neither the column
 * nor a variety concept — free-text listings — so we extract from the
 * `details` JSON where a variety key may have been saved by a form.
 *
 * The frontend maps the returned codes through the property_variety master
 * so admins can rename or hide values without a backend change.
 */
async function listingsByPropertyVarietySingle(table) {
  if (table !== 'website_properties' && table !== 'inventory_properties' && table !== 'enquiry_properties') {
    throw new Error(`Unsupported table: ${table}`);
  }
  let sql;
  if (table === 'website_properties') {
    // website_properties has no transaction_variant column. Try `details` JSON
    // — several form flows have persisted variety under one of these keys.
    // Coalesce falls through to the first non-null / non-'null'-string.
    sql = `SELECT COALESCE(
             NULLIF(JSON_UNQUOTE(JSON_EXTRACT(details, '$.property_variety')), 'null'),
             NULLIF(JSON_UNQUOTE(JSON_EXTRACT(details, '$.propertyVariety')),  'null'),
             NULLIF(JSON_UNQUOTE(JSON_EXTRACT(details, '$.variety')),          'null'),
             NULLIF(JSON_UNQUOTE(JSON_EXTRACT(details, '$.variant')),          'null'),
             ''
           ) AS type, COUNT(*) AS count
           FROM website_properties
           WHERE deleted_at IS NULL
           GROUP BY type
           HAVING type <> ''
           ORDER BY count DESC`;
  } else {
    // inventory_properties + enquiry_properties: transaction_variant is the
    // canonical field. Fall through to details JSON for legacy rows that
    // saved variety directly there.
    sql = `SELECT COALESCE(
             NULLIF(transaction_variant, ''),
             NULLIF(JSON_UNQUOTE(JSON_EXTRACT(details, '$.property_variety')), 'null'),
             NULLIF(JSON_UNQUOTE(JSON_EXTRACT(details, '$.propertyVariety')),  'null'),
             NULLIF(JSON_UNQUOTE(JSON_EXTRACT(details, '$.variety')),          'null'),
             NULLIF(JSON_UNQUOTE(JSON_EXTRACT(details, '$.variant')),          'null'),
             ''
           ) AS type, COUNT(*) AS count
           FROM ${table}
           WHERE deleted_at IS NULL
           GROUP BY type
           HAVING type <> ''
           ORDER BY count DESC`;
  }
  const [rows] = await pool.query(sql);
  return rows.map((r) => ({ type: r.type, count: Number(r.count) }));
}

module.exports = {
  counters,
  listingsByDay,
  listingsByBucket,
  listingsByPropertyType,
  listingsByTransactionType,
  topAreas,
  topAreasWebsite,
  topAreasInventory,
  topAreasEnquiry,
  sellerOnboardingByDay,
  sellerOnboardingByBucket,
  sellersByArea,
  // Per-surface (isolated) queries — used by the split dashboards.
  websiteCounters,
  inventoryCounters,
  enquiryCounters,
  listingsByBucketSingle,
  listingsByPropertyTypeSingle,
  listingsByTransactionTypeSingle,
  listingsByPropertyVarietySingle,
};
