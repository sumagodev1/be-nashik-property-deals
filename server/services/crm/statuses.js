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

async function listActiveFor(masterKey) {
  const { data } = await masters.listAll(masterKey, { isActive: true });
  return sortRows(data);
}

/** Legacy CRM status (T-2026-151). Preserved for backward compat. */
async function listActive() {
  return listActiveFor('crm_status');
}

/** T-2026-169 Phase A: CRM Lead Stages. */
async function listActiveLeadStages() {
  return listActiveFor('crm_lead_stage');
}

/** T-2026-169 Phase A: CRM Lead Status. */
async function listActiveLeadStatus() {
  return listActiveFor('crm_lead_status');
}

/** T-2026-169 Phase A: CRM Lead Rating. */
async function listActiveLeadRating() {
  return listActiveFor('crm_lead_rating');
}

module.exports = {
  listActive,
  listActiveLeadStages,
  listActiveLeadStatus,
  listActiveLeadRating,
};
