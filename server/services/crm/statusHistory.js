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
 */

const { pool } = require('../../db/pool');
const crm = require('../../db/queries/crm');

function historyDto(row, calByAct) {
  const calRow = row.calendar_activity_id ? (calByAct[row.calendar_activity_id] || null) : null;
  return {
    id:                  row.id,
    enquiry_id:          row.enquiry_id,
    from_status:         row.from_status || null,
    to_status:           row.to_status,
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
  return historyRows.map((r) => historyDto(r, byAct));
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
