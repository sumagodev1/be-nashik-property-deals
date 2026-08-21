// Agreement Reminders — dedicated admin surface (T-2026-112, refined T-2026-113).
//
// Endpoints (all under /admin/agreement-reminders, mounted from
// routes/admin/index.js):
//
//   GET /admin/agreement-reminders/summary
//     → { totalActive, expiringWithin30, expiringWithin7, expiringToday,
//         totalOverdue, badgeCount }
//     Feeds the topbar bell chip and (previously) the Inventory
//     Dashboard summary widget. Cheap COUNT-only query. Retained
//     after T-2026-113 because /badge-count also uses this fetcher.
//
//   GET /admin/agreement-reminders/list
//     ?page&pageSize&search&endDateFrom&endDateTo
//     (T-2026-127: FE now sends only these 5 params. The route still
//      accepts the legacy propertyType/transactionType/district/taluka/
//      shivar/status/remainingMin/remainingMax/sort params for backward
//      compatibility — sort defaults to agreementEndDate:asc.)
//     → { data: [ { source: 'inventory'|'enquiry', id, propertyCode,
//         title, propertyType, propertyTypeLabel, transactionType,
//         transactionTypeLabel, transactionVariant, transactionVariantLabel,
//         propertyVariety, propertyVarietyLabel,
//         district, districtLabel, taluka, talukaLabel, shivar, shivarLabel,
//         agreementStartDate, agreementEndDate,
//         daysRemaining, daysOverdue, statusCode, statusLabel, displayLabel } ],
//         page, pageSize, total }
//     Merges inventory + enquiry records into one virtual list. Filters
//     applied at the SQL layer where possible (property_type,
//     transaction_variant, district, taluka, shivar, end-date range)
//     and at the JS layer for the derived-status filters (statusCode,
//     remaining-days range) because those are computed per-row from
//     `today - agreement_end_date`.
//
//   Only rent_out / lease_out records with a non-NULL agreement_end_date
//   are considered. Draft records are INCLUDED (a half-filled Rent Out
//   form still deserves a reminder if it has an end date).
//
// T-2026-113 changes (parity with FE list simplification):
//   • Query params REMOVED: source, ownerName, tenantName.
//   • Response fields REMOVED: ownerName, ownerContact, tenantName,
//     description. `source` is RETAINED because the FE row actions
//     use it to route between /admin/inventory/:id and
//     /admin/enquiry/:id (not a display column, but a functional
//     discriminator).
//   • Helper REMOVED: extractTenantName + all JSON walks over
//     contacts[]. The reminder list no longer parses the details JSON
//     blob per row, which is a measurable perf win on large pages.
//   • Search LIKE bag trimmed: no longer includes owner_name (Owner
//     surface is gone). Still searches property_code, title, shivar,
//     agreement_end_date.
//   • Sort key `ownerName` removed (Owner column + filter gone).
//   • SELECT column list trimmed to omit description / owner_name /
//     owner_contact / details.
//
// Design notes:
//   • Backend re-derivation on every request. No caching.
//   • Two-table UNION with fixed column projection so the ORDER BY can
//     sort on the merged result without duplicating logic per table.
//   • No new columns beyond those added in migration 096. Existing
//     owner_name / owner_contact / details columns on inventory_properties
//     and enquiry_properties are preserved in the DB (still used by
//     other endpoints) — we just stop SELECTing them here.
//   • Location labels (District/Taluka/Village) come from the master
//     rows because property_type/district/taluka/shivar are stored as
//     master CODES. The list returns BOTH the code and the human label
//     so the FE table can filter by code but display the label.

const express = require('express');
const Joi = require('joi');
const { pool } = require('../../db/pool');
const { validate } = require('../../middleware/validate');
const { requireAuth, requireModule, requireModuleWriteOnMutation } = require('../../middleware/auth');
const { MODULES } = require('../../constants/modules');
const {
  computeAgreementState,
  STATUS,
} = require('../../services/agreement/agreementCompute');

const router = express.Router();

// T-2026-174: the Agreement Reminder page shows both Inventory and
// Enquiry rows and is now gated on the discrete AGREEMENT_REMINDERS
// module (formerly bundled under INVENTORY_MANAGEMENT). Sub-admins are
// grantable independently of Inventory/Enquiry Properties. Backward-
// compat: migration 111 fans out pre-T-174 INVENTORY_MANAGEMENT grants
// into 5 discrete rows including AGREEMENT_REMINDERS; hasGrant() also
// honours a legacy 'inventory_management' JWT entry as an implicit
// grant on AGREEMENT_REMINDERS. Admin bypasses.
router.use(requireAuth, requireModule(MODULES.AGREEMENT_REMINDERS));
// Sub-admins with only Read access on AGREEMENT_REMINDERS get 403 on
// POST/PUT/PATCH/DELETE while GET/HEAD/OPTIONS pass through.
router.use(requireModuleWriteOnMutation(MODULES.AGREEMENT_REMINDERS));

const masterCodeField = Joi.string().trim().lowercase().pattern(/^[a-z0-9][a-z0-9_-]{0,62}[a-z0-9]$/);

// ---- helpers ------------------------------------------------------------

// The two rent/lease "out" variants — the only ones an agreement window
// applies to. Enumerated explicitly so a config drift in the FE cannot
// accidentally surface a Sale / Purchase / Rent In / Lease In record.
const OUT_VARIANTS = ['rent_out', 'lease_out'];

// Format helper — echoes management.js#formatIsoDate but re-declared here
// to keep this module self-contained.
function formatIsoDate(d) {
  if (!d) return null;
  if (d instanceof Date) {
    if (Number.isNaN(d.getTime())) return null;
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  if (typeof d === 'string') {
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(d.trim());
    return m ? m[1] : null;
  }
  return null;
}

// T-2026-113: extractTenantName helper removed. The reminder list no
// longer surfaces Tenant, so parsing details JSON per row is dead code.
// The polymorphic contacts[*].relation semantics remain in force on
// the Inventory + Enquiry view/edit surfaces — this pruning only
// affects the reminder-list projection.

// Resolve a set of master codes to their labels via master_lookups /
// master_property_types / master_transaction_types. Returns a Map
// keyed by `<masterKey>:<code>`. Batched to avoid N+1.
async function resolveMasterLabels(entries) {
  // entries: array of { masterKey, code }
  if (!entries || entries.length === 0) return new Map();
  // Dedupe.
  const uniq = new Map();
  for (const e of entries) {
    if (!e || !e.code) continue;
    uniq.set(`${e.masterKey}:${e.code}`, { masterKey: e.masterKey, code: e.code });
  }
  const out = new Map();
  // Query master_lookups in one shot for district / taluka / shivar /
  // property_variety. T-2026-127: property_variety labels also live in
  // master_lookups (master_key='property_variety'), keyed by the variety
  // CODE which equals the row's transaction_variant — matching the
  // existing resolution pattern in db/queries/inventory_properties.js
  // (mpv_code.code = ip.transaction_variant).
  const lookupEntries = [...uniq.values()].filter((e) => e.masterKey === 'district' || e.masterKey === 'taluka' || e.masterKey === 'shivar' || e.masterKey === 'property_variety');
  if (lookupEntries.length > 0) {
    const placeholders = lookupEntries.map(() => '(?, ?)').join(', ');
    const params = [];
    for (const e of lookupEntries) { params.push(e.masterKey, e.code); }
    const [rows] = await pool.query(
      `SELECT master_key, code, label FROM master_lookups
        WHERE (master_key, code) IN (${placeholders})
          AND deleted_at IS NULL`,
      params,
    );
    for (const r of rows) out.set(`${r.master_key}:${r.code}`, r.label);
  }
  const ptCodes = [...uniq.values()].filter((e) => e.masterKey === 'property_type').map((e) => e.code);
  if (ptCodes.length > 0) {
    const [rows] = await pool.query(
      `SELECT code, label FROM master_property_types
        WHERE code IN (?) AND deleted_at IS NULL`,
      [ptCodes],
    );
    for (const r of rows) out.set(`property_type:${r.code}`, r.label);
  }
  const ttCodes = [...uniq.values()].filter((e) => e.masterKey === 'transaction_type').map((e) => e.code);
  if (ttCodes.length > 0) {
    const [rows] = await pool.query(
      `SELECT code, label FROM master_transaction_types
        WHERE code IN (?) AND deleted_at IS NULL`,
      [ttCodes],
    );
    for (const r of rows) out.set(`transaction_type:${r.code}`, r.label);
  }
  return out;
}

// ---- summary ------------------------------------------------------------

// Uses a single fetch-then-group query on the union of both tables.
// A COUNT is much cheaper than fetching every row and computing per-row
// state on the JS side. All counts share the same "today = today"
// reference so the numbers line up with the list.
async function fetchSummary() {
  const [invRows] = await pool.query(
    `SELECT agreement_end_date
       FROM inventory_properties
      WHERE deleted_at IS NULL
        AND (transaction_variant IN (?) OR transaction_type IN (?))
        AND agreement_end_date IS NOT NULL`,
    [OUT_VARIANTS, OUT_VARIANTS],
  );
  const [enqRows] = await pool.query(
    `SELECT agreement_end_date
       FROM enquiry_properties
      WHERE deleted_at IS NULL
        AND (transaction_variant IN (?) OR transaction_type IN (?))
        AND agreement_end_date IS NOT NULL`,
    [OUT_VARIANTS, OUT_VARIANTS],
  );
  const rows = [...invRows, ...enqRows];
  const summary = {
    totalActive: 0,
    expiringWithin30: 0,
    expiringWithin7: 0,
    expiringToday: 0,
    totalOverdue: 0,
    badgeCount: 0,
  };
  for (const r of rows) {
    const s = computeAgreementState(r.agreement_end_date);
    if (s.statusCode === STATUS.ACTIVE) summary.totalActive += 1;
    if (s.daysRemaining !== null && s.daysRemaining >= 0 && s.daysRemaining <= 30) summary.expiringWithin30 += 1;
    if (s.daysRemaining !== null && s.daysRemaining >= 0 && s.daysRemaining <= 7) summary.expiringWithin7 += 1;
    if (s.statusCode === STATUS.EXPIRES_TODAY) summary.expiringToday += 1;
    if (s.statusCode === STATUS.OVERDUE) summary.totalOverdue += 1;
    if (s.badgeCountable) summary.badgeCount += 1;
  }
  return summary;
}

router.get('/summary', async (req, res, next) => {
  try {
    res.json(await fetchSummary());
  } catch (err) {
    next(err);
  }
});

// ---- badge count (lightweight; identical semantics to summary.badgeCount) ----

router.get('/badge-count', async (req, res, next) => {
  try {
    const s = await fetchSummary();
    res.json({ count: s.badgeCount });
  } catch (err) {
    next(err);
  }
});

// ---- list ---------------------------------------------------------------

// T-2026-113: source / ownerName / tenantName query params removed.
// Also removed `ownerName` from the sort enumeration (Owner column
// no longer exists on the FE table).
const listQuery = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(100).default(20),
  search: Joi.string().trim().max(255).allow('').optional(),
  propertyType: masterCodeField.allow('').optional(),
  transactionType: Joi.string().trim().valid('', 'rent_out', 'lease_out').optional(),
  // Property Variety is stored in `transaction_variant` (code: resale / new /
  // …) with `property_variety_name` carrying the label. The other five
  // filters were already accepted here; only this one was missing.
  propertyVariety: masterCodeField.allow('').optional(),
  district: masterCodeField.allow('').optional(),
  taluka: masterCodeField.allow('').optional(),
  shivar: masterCodeField.allow('').optional(),
  status: Joi.string().trim().valid('',
    STATUS.ACTIVE, STATUS.REMINDER_STARTED, STATUS.UPCOMING_EXPIRY,
    STATUS.EXPIRING_SOON, STATUS.EXPIRES_TODAY, STATUS.OVERDUE,
  ).optional(),
  remainingMin: Joi.number().integer().optional(),
  remainingMax: Joi.number().integer().optional(),
  endDateFrom: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endDateTo: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
  sort: Joi.string()
    .pattern(/^(agreementEndDate|daysRemaining|propertyCode|title):(asc|desc)$/)
    .default('agreementEndDate:asc'),
});

async function fetchListRows(filters) {
  const {
    propertyType, transactionType, propertyVariety, district, taluka, shivar,
    endDateFrom, endDateTo, search,
  } = filters;

  // Build a per-table WHERE fragment. SQL-level filters apply where the
  // column exists directly; derived filters (status / remainingRange)
  // run in JS post-fetch.
  function buildQuery(alias, table) {
    // Historical data: some records stored rent_out/lease_out in the
    // `transaction_type` column, others in `transaction_variant`. Check
    // both so the reminder list catches every OUT record regardless of
    // which shape was persisted at save time.
    const where = [
      `${alias}.deleted_at IS NULL`,
      `(${alias}.transaction_variant IN (?) OR ${alias}.transaction_type IN (?))`,
      `${alias}.agreement_end_date IS NOT NULL`,
    ];
    const params = [OUT_VARIANTS, OUT_VARIANTS];
    if (propertyType) { where.push(`${alias}.property_type = ?`); params.push(propertyType); }
    if (transactionType) {
      // Match against BOTH columns for the same reason as the base
      // OUT_VARIANTS filter above.
      where.push(`(${alias}.transaction_variant = ? OR ${alias}.transaction_type = ?)`);
      params.push(transactionType, transactionType);
    }
    if (propertyVariety) {
      // Match the stored code or the denormalised label, so the filter works
      // whether the row was written with one or the other.
      where.push(`(${alias}.transaction_variant = ? OR ${alias}.property_variety_name = ?)`);
      params.push(propertyVariety, propertyVariety);
    }
    if (district) { where.push(`${alias}.district = ?`); params.push(district); }
    if (taluka)   { where.push(`${alias}.taluka = ?`);   params.push(taluka); }
    if (shivar)   { where.push(`${alias}.shivar = ?`);   params.push(shivar); }
    if (endDateFrom) { where.push(`${alias}.agreement_end_date >= ?`); params.push(endDateFrom); }
    if (endDateTo)   { where.push(`${alias}.agreement_end_date <= ?`); params.push(endDateTo); }
    if (search) {
      // T-2026-127: Global Search LIKE bag broadened. The single Search
      // field now spans Property ID, Title, Property Type (code + label),
      // Property Variety (transaction_variant code + property_variety_name
      // label), Transaction (transaction_type + transaction_variant),
      // District, Taluka, Village/City (shivar), Owner (owner_name), and
      // best-effort Tenant via the details JSON.
      //
      // That last one uses JSON_SEARCH rather than CAST(details AS CHAR) LIKE.
      // The CAST matched the raw JSON text, which includes the KEY names — so
      // searching "land" returned every Shop, Flat and Rowhouse carrying a
      // `landmark` key, and the operator saw results with no visible "land"
      // anywhere. JSON_SEARCH matches string VALUES only, never keys. On the
      // dev data the same term went from 9 rows (7 of them false) to the 2
      // that genuinely are Land properties.
      //
      // JSON_VALID guards it: JSON_SEARCH raises an error on malformed JSON,
      // and a few legacy rows still hold non-JSON text in `details`. Those
      // rows simply do not match this branch; the real columns still apply.
      // Every referenced column
      // exists on BOTH inventory_properties and enquiry_properties (verified),
      // so the same branch is emitted for both tables.
      const s = `%${search}%`;
      where.push(`(
        ${alias}.property_code LIKE ?
        OR ${alias}.title LIKE ?
        OR ${alias}.property_type LIKE ?
        OR ${alias}.property_type_name LIKE ?
        OR ${alias}.transaction_variant LIKE ?
        OR ${alias}.property_variety_name LIKE ?
        OR ${alias}.transaction_type LIKE ?
        OR ${alias}.district LIKE ?
        OR ${alias}.taluka LIKE ?
        OR ${alias}.shivar LIKE ?
        OR ${alias}.owner_name LIKE ?
        OR (JSON_VALID(${alias}.details) AND JSON_SEARCH(${alias}.details, 'one', ?) IS NOT NULL)
        OR CAST(${alias}.agreement_end_date AS CHAR) LIKE ?
      )`);
      params.push(s, s, s, s, s, s, s, s, s, s, s, s, s);
    }
    // T-2026-113: SELECT list trimmed — no longer projects description,
    // owner_name, owner_contact, or details. Those columns remain in
    // the DB and are populated / read by other endpoints, but the
    // reminder list no longer surfaces them.
    const sql = `
      SELECT ${alias}.id, ${alias}.property_code, ${alias}.title,
             ${alias}.property_type, ${alias}.property_type_id, ${alias}.property_type_name,
             ${alias}.transaction_type, ${alias}.transaction_variant,
             ${alias}.property_variety_id, ${alias}.property_variety_name,
             ${alias}.district, ${alias}.taluka, ${alias}.shivar,
             ${alias}.agreement_start_date, ${alias}.agreement_end_date,
             ${alias}.created_at
        FROM ${table} ${alias}
       WHERE ${where.join(' AND ')}`;
    return { sql, params };
  }

  // T-2026-113: `source` filter removed — the FE no longer offers a
  // Source dropdown, so both tables are always merged. Simpler control
  // flow than the previous per-source short-circuit.
  const [[invRows], [enqRows]] = await Promise.all([
    (async () => {
      const { sql, params } = buildQuery('ip', 'inventory_properties');
      return pool.query(sql, params);
    })(),
    (async () => {
      const { sql, params } = buildQuery('ep', 'enquiry_properties');
      return pool.query(sql, params);
    })(),
  ]);

  const inventory = invRows.map((r) => ({ ...r, __source: 'inventory' }));
  const enquiry   = enqRows.map((r) => ({ ...r, __source: 'enquiry' }));
  return [...inventory, ...enquiry];
}

router.get('/list', validate(listQuery, 'query'), async (req, res, next) => {
  try {
    const filters = req.query;
    const rows = await fetchListRows(filters);

    // Enrich each row with agreement state so status + display strings
    // are computed on the server (spec requirement).
    const enriched = rows.map((r) => {
      const state = computeAgreementState(r.agreement_end_date);
      return { row: r, state };
    });

    // JS-side derived filters.
    const {
      status: statusFilter,
      remainingMin,
      remainingMax,
    } = filters;
    const afterDerivedFilter = enriched.filter(({ state }) => {
      if (statusFilter && state.statusCode !== statusFilter) return false;
      if (typeof remainingMin === 'number' && (state.daysRemaining === null || state.daysRemaining < remainingMin)) return false;
      if (typeof remainingMax === 'number' && (state.daysRemaining === null || state.daysRemaining > remainingMax)) return false;
      return true;
    });

    // Sort.
    // T-2026-113: ownerName removed from the sort switch (matches the
    // trimmed sort enumeration in listQuery).
    const [sortField, sortDir] = String(filters.sort || 'agreementEndDate:asc').split(':');
    const dirMul = sortDir === 'desc' ? -1 : 1;
    afterDerivedFilter.sort((a, b) => {
      const getKey = (r, s) => {
        switch (sortField) {
          case 'daysRemaining':     return s.daysRemaining ?? 999999;
          case 'propertyCode':      return r.property_code || '';
          case 'title':             return r.title || '';
          case 'agreementEndDate':
          default:                  return r.agreement_end_date || '';
        }
      };
      const ka = getKey(a.row, a.state);
      const kb = getKey(b.row, b.state);
      if (ka < kb) return -1 * dirMul;
      if (ka > kb) return 1 * dirMul;
      return 0;
    });

    const total = afterDerivedFilter.length;
    const page = filters.page || 1;
    const pageSize = filters.pageSize || 20;
    const paged = afterDerivedFilter.slice((page - 1) * pageSize, page * pageSize);

    // Resolve master labels in one batch for the paged set.
    const entries = [];
    for (const { row: r } of paged) {
      if (r.property_type) entries.push({ masterKey: 'property_type', code: r.property_type });
      if (r.transaction_type) entries.push({ masterKey: 'transaction_type', code: r.transaction_type });
      if (r.transaction_variant) entries.push({ masterKey: 'property_variety', code: r.transaction_variant });
      if (r.district) entries.push({ masterKey: 'district', code: r.district });
      if (r.taluka)   entries.push({ masterKey: 'taluka', code: r.taluka });
      if (r.shivar)   entries.push({ masterKey: 'shivar', code: r.shivar });
    }
    const labels = await resolveMasterLabels(entries);

    // T-2026-113: response payload trimmed — no more tenantName /
    // ownerName / ownerContact / description. `source` is retained
    // because the FE row actions still route on it (inventory vs
    // enquiry detail pages).
    const data = paged.map(({ row: r, state }) => ({
      source: r.__source,
      id: r.id,
      propertyCode: r.property_code,
      title: r.title,
      propertyType: r.property_type,
      propertyTypeLabel: r.property_type_name
        || labels.get(`property_type:${r.property_type}`)
        || r.property_type,
      transactionType: r.transaction_type,
      transactionTypeLabel: labels.get(`transaction_type:${r.transaction_type}`) || r.transaction_type,
      transactionVariant: r.transaction_variant,
      // T-2026-127: Property Variety (New / Resale / …). Code is the
      // transaction_variant; the human label is resolved server-side
      // preferring the stored property_variety_name, else the master
      // label matched on the variety code, else the raw code — the same
      // COALESCE precedence used by inventory/enquiry list queries.
      propertyVariety: r.transaction_variant,
      propertyVarietyLabel: r.property_variety_name
        || labels.get(`property_variety:${r.transaction_variant}`)
        || r.transaction_variant,
      // The "Rent Out / Lease Out" label lives in EITHER column depending
      // on how the record was persisted (transaction_type or
      // transaction_variant). Check transaction_type first because when
      // it's already 'rent_out'/'lease_out' the variant is typically
      // 'resale' / 'new_...' — a variant that isn't itself the
      // out-classifier. Falls back to a raw echo when neither matches.
      transactionVariantLabel: (() => {
        if (r.transaction_type === 'rent_out')  return 'Rent Out';
        if (r.transaction_type === 'lease_out') return 'Lease Out';
        if (r.transaction_variant === 'rent_out')  return 'Rent Out';
        if (r.transaction_variant === 'lease_out') return 'Lease Out';
        return r.transaction_variant || r.transaction_type || '';
      })(),
      district: r.district,
      districtLabel: labels.get(`district:${r.district}`) || r.district,
      taluka: r.taluka,
      talukaLabel: labels.get(`taluka:${r.taluka}`) || r.taluka,
      shivar: r.shivar,
      shivarLabel: labels.get(`shivar:${r.shivar}`) || r.shivar,
      agreementStartDate: formatIsoDate(r.agreement_start_date),
      agreementEndDate: formatIsoDate(r.agreement_end_date),
      daysRemaining: state.daysRemaining,
      daysOverdue: state.daysOverdue,
      statusCode: state.statusCode,
      statusLabel: state.statusLabel,
      displayLabel: state.displayLabel,
      badgeCountable: state.badgeCountable,
    }));

    res.json({ data, page, pageSize, total });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
