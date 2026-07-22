// T-2026-058: business-tier service on top of the master_property_forms
// query layer. Two responsibilities:
//
//   1. tree(mode)
//       Fold the flat query rows into the nested (PT -> TT -> PV -> form)
//       structure the FE `usePropertyCatalog` hook expects. This is the
//       exact shape that was previously hardcoded in
//       src/admin/pages/Inventory/chooserTree.js.
//
//   2. resolveFormCode({ mode, propertyType, transactionType, propertyVariety })
//       Same signature as the FE's `deriveFormCode`, but the answer comes
//       from the DB. Falls back to the JS `formCodeCatalog` module (Fix D
//       from T-2026-057) when the DB table hasn't been seeded yet — that
//       fallback preserves behaviour on installs where migration 063
//       hasn't run.
//
// Nothing here mutates the catalog. CRUD on master_property_forms is
// intentionally NOT exposed as a public admin endpoint yet — the seed
// migration is the source, and future admin surfaces can add rows via
// the generic masters management endpoints once migration 063 is live
// everywhere.

'use strict';

const queries = require('../../db/queries/property_form_catalog');
const jsCatalog = require('../../constants/formCodeCatalog');

// Cache for isCatalogSeeded() — a hot-path probe on every save.
// Cheap to refresh (single SELECT COUNT(*)), so we cache for 60s
// then re-query. Long enough to keep saves fast; short enough that
// applying migration 063 in prod flips the app over within a minute.
let _seededCache = { at: 0, value: null };
async function _isSeededCached() {
  const now = Date.now();
  if (_seededCache.value !== null && now - _seededCache.at < 60_000) {
    return _seededCache.value;
  }
  try {
    const v = await queries.isCatalogSeeded();
    _seededCache = { at: now, value: v };
    return v;
  } catch (_e) {
    // Table doesn't exist yet (migration 063 not run). Cache the negative
    // result so we don't hammer the DB with the same failing query.
    _seededCache = { at: now, value: false };
    return false;
  }
}

/**
 * Return the nested tree for a mode:
 *
 *   [
 *     {
 *       propertyType: { id, code, label },
 *       transactions: [
 *         {
 *           transactionType: { id, code, label },
 *           varieties: [
 *             { id, code, label, formCode },
 *             ...
 *           ] | null,     // null when the transaction has no variety step
 *           formCode: '...'    // only for variety-less transactions
 *         }
 *       ]
 *     }
 *   ]
 */
async function tree(mode) {
  const rows = await queries.listByMode(mode);
  const byPt = new Map();
  for (const r of rows) {
    if (!byPt.has(r.pt_code)) {
      byPt.set(r.pt_code, {
        propertyType: {
          id:    r.pt_id ?? null,
          code:  r.pt_code,
          label: r.pt_label || r.pt_code,
          sortOrder: r.pt_sort_order ?? null,
        },
        _txnByCode: new Map(),
      });
    }
    const pt = byPt.get(r.pt_code);
    if (!pt._txnByCode.has(r.tt_code)) {
      pt._txnByCode.set(r.tt_code, {
        transactionType: {
          id:    r.tt_id ?? null,
          code:  r.tt_code,
          label: r.tt_label || r.tt_code,
          sortOrder: r.tt_sort_order ?? null,
        },
        varieties: [],
        formCode: null,
      });
    }
    const txn = pt._txnByCode.get(r.tt_code);
    if (r.pv_code) {
      txn.varieties.push({
        id:        r.pv_id ?? null,
        code:      r.pv_code,
        label:     r.pv_label || r.pv_code,
        sortOrder: r.pv_sort_order ?? null,
        formCode:  r.form_code,
      });
    } else {
      // Transaction terminates on a single form (no variety step).
      // Multiple such rows for the same (pt, tt) would be a data bug —
      // last one wins here; the admin can dedupe via the catalog table.
      txn.formCode = r.form_code;
    }
  }
  // Flatten Maps to arrays for JSON serialisation and drop the
  // `varieties` array when the txn is variety-less (matches the
  // shape the FE chooser has always expected).
  return Array.from(byPt.values()).map((pt) => ({
    propertyType: pt.propertyType,
    transactions: Array.from(pt._txnByCode.values()).map((t) => (
      t.varieties.length > 0
        ? { transactionType: t.transactionType, varieties: t.varieties }
        : { transactionType: t.transactionType, formCode: t.formCode }
    )),
  }));
}

/**
 * Resolve a form_code from the canonical trio, preferring the DB
 * catalog and falling back to the JS catalog when the table is
 * empty. Both surfaces (inventory + enquiry) share the same DB
 * table; `mode` disambiguates when a code exists on both sides.
 */
async function resolveFormCode({ mode, propertyType, transactionType, propertyVariety }) {
  const dbCode = await queries.findFormCode(
    mode,
    _slug(propertyType),
    _slug(transactionType),
    _slug(propertyVariety),
  );
  if (dbCode) return dbCode;
  // Fallback: the JS catalog. Preserves save validation on installs
  // that haven't run migration 063 yet.
  return jsCatalog.deriveFormCode(propertyType, transactionType, propertyVariety);
}

// Slugify FE labels/codes to the snake_case form the DB catalog stores.
// Handles kebab-case, spaces, and bracket suffixes ("Bunglow [Resale
// Lease Out]" -> "bunglow").
function _slug(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/\s*\[.*$/, '')
    .replace(/[-\s]+/g, '_');
}

/**
 * Cross-master combination check used by the inventory/enquiry save
 * validators. Contract mirrors formCodeCatalog.validateCombination
 * (log-only). Returns the resolved form code when the triple is
 * valid; returns '' when unmapped.
 */
async function validateCombination({ mode, propertyType, transactionType, propertyVariety, label = 'save' } = {}) {
  if (!propertyType || !transactionType) return '';
  const seeded = await _isSeededCached();
  if (seeded) {
    const code = await resolveFormCode({ mode, propertyType, transactionType, propertyVariety });
    if (!code) {
      // eslint-disable-next-line no-console
      console.warn(
        `[${label}] DB catalog: no form matches ` +
        `property_type=${propertyType} transaction_type=${transactionType} ` +
        `property_variety=${propertyVariety || '<empty>'} — record still saves. ` +
        'Reconcile master_property_forms with the FE chooser.',
      );
    }
    return code || '';
  }
  // DB not seeded — defer to the JS catalog (T-2026-057 Fix D).
  jsCatalog.validateCombination({ propertyType, transactionType, propertyVariety, label });
  return jsCatalog.deriveFormCode(propertyType, transactionType, propertyVariety);
}

module.exports = {
  tree,
  resolveFormCode,
  validateCombination,
  isCatalogSeeded: queries.isCatalogSeeded,
};
