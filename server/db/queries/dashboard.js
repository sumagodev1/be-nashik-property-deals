const { pool } = require('../pool');

// Property dashboards use Indian calendar dates. `created_at` is stored as
// UTC and every pool connection is deliberately pinned to UTC, so date
// buckets must translate the stored instant to the application's calendar
// before grouping or applying a selected date range. Keeping the offset here
// (rather than relying on the host process timezone or MySQL timezone tables)
// makes the API and the browser's Nashik date presets agree at midnight.
const DASHBOARD_IST_OFFSET_MINUTES = 330;
const DASHBOARD_IST_OFFSET_MS = DASHBOARD_IST_OFFSET_MINUTES * 60 * 1000;
const LOCAL_DAILY_BUCKET_SQL = "DATE_FORMAT(DATE_ADD(created_at, INTERVAL 330 MINUTE), '%Y-%m-%d')";
const LOCAL_WEEKLY_BUCKET_SQL = "DATE_FORMAT(DATE_SUB(DATE(DATE_ADD(created_at, INTERVAL 330 MINUTE)), INTERVAL WEEKDAY(DATE(DATE_ADD(created_at, INTERVAL 330 MINUTE))) DAY), '%Y-%m-%d')";
const LOCAL_MONTHLY_BUCKET_SQL = "DATE_FORMAT(DATE_ADD(created_at, INTERVAL 330 MINUTE), '%Y-%m')";

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

// Facets on the CURATED Area, not the free-text `location` column.
//
// `location` holds a geocoded address string ("Anandwali, Nashik, Nashik
// Subdistrict, Nashik District, Maharashtra, 422013, India"), so grouping on
// it produced one bar per property with a barely-readable label - which is
// what the client reported. `area_name` is the value picked from the Area
// master, so equal areas actually collapse into one bar.
//
// Rows with no Area are excluded rather than bucketed into an "Unknown" bar:
// this card ranks the top areas, and a giant bucket of un-tagged records
// would dominate it while saying nothing. Note every property predating the
// Area field has NULL here, so the card stays empty until Areas are filled.
//
// The response key stays `location` on purpose - it is the shape the three
// dashboards already map (d.location -> label), and renaming it would break
// them for no gain.
async function topAreasInventory({ limit = 10 } = {}) {
  const [rows] = await pool.query(
    `SELECT area_name, COUNT(*) AS count
     FROM inventory_properties
     WHERE deleted_at IS NULL AND area_name IS NOT NULL AND area_name != ''
     GROUP BY area_name
     ORDER BY count DESC, area_name ASC
     LIMIT ?`,
    [limit],
  );
  return rows.map((r) => ({ location: r.area_name, count: Number(r.count) }));
}

/**
 * Aggregated listings (website + inventory side-by-side) at a chosen bucket
 * granularity. Buckets are continuous — days/weeks/months with zero rows
 * are backfilled so the chart x-axis stays gap-free.
 */
async function listingsByBucket({ days = 30, granularity = 'daily', dateFrom = null, dateTo = null } = {}) {
  const spec = makeBucketSpec({ granularity, dateFrom, dateTo, days });

  const [websiteRows] = await pool.query(
    `SELECT ${spec.bucketSql} AS bucket, COUNT(*) AS count
     FROM website_properties
     WHERE deleted_at IS NULL AND created_at >= ? AND created_at < ?
     GROUP BY bucket
     ORDER BY bucket ASC`,
    spec.bounds,
  );
  const [inventoryRows] = await pool.query(
    `SELECT ${spec.bucketSql} AS bucket, COUNT(*) AS count
     FROM inventory_properties
     WHERE deleted_at IS NULL AND created_at >= ? AND created_at < ?
     GROUP BY bucket
     ORDER BY bucket ASC`,
    spec.bounds,
  );

  const websiteMap = Object.fromEntries(websiteRows.map((r) => [String(r.bucket), Number(r.count)]));
  const inventoryMap = Object.fromEntries(inventoryRows.map((r) => [String(r.bucket), Number(r.count)]));

  return spec.buckets.map((b) => ({
    bucket: b,
    website: websiteMap[b] || 0,
    inventory: inventoryMap[b] || 0,
  }));
}

function buildDayBuckets(days) {
  const count = Math.max(1, Number(days) || 30);
  const today = dashboardLocalDateToday();
  return buildDayBucketsBetween(addDays(today, -(count - 1)), today);
}

function buildDayBucketsBetween(fromYmd, toYmd) {
  const out = [];
  const start = new Date(`${fromYmd}T00:00:00Z`);
  const end = new Date(`${toYmd}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return [];
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(new Date(d).toISOString().slice(0, 10));
  }
  // Do not truncate a valid custom range. Every returned bucket represents
  // one selected calendar date; silently dropping the older part would make
  // the API count disagree with the selected range and the chart.
  return out;
}

function buildWeekBuckets(weeks) {
  const count = Math.max(1, Number(weeks) || 12);
  const currentMonday = weekStart(addDays(dashboardLocalDateToday(), 0));
  const first = addDays(currentMonday, -(count - 1) * 7);
  return Array.from({ length: count }, (_, index) => addDays(first, index * 7));
}

function buildMonthBuckets(months) {
  const count = Math.max(1, Number(months) || 12);
  const today = dashboardLocalDateToday();
  const current = monthKey(today);
  return Array.from({ length: count }, (_, index) => addMonths(current, -(count - 1) + index));
}

function buildWeekBucketsBetween(fromYmd, toYmd) {
  const start = weekStart(fromYmd);
  const end = weekStart(toYmd);
  if (!start || !end || start > end) return [];
  const out = [];
  for (let current = start; current <= end; current = addDays(current, 7)) out.push(current);
  return out;
}

function buildMonthBucketsBetween(fromYmd, toYmd) {
  const start = monthKey(fromYmd);
  const end = monthKey(toYmd);
  if (!start || !end || start > end) return [];
  const out = [];
  for (let current = start; current <= end; current = addMonths(current, 1)) out.push(current);
  return out;
}

function makeBucketSpec({ granularity = 'daily', dateFrom = null, dateTo = null, days = 30 } = {}) {
  const hasExplicitRange = Boolean(dateFrom && dateTo);
  let bucketSql = LOCAL_DAILY_BUCKET_SQL;
  let buckets;
  let bucketGranularity = 'daily';

  if (granularity === 'weekly') {
    bucketSql = LOCAL_WEEKLY_BUCKET_SQL;
    bucketGranularity = 'weekly';
    buckets = hasExplicitRange ? buildWeekBucketsBetween(dateFrom, dateTo) : buildWeekBuckets(12);
  } else if (granularity === 'monthly') {
    bucketSql = LOCAL_MONTHLY_BUCKET_SQL;
    bucketGranularity = 'monthly';
    // An explicit range is still filtered to the exact selected dates; the
    // buckets only describe how those rows are grouped.
    buckets = hasExplicitRange ? buildMonthBucketsBetween(dateFrom, dateTo) : buildMonthBuckets(12);
  } else if (granularity === 'custom' && hasExplicitRange) {
    buckets = buildDayBucketsBetween(dateFrom, dateTo);
  } else if (granularity === 'daily' && hasExplicitRange) {
    buckets = buildDayBucketsBetween(dateFrom, dateTo);
  } else {
    buckets = buildDayBuckets(days);
  }

  const first = buckets[0] || dashboardLocalDateToday();
  const last = buckets[buckets.length - 1] || first;
  const lowerDate = hasExplicitRange ? dateFrom : bucketStartDate(first, bucketGranularity);
  const upperDate = hasExplicitRange
    ? addDays(dateTo, 1)
    : nextBucketStartDate(last, bucketGranularity);

  return {
    bucketSql,
    buckets,
    bounds: [localDateStartUtc(lowerDate), localDateStartUtc(upperDate)],
  };
}

function dashboardLocalDateToday() {
  return formatYmd(new Date(Date.now() + DASHBOARD_IST_OFFSET_MS));
}

function formatYmd(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function dateValue(ymd) {
  const value = new Date(`${ymd}T00:00:00Z`);
  return Number.isNaN(value.getTime()) ? null : value;
}

function addDays(ymd, amount) {
  const value = dateValue(ymd);
  if (!value) return '';
  value.setUTCDate(value.getUTCDate() + amount);
  return formatYmd(value);
}

function weekStart(ymd) {
  const value = dateValue(ymd);
  if (!value) return '';
  const day = (value.getUTCDay() + 6) % 7;
  value.setUTCDate(value.getUTCDate() - day);
  return formatYmd(value);
}

function monthKey(ymd) {
  const match = String(ymd || '').match(/^(\d{4})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}` : '';
}

function addMonths(key, amount) {
  const match = String(key || '').match(/^(\d{4})-(\d{2})$/);
  if (!match) return '';
  const value = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1 + amount, 1));
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}`;
}

function bucketStartDate(bucket, granularity) {
  if (granularity === 'monthly') return `${bucket}-01`;
  return bucket;
}

function nextBucketStartDate(bucket, granularity) {
  if (granularity === 'weekly') return addDays(bucket, 7);
  if (granularity === 'monthly') return `${addMonths(bucket, 1)}-01`;
  return addDays(bucket, 1);
}

function localDateStartUtc(ymd) {
  const value = dateValue(ymd) || dateValue(dashboardLocalDateToday());
  value.setUTCMinutes(value.getUTCMinutes() - DASHBOARD_IST_OFFSET_MINUTES);
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')} ${String(value.getUTCHours()).padStart(2, '0')}:${String(value.getUTCMinutes()).padStart(2, '0')}:00`;
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
async function sellerOnboardingByBucket({ days = 30, granularity = 'daily', dateFrom = null, dateTo = null } = {}) {
  const spec = makeBucketSpec({ granularity, dateFrom, dateTo, days });

  const [rows] = await pool.query(
    `SELECT ${spec.bucketSql} AS bucket,
            SUM(user_type = 'owner') AS owners,
            SUM(user_type = 'agent') AS agents
     FROM sellers
     WHERE deleted_at IS NULL AND created_at >= ? AND created_at < ?
     GROUP BY bucket
     ORDER BY bucket ASC`,
    spec.bounds,
  );

  const lookup = Object.fromEntries(rows.map((r) => [
    String(r.bucket),
    { o: Number(r.owners || 0), a: Number(r.agents || 0) },
  ]));

  return spec.buckets.map((b) => ({
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

// T-2026-053: dynamic per-status counters driven by the status_type
// master. Every ACTIVE row in master_status_types produces a byStatus[]
// entry (LEFT JOIN so statuses with zero rows still appear). Legacy
// scalar keys (available/sold/rented/onHold) are preserved for
// backward-compatibility with any existing consumer that still keys on
// them; new consumers should read byStatus[] instead.
async function inventoryCounters() {
  return dynamicStatusCounters('inventory_properties');
}

// T-2026-053: dynamic per-status counters mirroring inventoryCounters.
// Same shape as inventoryCounters — one function per table so future
// enquiry-only status columns (e.g. 'contacted') can diverge here
// without dragging inventory along.
async function enquiryCounters() {
  return dynamicStatusCounters('enquiry_properties');
}

// Shared helper: return a KPI payload driven entirely by the active
// rows of master_status_types. Callers pass the property table name
// (whitelisted below — the value is interpolated into SQL, so it must
// never come from user input).
//
// Returned shape:
//   {
//     total,                              // COUNT of live rows in the table
//     byStatus: [                         // one entry per ACTIVE master row,
//       { code, label, count, sortOrder } // in master sort_order asc, incl.
//     ],                                  // rows with zero occurrences.
//     available, sold, rented, onHold,    // legacy scalar shim so existing
//     status: { available: n, ... }       // consumers (frontend cards keyed
//   }                                     // on kpi.available etc.) keep
//                                         // rendering unchanged.
async function dynamicStatusCounters(table) {
  if (table !== 'inventory_properties' && table !== 'enquiry_properties') {
    throw new Error(`Unsupported table for dynamicStatusCounters: ${table}`);
  }

  // Total count first — a single scalar query, deterministic under load.
  const [[totRow]] = await pool.query(
    `SELECT COUNT(*) AS total FROM ${table} WHERE deleted_at IS NULL`,
  );

  // T-2026-080: Property Status master split — inventory keeps the legacy
  // dedicated `master_status_types` table, enquiry moves to the generic
  // `master_lookups` table filtered by master_key='enquiry_status'. The
  // status-code column on both property tables is unchanged; only the
  // master we join against changes per surface.
  //
  // Per-status counts: LEFT JOIN the appropriate master on code=status so
  // active statuses with zero occurrences still surface. is_active=1 and
  // deleted_at IS NULL on the master side ensures deactivated / soft-
  // deleted statuses drop out of the KPI strip while remaining
  // renderable in historical rows (label fallback is on the frontend).
  const isEnquiry = table === 'enquiry_properties';
  const masterFromClause = isEnquiry
    ? `master_lookups m`
    : `master_status_types m`;
  const masterWhereClause = isEnquiry
    ? `m.is_active = 1 AND m.deleted_at IS NULL AND m.master_key = 'enquiry_status'`
    : `m.is_active = 1 AND m.deleted_at IS NULL`;
  const [rows] = await pool.query(
    `SELECT m.code, m.label, m.sort_order AS sortOrder,
            COALESCE(t.cnt, 0) AS count
       FROM ${masterFromClause}
       LEFT JOIN (
         SELECT status, COUNT(*) AS cnt
           FROM ${table}
          WHERE deleted_at IS NULL AND status IS NOT NULL AND status != ''
          GROUP BY status
       ) t ON t.status = m.code
      WHERE ${masterWhereClause}
      ORDER BY m.sort_order ASC, m.code ASC`,
  );

  const byStatus = rows.map((r) => ({
    code: r.code,
    label: r.label,
    count: Number(r.count || 0),
    sortOrder: Number(r.sortOrder || 0),
  }));

  // Legacy scalar shim — keyed by the well-known status codes that
  // pre-T-2026-053 frontends read. Any code not present in the master
  // resolves to 0. New codes (e.g. 'sold_by_me') simply don't populate
  // legacy keys; they only appear via byStatus[].
  const byCode = Object.fromEntries(byStatus.map((s) => [s.code, s.count]));
  return {
    total: num(totRow.total),
    byStatus,
    available: byCode.available || 0,
    sold: byCode.sold || 0,
    rented: byCode.rented || 0,
    onHold: byCode.on_hold || 0,
    // Also expose a map for callers that prefer object access.
    status: byCode,
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
async function listingsByBucketSingle(table, { days = 30, granularity = 'daily', dateFrom = null, dateTo = null } = {}) {
  // Whitelist the table name — this string is interpolated into SQL below,
  // so an unexpected value would be a SQL injection. All callers pass a
  // literal ('website_properties' | 'inventory_properties' |
  // 'enquiry_properties'); the guard is defense in depth against a future
  // caller passing user input.
  if (table !== 'website_properties' && table !== 'inventory_properties' && table !== 'enquiry_properties') {
    throw new Error(`Unsupported table for listingsByBucketSingle: ${table}`);
  }

  const spec = makeBucketSpec({ days, granularity, dateFrom, dateTo });

  const [rows] = await pool.query(
    `SELECT ${spec.bucketSql} AS bucket, COUNT(*) AS count
     FROM ${table}
     WHERE deleted_at IS NULL AND created_at >= ? AND created_at < ?
     GROUP BY bucket
     ORDER BY bucket ASC`,
    spec.bounds,
  );

  const map = Object.fromEntries(rows.map((r) => [String(r.bucket), Number(r.count)]));
  return spec.buckets.map((b) => ({ bucket: b, count: map[b] || 0 }));
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
  dynamicStatusCounters,
};
