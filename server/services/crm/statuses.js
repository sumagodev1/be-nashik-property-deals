/**
 * CRM Status master reader (T-2026-151 Phase 1; extended T-2026-169 Phase A).
 *
 * T-2026-151: exposes listActive() for the legacy crm_status master (used
 * by the old Change Status dropdown and preserved for backward compat).
 *
 * T-2026-169 Phase A: adds three new reader helpers for the CRM lead
 * taxonomy (Lead Stage / Lead Status / Lead Rating) so the FE Change
 * Lead modal + Listing chips can populate their independent dropdowns
 * from live master data (never hardcoded per project convention §14).
 *
 * All four helpers return the same DTO shape (id / code / label /
 * sortOrder / isActive) sorted by sort_order then label.
 *
 * THE THREE VOCABULARIES ARE INDEPENDENT. There is no parent/child link
 * between Stage, Status and Rating and no notion of a valid combination: any
 * active Stage may be saved with any active Status and any active Rating.
 *
 * KEEPING A DEACTIVATED VALUE VISIBLE
 * Each helper takes an optional `keepCode`. Deactivating a master value must
 * stop it being CHOSEN for new work without blanking the leads already saved
 * on it — so when a lead currently holds a value the admin has since
 * deactivated, that one row is appended to the list it would otherwise be
 * missing from. Without this the dialog's <select> would find no matching
 * option, render as unselected, and an operator saving an unrelated field
 * would silently overwrite the value. The appended row keeps isActive:false so
 * the client can mark it, and only the code actually in use is re-admitted —
 * every other deactivated value stays gone.
 */

const masters = require('../masters/management');

function sortRows(rows) {
  return rows.slice().sort((a, b) => {
    const av = Number(a.sortOrder) || 0;
    const bv = Number(b.sortOrder) || 0;
    if (av !== bv) return av - bv;
    return String(a.label).localeCompare(String(b.label));
  });
}

async function listActiveFor(masterKey, keepCode = '') {
  const { data } = await masters.listAll(masterKey, { isActive: true });
  const rows = sortRows(data);
  if (!keepCode || rows.some((r) => r.code === keepCode)) return rows;

  // The wanted code is not among the active rows: either it was deactivated,
  // or it no longer exists at all. Look it up unfiltered and append it if it
  // is a real (not soft-deleted) row; if it has genuinely gone, return the
  // active list unchanged rather than inventing an option for it.
  const { data: all } = await masters.listAll(masterKey, {});
  const kept = (all || []).find((r) => r.code === keepCode);
  return kept ? [...rows, { ...kept, isActive: false }] : rows;
}

/** Legacy CRM status (T-2026-151). Preserved for backward compat. */
async function listActive() {
  return listActiveFor('crm_status');
}

/** CRM Lead Stages. `keepCode` re-admits the lead's own deactivated value. */
async function listActiveLeadStages(keepCode = '') {
  return listActiveFor('crm_lead_stage', keepCode);
}

/** CRM Lead Status. Independent of Stage — no filtering by any other field. */
async function listActiveLeadStatus(keepCode = '') {
  return listActiveFor('crm_lead_status', keepCode);
}

/** CRM Lead Rating. Independent of Status — no filtering by any other field. */
async function listActiveLeadRating(keepCode = '') {
  return listActiveFor('crm_lead_rating', keepCode);
}

module.exports = {
  listActive,
  listActiveLeadStages,
  listActiveLeadStatus,
  listActiveLeadRating,
};
