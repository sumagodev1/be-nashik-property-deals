/**
 * CRM Status History reader (T-2026-151 Phase 1).
 *
 * Read-only surface -- history rows are IMMUTABLE. Every mutation
 * happens through enquiries.changeStatus() (or duplicateResolver.ingest()
 * for the initial row), which inserts inside a transaction.
 *
 * Also joins the crm_calendar_activities row when the history entry is
 * linked (calendar_activity_id) so the FE "History" panel can show the
 * scheduled follow-up beside the status change in one query.
 *
 * FIELD CONTEXT AND LABELS (T-2026-202)
 * Each row records WHICH field changed, in field_scope — 'lead_stage',
 * 'lead_status', 'lead_rating', or the legacy 'status'. The DTO used to drop
 * that column, so the client received an undifferentiated list of code pairs
 * and rendered a Stage change directly beneath a Rating change as though they
 * were one sequence. Reading down the panel produced nonsense like
 * "not_interested -> cold" next to "follow_up -> converted_to_deal". The data
 * was always correct; only its presentation was not.
 *
 * Labels are resolved HERE, at read time, from the live masters — the history
 * row stores the master CODE and nothing else, so renaming a master later
 * changes what the panel says without rewriting a single history row. A code
 * with no matching master row falls back to the raw code rather than being
 * hidden or guessed at: it is real history and must stay visible.
 *
 * Resolution deliberately ignores is_active. A value the admin has since
 * deactivated is still what happened, and history must not develop holes.
 */

const { pool } = require('../../db/pool');
const crm = require('../../db/queries/crm');
const masters = require('../masters/management');

/**
 * enquiries.changeStatus writes this sentinel when a Lead Rating is cleared:
 * to_status is NOT NULL, so "no rating" needs a stand-in value. It is not a
 * master code and never resolves, and nothing on the client special-cased it
 * despite a comment claiming otherwise — 13 rows were rendering the literal
 * string "__cleared__". Clearing a rating is a real recorded event, so it is
 * labelled honestly rather than hidden.
 */
const CLEARED_SENTINEL = '__cleared__';
const CLEARED_LABEL = 'Cleared';

/** field_scope -> the master vocabulary whose codes that scope stores. */
const MASTER_KEY_BY_SCOPE = Object.freeze({
  lead_stage:  'crm_lead_stage',
  lead_status: 'crm_lead_status',
  lead_rating: 'crm_lead_rating',
  status:      'crm_status',
});

/** Human name of the field itself, for the panel's per-row heading. */
const FIELD_LABEL_BY_SCOPE = Object.freeze({
  lead_stage:  'Lead Stage',
  lead_status: 'Lead Status',
  lead_rating: 'Lead Rating',
  status:      'CRM Status',
});

/**
 * code -> label maps for every vocabulary the given rows actually reference.
 * Only the needed vocabularies are fetched, so a history of pure Stage changes
 * costs one master read rather than four.
 */
async function labelMapsFor(rows) {
  const scopes = [...new Set(rows.map((r) => r.field_scope || 'status'))];
  const entries = await Promise.all(scopes.map(async (scope) => {
    const key = MASTER_KEY_BY_SCOPE[scope];
    if (!key) return [scope, {}];
    try {
      const { data } = await masters.listAll(key, {});
      return [scope, Object.fromEntries((data || []).map((m) => [m.code, m.label]))];
    } catch (err) {
      // A vocabulary that cannot be read must not take the whole history down;
      // the rows still render with their raw codes.
      return [scope, {}];
    }
  }));
  return Object.fromEntries(entries);
}

function historyDto(row, calByAct, labelMaps = {}) {
  const calRow = row.calendar_activity_id ? (calByAct[row.calendar_activity_id] || null) : null;
  const scope = row.field_scope || 'status';
  const labels = labelMaps[scope] || {};
  // Fall back to the stored code so an unmapped value is shown as-is rather
  // than blanked — the row is real history either way.
  const label = (code) => {
    if (!code) return null;
    if (code === CLEARED_SENTINEL) return CLEARED_LABEL;
    return labels[code] || code;
  };
  return {
    id:                  row.id,
    enquiry_id:          row.enquiry_id,
    // Which field this transition belongs to. The client groups on this so
    // Stage, Status and Rating are never read as one sequence.
    field_scope:         scope,
    field_label:         FIELD_LABEL_BY_SCOPE[scope] || scope,
    // Codes are the stored truth and stay in the payload; the *_label pair is
    // the current display name resolved from the masters.
    from_status:         row.from_status || null,
    to_status:           row.to_status,
    from_label:          label(row.from_status || null),
    to_label:            label(row.to_status),
    note:                row.note || null,
    changed_by_admin_id: row.changed_by_admin_id || null,
    calendar_activity_id: row.calendar_activity_id || null,
    calendar_activity:   calRow ? calendarActivityDto(calRow) : null,
    created_at:          row.created_at,
  };
}

function calendarActivityDto(row) {
  return {
    id:                        row.id,
    enquiry_id:                row.enquiry_id,
    scheduled_at:              row.scheduled_at,
    timezone:                  row.timezone,
    reminder_minutes_before_a: row.reminder_minutes_before_a,
    reminder_minutes_before_b: row.reminder_minutes_before_b,
    context_note:              row.context_note || null,
    // T-2026-165: expose the new fields to the FE.
    detailed_note:             row.detailed_note || null,
    booking_status:            row.booking_status || 'active',
    active_slot_key:           row.active_slot_key || null,
    cancelled_at:              row.cancelled_at || null,
    google_event_id:           row.google_event_id || null,
    sync_status:               row.sync_status,
    sync_last_attempt_at:      row.sync_last_attempt_at || null,
    sync_last_error:           row.sync_last_error || null,
    created_at:                row.created_at,
    updated_at:                row.updated_at || null,
  };
}

async function listForEnquiry(enquiryId) {
  const historyRows = await crm.listStatusHistory(enquiryId);
  const actIds = historyRows.map((r) => r.calendar_activity_id).filter(Boolean);
  let byAct = {};
  if (actIds.length) {
    const placeholders = actIds.map(() => '?').join(',');
    const [actRows] = await pool.query(
      `SELECT * FROM crm_calendar_activities WHERE id IN (${placeholders})`,
      actIds,
    );
    byAct = Object.fromEntries(actRows.map((r) => [r.id, r]));
  }
  // The legacy 'status' scope (crm_status) is not shown: that field was retired
  // from the UI when the three lead taxonomies replaced it, so a transition on
  // it reads as a phantom field nobody can see or set. The rows are NOT
  // deleted — they stay in crm_status_history, and this is a display filter
  // only, so the audit trail is intact if it is ever needed again.
  const visibleRows = historyRows.filter((r) => (r.field_scope || 'status') !== 'status');

  const labelMaps = await labelMapsFor(visibleRows);
  // crm.listStatusHistory already orders by created_at ASC, id ASC — oldest
  // first, with the stored insertion order breaking ties, so simultaneous
  // changes keep the order they were written in rather than being re-sorted.
  return visibleRows.map((r) => historyDto(r, byAct, labelMaps));
}

async function listCalendarForEnquiry(enquiryId) {
  const rows = await crm.listCalendarActivities(enquiryId);
  return rows.map(calendarActivityDto);
}

module.exports = {
  listForEnquiry,
  listCalendarForEnquiry,
  calendarActivityDto,
};
