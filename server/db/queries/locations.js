/**
 * Read-only queries for the district → taluka → shivar cascade.
 *
 * All three tiers live in the shared `master_lookups` table (see migration
 * 026 + 049): rows carry `master_key` in ('district'|'taluka'|'shivar'),
 * `code` = government code, `parent_code` = parent govt code, and (for
 * districts) `state_code`/`state_name`, (for villages) `pincode`.
 *
 * This module is separate from db/queries/masters.js because the cascade
 * needs a wider projection (state_code/state_name/pincode) and an
 * always-alphabetical, active-only, hard-paginated read pattern that
 * doesn't fit the generic masters CRUD queries — 45k+ village rows will
 * blow up the "load everything into memory" pattern used elsewhere.
 */

const { pool } = require('../pool');

const KEYS = Object.freeze({
  DISTRICT: 'district',
  TALUKA:   'taluka',
  SHIVAR:   'shivar',
});

// Districts: alphabetical, no parent, small (35 rows for Maharashtra) — the
// entire active list is safe to return in one shot.
async function listDistricts() {
  const [rows] = await pool.query(
    `SELECT id, code, label, state_code, state_name
       FROM master_lookups
      WHERE master_key = ?
        AND is_active = 1
        AND deleted_at IS NULL
      ORDER BY label ASC, id ASC`,
    [KEYS.DISTRICT],
  );
  return rows;
}

// Talukas under a district. Bounded (typically 5–15 rows), safe to return
// as a full list.
async function listTalukasByDistrict(districtCode) {
  const [rows] = await pool.query(
    `SELECT id, code, label, parent_code
       FROM master_lookups
      WHERE master_key = ?
        AND parent_code = ?
        AND is_active = 1
        AND deleted_at IS NULL
      ORDER BY label ASC, id ASC`,
    [KEYS.TALUKA, districtCode],
  );
  return rows;
}

// Villages under a taluka — returns EVERY village for the taluka, no
// pagination. A single taluka is bounded (the largest urban talukas in
// Maharashtra top out under ~500 rows, most are 50-200), and the composite
// index (master_key, parent_code, label) makes this an index-range scan
// regardless of the state-wide 45k total. The user reported "Showing 100
// of 125 villages" for Trimbakeshwar — that was our old page-size cap,
// removed here. Search still filters server-side but does not truncate.
async function listVillagesByTaluka(talukaCode, { search = '' } = {}) {
  const where = [
    'master_key = ?',
    'parent_code = ?',
    'is_active = 1',
    'deleted_at IS NULL',
  ];
  const params = [KEYS.SHIVAR, talukaCode];
  if (search) {
    // Prefix match on the label — the composite index
    // (master_key, parent_code, label) makes this an index-range scan.
    where.push('label LIKE ?');
    params.push(`${search.replace(/[%_]/g, (m) => `\\${m}`)}%`);
  }
  const whereSql = `WHERE ${where.join(' AND ')}`;
  const [rows] = await pool.query(
    `SELECT id, code, label, parent_code, pincode
       FROM master_lookups
       ${whereSql}
       ORDER BY label ASC, id ASC`,
    params,
  );
  return { rows, total: rows.length };
}

// Reverse lookup: pincode → villages (up to 25 rows). Handy for the seller
// property form's "just type a pincode" affordance.
async function findVillagesByPincode(pincode) {
  const [rows] = await pool.query(
    `SELECT ml.id, ml.code, ml.label, ml.parent_code AS taluka_code, ml.pincode,
            t.label AS taluka_label,
            d.label AS district_label, d.code AS district_code
       FROM master_lookups ml
       LEFT JOIN master_lookups t
              ON t.master_key = ?
             AND t.code = ml.parent_code
             AND t.deleted_at IS NULL
       LEFT JOIN master_lookups d
              ON d.master_key = ?
             AND d.code = t.parent_code
             AND d.deleted_at IS NULL
      WHERE ml.master_key = ?
        AND ml.pincode = ?
        AND ml.is_active = 1
        AND ml.deleted_at IS NULL
      ORDER BY ml.label ASC
      LIMIT 25`,
    [KEYS.TALUKA, KEYS.DISTRICT, KEYS.SHIVAR, pincode],
  );
  return rows;
}

// Resolve a set of ids or codes to their labels + parent chain, for the
// read-side of forms (edit view) that needs to render a village's taluka
// + district context without three round-trips.
async function resolveVillageContext(villageCode) {
  const [rows] = await pool.query(
    `SELECT v.id AS village_id, v.code AS village_code, v.label AS village_label, v.pincode,
            t.id AS taluka_id, t.code AS taluka_code, t.label AS taluka_label,
            d.id AS district_id, d.code AS district_code, d.label AS district_label,
            d.state_code, d.state_name
       FROM master_lookups v
       LEFT JOIN master_lookups t
              ON t.master_key = ?
             AND t.code = v.parent_code
             AND t.deleted_at IS NULL
       LEFT JOIN master_lookups d
              ON d.master_key = ?
             AND d.code = t.parent_code
             AND d.deleted_at IS NULL
      WHERE v.master_key = ?
        AND v.code = ?
        AND v.deleted_at IS NULL
      LIMIT 1`,
    [KEYS.TALUKA, KEYS.DISTRICT, KEYS.SHIVAR, villageCode],
  );
  return rows[0] || null;
}

// Resolve a taluka code → its own row + parent district in a single query.
// Used by the LocationCascade's Edit-mode backfill when a saved record
// carries only a talukaCode (no districtCode, no villageCode) — without
// this the component would have to list one village under the taluka then
// call resolveVillageContext, a two-hop path we can collapse to one.
async function resolveTalukaContext(talukaCode) {
  const [rows] = await pool.query(
    `SELECT t.id AS taluka_id, t.code AS taluka_code, t.label AS taluka_label,
            d.id AS district_id, d.code AS district_code, d.label AS district_label,
            d.state_code, d.state_name
       FROM master_lookups t
       LEFT JOIN master_lookups d
              ON d.master_key = ?
             AND d.code = t.parent_code
             AND d.deleted_at IS NULL
      WHERE t.master_key = ?
        AND t.code = ?
        AND t.deleted_at IS NULL
      LIMIT 1`,
    [KEYS.DISTRICT, KEYS.TALUKA, talukaCode],
  );
  return rows[0] || null;
}

// Bulk code → label resolver. Used by the list-view pages (Business
// Associates, Land Records) to render human-readable district / taluka /
// village names in the table cells without having to preload the whole
// vocabulary (45k+ villages statewide). The route hands the caller-supplied
// code list straight to a single indexed query with an IN clause.
async function labelsForCodes(masterKey, codes) {
  if (!Array.isArray(codes) || codes.length === 0) return [];
  // Cap the batch size so a stray "?codes=" with thousands of ids doesn't
  // blow up the SQL layer. Callers usually need under 100 for a list view.
  const capped = codes.slice(0, 500).map((c) => String(c));
  const placeholders = capped.map(() => '?').join(', ');
  const [rows] = await pool.query(
    `SELECT code, label
       FROM master_lookups
      WHERE master_key = ?
        AND deleted_at IS NULL
        AND code IN (${placeholders})`,
    [masterKey, ...capped],
  );
  return rows;
}

module.exports = {
  KEYS,
  listDistricts,
  listTalukasByDistrict,
  listVillagesByTaluka,
  findVillagesByPincode,
  resolveVillageContext,
  resolveTalukaContext,
  labelsForCodes,
};
