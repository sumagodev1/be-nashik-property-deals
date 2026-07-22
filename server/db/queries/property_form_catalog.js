// T-2026-058 (Fix E): read layer for the `master_property_forms` table
// introduced by migration 063. Two public entry points:
//
//   listByMode(mode)                — returns every active form row for
//                                     the given surface ('inventory' | 'enquiry').
//                                     Ordered by (property_type sort_order,
//                                     transaction_type sort_order,
//                                     property_variety sort_order, form
//                                     sort_order) so the FE renders the
//                                     same order the admin sees in Masters.
//
//   findFormCode(mode, pt, tt, pv)  — resolves a single form_code from the
//                                     canonical trio. Used by the save
//                                     validators so both surfaces read the
//                                     dependency from the SAME table the
//                                     admin CRUD writes to.
//
// Both queries LEFT JOIN the three parent masters so the returned shape
// includes labels + ids (avoiding a second round trip on the FE), and
// tolerate absent joins (rows with a legacy code that no master row
// currently owns still surface — the label falls back to the form
// catalog's own `label` column).

'use strict';

const { pool } = require('../pool');

const MODES = new Set(['inventory', 'enquiry']);

/**
 * List every active form row for the requested surface, enriched with
 * label/id from the parent masters. Consumed by the /public/property-catalog
 * endpoint and (indirectly) by the FE's usePropertyCatalog hook.
 */
async function listByMode(mode) {
  if (!MODES.has(mode)) {
    throw new Error(`Unknown property-catalog mode: ${mode}`);
  }
  const [rows] = await pool.query(
    `SELECT
        pf.id                        AS form_id,
        pf.form_code                 AS form_code,
        pf.mode                      AS mode,
        pf.property_type_code        AS pt_code,
        pf.transaction_type_code     AS tt_code,
        pf.property_variety_code     AS pv_code,
        pf.label                     AS form_label,
        pf.sort_order                AS form_sort_order,
        mpt.id                       AS pt_id,
        mpt.label                    AS pt_label,
        mpt.sort_order               AS pt_sort_order,
        mtt.id                       AS tt_id,
        mtt.label                    AS tt_label,
        mtt.sort_order               AS tt_sort_order,
        mpv.id                       AS pv_id,
        mpv.label                    AS pv_label,
        mpv.sort_order               AS pv_sort_order
     FROM master_property_forms pf
     LEFT JOIN master_property_types    mpt ON mpt.code = pf.property_type_code    AND mpt.deleted_at IS NULL
     LEFT JOIN master_transaction_types mtt ON mtt.code = pf.transaction_type_code AND mtt.deleted_at IS NULL
     LEFT JOIN master_lookups           mpv ON mpv.code = pf.property_variety_code AND mpv.master_key = 'property_variety' AND mpv.deleted_at IS NULL
     WHERE pf.mode = ?
       AND pf.is_active = 1
       AND pf.deleted_at IS NULL
     ORDER BY
        COALESCE(mpt.sort_order, 9999),
        pf.property_type_code,
        COALESCE(mtt.sort_order, 9999),
        pf.transaction_type_code,
        COALESCE(mpv.sort_order, 9999),
        pf.property_variety_code,
        pf.sort_order`,
    [mode],
  );
  return rows;
}

/**
 * Return the form_code for a single (mode, PT, TT, PV) triple, or null
 * if no row matches. `pv` may be null / '' — the query treats the
 * variety column as nullable and matches NULL when the caller passes
 * an empty string.
 */
async function findFormCode(mode, ptCode, ttCode, pvCode) {
  if (!MODES.has(mode)) return null;
  if (!ptCode || !ttCode) return null;
  const pv = pvCode || null;
  // NULL-safe match: `pv IS NULL AND property_variety_code IS NULL`
  // must succeed, so we can't just compare with '=' (NULL never equals).
  const [rows] = await pool.query(
    `SELECT form_code
       FROM master_property_forms
      WHERE mode = ?
        AND property_type_code = ?
        AND transaction_type_code = ?
        AND ( (property_variety_code <=> ?) )
        AND is_active = 1
        AND deleted_at IS NULL
      LIMIT 1`,
    [mode, ptCode, ttCode, pv],
  );
  return rows[0] ? rows[0].form_code : null;
}

/**
 * Cheap existence probe — used by the endpoint + save validator to
 * decide whether the DB is authoritative yet (post-063) or the JS
 * fallback catalog is still needed (still-migrating environments).
 */
async function isCatalogSeeded() {
  const [[row]] = await pool.query(
    'SELECT COUNT(*) AS n FROM master_property_forms WHERE is_active = 1 AND deleted_at IS NULL',
  );
  return Number(row && row.n) > 0;
}

module.exports = {
  listByMode,
  findFormCode,
  isCatalogSeeded,
};
