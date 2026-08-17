/**
 * Google Calendar sync worker.
 *
 * T-2026-164. Reads PENDING/FAILED crm_calendar_activities rows,
 * retries them against the live Google Calendar API, and updates the
 * row + the denormalized crm_status_history.google_event_id column.
 *
 * Behaviour:
 *   * If no google_calendar_tokens row exists, the tick is a no-op --
 *     it does not thrash Google's API when no admin has connected.
 *   * When connected, processes up to BATCH_SIZE rows per tick.
 *   * On success -> updates sync_status=SYNCED + google_event_id.
 *   * On failure -> updates sync_status=FAILED + sync_last_error.
 *   * Idempotent: safe to run concurrently (only mutation is the
 *     UPDATE which is per-row and last-write-wins).
 *   * Also opportunistically reaps expired oauth state nonces.
 *
 * Scheduling:
 *   * Gated by GOOGLE_CALENDAR_SYNC_WORKER_ENABLED env var (default
 *     'true' when the process is booted via app.listen(); the tester
 *     sets it to 'false' so it can drive the worker manually).
 *   * Cadence: 5 minutes (GOOGLE_CALENDAR_SYNC_WORKER_INTERVAL_MS env
 *     override for tests).
 */

const gcal = require('./googleCalendar');
const gcalDb = require('../../db/queries/googleCalendar');
// T-2026-165: enrich retry payload with the same identity + property
// data the interactive create path uses, so the resulting Google
// event body carries name / mobile / property IDs per spec §7/§8.
const appointmentSlots = require('./appointmentSlots');

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const BATCH_SIZE = 20;

let intervalHandle = null;
let running = false; // in-flight lock so overlapping ticks don't dogpile

async function runOnce() {
  if (running) return { skipped: true, reason: 'ALREADY_RUNNING' };
  running = true;
  try {
    // Best-effort reap of expired OAuth state nonces so that table
    // doesn't grow unbounded when users abandon consent.
    try {
      await gcalDb.reapExpiredOAuthStates();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[googleCalendarSyncWorker] reap', (e && e.message) || 'unknown');
    }

    // Short-circuit if not connected -- avoid pulling PENDING rows
    // just to fail them one at a time.
    const token = await gcalDb.getSingletonToken();
    if (!token) {
      return { processed: 0, reason: 'NOT_CONNECTED' };
    }

    const rows = await gcalDb.listPendingCalendarActivities(BATCH_SIZE);
    if (!rows.length) return { processed: 0 };

    let succeeded = 0;
    let failed = 0;
    for (const r of rows) {
      // T-2026-165: enrich payload with lead identity + property IDs.
      // Fail-open: if identity lookup errors, we still push with the
      // minimum fields (matches T-151 behavior) rather than blocking
      // the retry.
      let identity = null;
      try { identity = await appointmentSlots.resolveLeadIdentity(r.enquiry_id); } catch (_) { /* keep null */ }
      const payload = {
        // scheduled_at is already a DATETIME in Asia/Kolkata wall-clock
        // (see combineIstDateTimeToIso helper in FE + enquiries.changeStatus
        // insert). Pass as scheduled_at_iso so buildEventBody uses it
        // directly.
        scheduled_at_iso: (r.scheduled_at instanceof Date)
          ? r.scheduled_at.toISOString().replace(/\.\d{3}Z$/, '+05:30')
          : String(r.scheduled_at || ''),
        context_note: r.context_note || '',
        // T-2026-165: use the dedicated detailed_note column now that
        // migration 108 has separated them.
        detailed_note: r.detailed_note || r.context_note || '',
        enquiry_code: r.enquiry_code || null,
        reminder_minutes_before_a: r.reminder_minutes_before_a,
        reminder_minutes_before_b: r.reminder_minutes_before_b,
        // Enriched (T-165). All optional -- buildEventBody handles nulls.
        lead_name: identity ? identity.name : '',
        lead_mobile: identity ? identity.mobile : '',
        enquiry_type: r.source_type || null,
        property_ids: identity ? identity.property_ids : [],
        current_status_code: r.current_status_code || null,
      };

      const result = await gcal.createEvent(payload);
      try {
        if (result.sync_status === 'SYNCED' && result.google_event_id) {
          await gcalDb.updateCalendarActivitySyncResult({
            id: r.id,
            google_event_id: result.google_event_id,
            sync_status: 'SYNCED',
            sync_last_error: null,
          });
          succeeded++;
        } else if (result.sync_status === 'PENDING' && result.reason === 'NOT_CONNECTED') {
          // Between the token check above and this call, the admin
          // disconnected. Leave the row as PENDING (no change).
          break;
        } else {
          await gcalDb.updateCalendarActivitySyncResult({
            id: r.id,
            google_event_id: null,
            sync_status: 'FAILED',
            sync_last_error: result.reason || 'GOOGLE_API_ERROR',
          });
          failed++;
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[googleCalendarSyncWorker] persist', (e && e.message) || 'unknown', { activity_id: r.id });
      }
    }
    return { processed: rows.length, succeeded, failed };
  } finally {
    running = false;
  }
}

function isEnabled() {
  const v = String(process.env.GOOGLE_CALENDAR_SYNC_WORKER_ENABLED || 'true').toLowerCase();
  return v !== 'false' && v !== '0' && v !== 'no';
}

function start() {
  if (intervalHandle) return { started: false, reason: 'ALREADY_STARTED' };
  if (!isEnabled()) return { started: false, reason: 'DISABLED_BY_ENV' };
  const intervalMs = Number(process.env.GOOGLE_CALENDAR_SYNC_WORKER_INTERVAL_MS) || DEFAULT_INTERVAL_MS;
  intervalHandle = setInterval(() => {
    runOnce().catch((e) => {
      // eslint-disable-next-line no-console
      console.error('[googleCalendarSyncWorker] tick error', (e && e.message) || 'unknown');
    });
  }, intervalMs);
  // Don't hold the event loop open just for this timer.
  if (intervalHandle && typeof intervalHandle.unref === 'function') intervalHandle.unref();
  return { started: true, intervalMs };
}

function stop() {
  if (!intervalHandle) return { stopped: false };
  clearInterval(intervalHandle);
  intervalHandle = null;
  return { stopped: true };
}

/**
 * Retry a single specific calendar activity by id. Used by the
 * /admin/crm/calendar-activities/:id/retry-sync endpoint. Returns the
 * updated row shape { id, sync_status, google_event_id, reason }.
 */
async function retryOne(id) {
  const r = await gcalDb.getCalendarActivityById(id);
  if (!r) return { id: Number(id), sync_status: null, reason: 'NOT_FOUND' };
  // T-2026-165: same enrichment as runOnce.
  let identity = null;
  try { identity = await appointmentSlots.resolveLeadIdentity(r.enquiry_id); } catch (_) { /* keep null */ }
  const payload = {
    scheduled_at_iso: (r.scheduled_at instanceof Date)
      ? r.scheduled_at.toISOString().replace(/\.\d{3}Z$/, '+05:30')
      : String(r.scheduled_at || ''),
    context_note: r.context_note || '',
    detailed_note: r.detailed_note || r.context_note || '',
    enquiry_code: r.enquiry_code || null,
    reminder_minutes_before_a: r.reminder_minutes_before_a,
    reminder_minutes_before_b: r.reminder_minutes_before_b,
    lead_name: identity ? identity.name : '',
    lead_mobile: identity ? identity.mobile : '',
    enquiry_type: r.source_type || null,
    property_ids: identity ? identity.property_ids : [],
    current_status_code: r.current_status_code || null,
  };
  const result = await gcal.createEvent(payload);
  if (result.sync_status === 'SYNCED' && result.google_event_id) {
    await gcalDb.updateCalendarActivitySyncResult({
      id: r.id,
      google_event_id: result.google_event_id,
      sync_status: 'SYNCED',
      sync_last_error: null,
    });
    return { id: r.id, sync_status: 'SYNCED', google_event_id: result.google_event_id, reason: null };
  }
  if (result.sync_status === 'PENDING' && result.reason === 'NOT_CONNECTED') {
    return { id: r.id, sync_status: 'PENDING', google_event_id: null, reason: 'NOT_CONNECTED' };
  }
  await gcalDb.updateCalendarActivitySyncResult({
    id: r.id,
    google_event_id: null,
    sync_status: 'FAILED',
    sync_last_error: result.reason || 'GOOGLE_API_ERROR',
  });
  return { id: r.id, sync_status: 'FAILED', google_event_id: null, reason: result.reason || 'GOOGLE_API_ERROR' };
}

module.exports = {
  runOnce,
  retryOne,
  start,
  stop,
  isEnabled,
  DEFAULT_INTERVAL_MS,
  BATCH_SIZE,
};
