/**
 * Shared property_code namespace.
 *
 * THREE live tables issue codes in the SAME format (DDD-TTT-YY-RANDOM7) and
 * therefore share one logical identifier space:
 *
 *   inventory_properties
 *   enquiry_properties
 *   website_properties
 *
 * Each has its own UNIQUE index on property_code, but a UNIQUE index is
 * per-table -- nothing stopped the SAME code being minted in two of them.
 * That matters because the code is used as a cross-system business
 * identifier: an operator reading "AKL-BNG-26-0XCQYR5" must be able to
 * resolve it to exactly one property, and CRM lead allocation resolves
 * properties by identifier rather than by row id (row ids collide freely --
 * inventory #19 and enquiry #19 are unrelated properties).
 *
 * services/properties/propertyCode.js#assignUniqueCode consults this before
 * handing a candidate code to its caller, making the namespace globally
 * unique in practice. The per-table UNIQUE indexes remain the final
 * same-table race backstop.
 *
 * DELIBERATELY EXCLUDED: inventory_properties_pre_split_20260713_085506.
 * That is a dead pre-migration snapshot, not a live registry -- a code that
 * survives only there is free to reissue.
 */

const { pool } = require('../pool');

// Soft-deleted rows still occupy the code: their UNIQUE index entry is not
// released by setting deleted_at, and the code remains the historical
// identifier of that property (CRM allocations and audit rows still cite
// it). So the check intentionally does NOT filter on deleted_at.
const CODE_TABLES = Object.freeze([
  'inventory_properties',
  'enquiry_properties',
  'website_properties',
]);

// Maps each table to the `source` discriminator the rest of the system uses.
// The frontend turns this into a route: inventory -> /admin/inventory/:id,
// enquiry -> /admin/enquiry/:id, website -> the website-property page. Keeping
// the mapping here means the route decision is driven by where the code
// actually lives, never by a caller's assumption.
//
// All three tables happen to expose the same descriptive columns
// (id, property_code, title, property_type, location, deleted_at), which is
// what makes a single UNION resolver possible. NOTE website_properties has NO
// `status` column, so status is deliberately not part of the projection.
const SOURCE_BY_TABLE = Object.freeze({
  inventory_properties: 'inventory',
  enquiry_properties:   'enquiry',
  website_properties:   'website',
});

/**
 * True when `code` is already taken in ANY of the property tables.
 *
 * Table names are a hardcoded allowlist above, never caller input, so the
 * interpolation below cannot carry injection. The code value itself is
 * bound as a parameter.
 *
 * @param {string} code
 * @returns {Promise<boolean>}
 */
async function codeExistsAnywhere(code) {
  const value = String(code || '').trim();
  if (!value) return false;
  const union = CODE_TABLES
    .map((t) => `SELECT 1 FROM ${t} WHERE property_code = ?`)
    .join(' UNION ALL ');
  const [rows] = await pool.query(`${union} LIMIT 1`, CODE_TABLES.map(() => value));
  return rows.length > 0;
}

/**
 * Which table(s) currently hold a given code. Diagnostic helper -- returns
 * [] when the code is free. Useful when auditing the namespace or debugging
 * a "why does this identifier resolve to two properties" report.
 *
 * @param {string} code
 * @returns {Promise<Array<{ table: string, id: number }>>}
 */
async function findCodeOwners(code) {
  const value = String(code || '').trim();
  if (!value) return [];
  const out = [];
  for (const table of CODE_TABLES) {
    // eslint-disable-next-line no-await-in-loop
    const [rows] = await pool.query(
      `SELECT id FROM ${table} WHERE property_code = ?`,
      [value],
    );
    for (const r of rows) out.push({ table, id: r.id });
  }
  return out;
}

/**
 * Resolve property CODES to the property each one names, across all three
 * tables. This is the lookup that lets CRM lead allocation store a code
 * instead of a row id: the code says WHICH property, and the resolved
 * `source` says which surface owns it, so a chip can deep-link correctly.
 *
 * Why this can be a single UNION: a code is globally unique across the three
 * tables (assignUniqueCode enforces it), so each code resolves to exactly one
 * row. The `found > 1` guard below is a tripwire for the day that stops being
 * true, not an expected branch.
 *
 * SOFT-DELETED ROWS ARE INCLUDED, flagged via `deleted`. This is the whole
 * point of keying on the code rather than the id: a deleted property can
 * still be NAMED. The old id-based column could only render a bare
 * "Property unavailable" because a dead id carries no information; a dead
 * code still tells the operator exactly which property the lead wanted.
 * Callers decide how to present `deleted: true`.
 *
 * @param {string[]} codes
 * @returns {Promise<Record<string, {
 *   code: string, source: 'inventory'|'enquiry'|'website', id: number,
 *   title: string|null, property_type: string|null, location: string|null,
 *   deleted: boolean }>>}
 *   Keyed by code. Codes that resolve nowhere are OMITTED, so callers can
 *   distinguish "unknown code" from "known but deleted".
 */
async function resolvePropertyCodes(codes) {
  const clean = Array.from(new Set(
    (Array.isArray(codes) ? codes : [])
      .map((c) => String(c || '').trim())
      .filter(Boolean),
  ));
  if (!clean.length) return {};

  const placeholders = clean.map(() => '?').join(',');
  // Table names come from the hardcoded CODE_TABLES allowlist, never caller
  // input; the codes themselves are bound parameters.
  const union = CODE_TABLES.map((t) => `
    SELECT '${SOURCE_BY_TABLE[t]}' AS source, id, property_code, title,
           property_type, location, deleted_at
      FROM ${t}
     WHERE property_code IN (${placeholders})`).join(' UNION ALL ');

  const params = [];
  for (let i = 0; i < CODE_TABLES.length; i += 1) params.push(...clean);
  const [rows] = await pool.query(union, params);

  const out = {};
  for (const r of rows) {
    if (out[r.property_code]) {
      // Two tables claim the same code. assignUniqueCode is supposed to make
      // this impossible; log loudly rather than silently pick a winner,
      // because picking wrong sends the operator to the wrong property.
      // eslint-disable-next-line no-console
      console.error('[property_codes] DUPLICATE CODE ACROSS TABLES', {
        code: r.property_code, first: out[r.property_code].source, second: r.source,
      });
      continue;
    }
    out[r.property_code] = {
      code: r.property_code,
      source: r.source,
      id: Number(r.id),
      title: r.title || null,
      property_type: r.property_type || null,
      location: r.location || null,
      deleted: Boolean(r.deleted_at),
    };
  }
  return out;
}

/** Single-code convenience wrapper. Returns null when the code resolves nowhere. */
async function resolvePropertyCode(code) {
  const map = await resolvePropertyCodes([code]);
  return map[String(code || '').trim()] || null;
}

module.exports = {
  CODE_TABLES,
  SOURCE_BY_TABLE,
  codeExistsAnywhere,
  findCodeOwners,
  resolvePropertyCodes,
  resolvePropertyCode,
};
