/**
 * Pre-call admin reminder emails for booked CRM follow-ups (migration 112).
 *
 * CLIENT REQUIREMENT (verbatim):
 *   "when calender booked time is arriving before 1 day and 1 hour before
 *    admin should be recieved mail you have an booked phone call with this
 *    enquqiry id and assigned enquiry property id , name and email and
 *    message will be recieve on the email means admin know when have to call"
 *
 * WHY THIS EXISTS SEPARATELY FROM GOOGLE CALENDAR:
 *   crm_calendar_activities has always carried reminder_minutes_before_a
 *   (1440) and reminder_minutes_before_b (60), but those were only forwarded
 *   to Google as `{method:'popup'}` overrides. That produces a popup on the
 *   connected Google account -- not an email, not addressed to the Email
 *   Master admin address, and nothing at all while Google is disconnected.
 *   This dispatcher sends a real email from this system, carrying the enquiry
 *   context the operator needs in order to actually place the call.
 *
 * SHAPE:
 *   dispatchDueReminders() is invoked by cron (see routes/cron.js). Each tick:
 *     1. compute IST "now" -- scheduled_at is stored as IST wall-clock, so
 *        every comparison must be in that same space (never NOW(), which is
 *        the UTC session clock and would be 5h30m out).
 *     2. for each kind (a = 1 day, b = 1 hour), list bookings now due.
 *     3. CLAIM each row atomically before sending, so two overlapping cron
 *        invocations can never both mail the same reminder.
 *     4. resolve the lead identity + property codes and hand off to
 *        appointmentEmail, which routes to the Email Master admin address.
 *
 * DELIVERY GUARANTEES:
 *   Claim-then-send is at-most-once at the claim layer. Actual delivery is
 *   at-least-once below it: adminNotifications -> transporter.trySendMail
 *   falls back to email_outbox on SMTP failure, and the existing
 *   /api/cron/email-outbox/process worker retries with backoff. So a
 *   transient SMTP outage delays a reminder, it does not drop it.
 *
 *   The one case we deliberately roll the claim back is a failure while
 *   BUILDING the message (identity lookup blew up) -- nothing reached the
 *   mailer, so releasing lets the next tick retry instead of the reminder
 *   vanishing behind its own stamp.
 *
 * CRON (cPanel), alongside the existing email-outbox entry. Every 15 minutes
 * is enough: the 1-hour reminder then lands 45-60 min ahead of the call.
 *   *\/15 * * * * curl -fsS -X POST -H "X-Cron-Token: $CRON_TOKEN" \
 *     https://your-host/api/cron/crm/appointment-reminders/dispatch > /dev/null
 */

const appts = require('../../db/queries/appointments');
const { resolveLeadIdentity } = require('./appointmentSlots');
const { sendAppointmentEmail } = require('./appointmentEmail');

const IST_OFFSET_MS = (5 * 60 + 30) * 60_000;

// Kind 'a' is suppressed once the booking is already inside the 1-hour
// window -- see listDueAppointmentReminders' floorMinutes for why (a call
// booked 30 minutes out should get the 1-hour nudge only, not both at once).
const KINDS = Object.freeze([
  { kind: 'a', label: '1-day',  floorMinutes: 60 },
  { kind: 'b', label: '1-hour', floorMinutes: 0 },
]);

/**
 * IST wall-clock "now" as a MySQL DATETIME literal. Mirrors the offset maths
 * in appointmentSlots.computeIstNowFloor, but unfloored -- reminder windows
 * are continuous, not bucketed to 15 minutes.
 */
function istNowSql() {
  return new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * The stored context/detailed notes are what the operator wrote about why
 * they are calling -- the "message" in the requirement. Prefer the detailed
 * note, fall back to the short reminder note, join when both exist and say
 * different things.
 */
function buildNotes(row) {
  const context = (row.context_note || '').trim();
  const detailed = (row.detailed_note || '').trim();
  if (context && detailed && context !== detailed) return `${context} — ${detailed}`;
  return detailed || context || '';
}

/**
 * Send every reminder that has come due. Never throws: a single bad row must
 * not abort the batch (and cron surfaces only the HTTP status), so per-row
 * failures are captured into the summary instead.
 *
 * @returns {Promise<{now_ist: string, sent: number, claimed: number, skipped: number, failed: number, details: object[]}>}
 */
async function dispatchDueReminders({ limit = 100 } = {}) {
  const now = istNowSql();
  const summary = { now_ist: now, claimed: 0, sent: 0, skipped: 0, failed: 0, details: [] };

  for (const { kind, label, floorMinutes } of KINDS) {
    let due = [];
    try {
      due = await appts.listDueAppointmentReminders({ kind, istNowSql: now, floorMinutes, limit });
    } catch (err) {
      summary.failed += 1;
      summary.details.push({ kind: label, error: `scan failed: ${err.message}` });
      continue;
    }

    for (const row of due) {
      // Claim first -- a concurrent tick that loses the race gets false here
      // and moves on, so the admin never receives a duplicate.
      let claimed = false;
      try {
        claimed = await appts.claimAppointmentReminder({ appointmentId: row.id, kind, istNowSql: now });
      } catch (err) {
        summary.failed += 1;
        summary.details.push({ appointment_id: row.id, kind: label, error: `claim failed: ${err.message}` });
        continue;
      }
      if (!claimed) { summary.skipped += 1; continue; }
      summary.claimed += 1;

      try {
        const identity = await resolveLeadIdentity(row.enquiry_id);
        const result = await sendAppointmentEmail({
          mode: 'reminder',
          leadMinutes: Number(row.lead_minutes),
          enquiryCode: row.enquiry_code || (identity ? identity.enquiry_code : null),
          enquiryType: row.source_type || (identity ? identity.source_type : null),
          leadName:    identity ? identity.name : '',
          leadEmail:   identity ? identity.email : '',
          leadMobile:  identity ? identity.mobile : '',
          // appointmentEmail resolves these numeric ids into property_code
          // chips, skipping any that no longer resolve to a live property.
          propertyIds: identity ? identity.property_ids : [],
          scheduledAt: row.scheduled_at,
          leadStage:   row.lead_stage_code,
          leadStatus:  row.lead_status_code,
          leadRating:  row.lead_rating_code,
          notes:       buildNotes(row),
        });
        if (result && result.sent) {
          summary.sent += 1;
        } else {
          // Handed off but not delivered inline -- either queued to
          // email_outbox for retry, or skipped for a config reason such as
          // NO_ADMIN_EMAIL. Keep the claim: re-sending on the next tick
          // would duplicate whatever the outbox is already retrying.
          summary.failed += 1;
          summary.details.push({
            appointment_id: row.id,
            enquiry_code: row.enquiry_code,
            kind: label,
            skipped_reason: (result && result.skipped_reason) || 'NOT_SENT_INLINE',
          });
        }
      } catch (err) {
        // Build-time failure: nothing reached the mailer, so release the
        // claim and let the next tick retry rather than silently losing it.
        await appts.releaseAppointmentReminder({ appointmentId: row.id, kind }).catch(() => {});
        summary.claimed -= 1;
        summary.failed += 1;
        summary.details.push({ appointment_id: row.id, kind: label, error: err.message });
      }
    }
  }

  return summary;
}

// ─────────────────────────────────────────────────────────────────────
// In-process worker
// ─────────────────────────────────────────────────────────────────────
//
// The cron endpoint alone was not enough: it requires a cPanel cron entry
// that does not exist in local dev (and had not been added in production
// either), so due reminders simply never went out -- the dispatcher was
// correct but nothing ever called it.
//
// Mirrors services/crm/googleCalendarSyncWorker.js exactly (same enable
// flag shape, same unref'd interval, same boot log) so both workers behave
// identically and there is one pattern to reason about. The cron endpoint
// stays for manual/forced runs and for deployments that prefer external
// scheduling -- both paths are safe together because every reminder is
// claimed atomically before send.
//
// Interval defaults to 5 minutes, matching the GCal worker. That puts the
// 1-hour reminder 55-60 minutes ahead of the call, and the 1-day reminder
// within 5 minutes of its window opening.

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
// Small delay before the first tick so a restart (nodemon in dev) does not
// fire a dispatch mid-boot, while still not making a due reminder wait a
// whole interval.
const DEFAULT_FIRST_RUN_DELAY_MS = 15 * 1000;

let intervalHandle = null;
let firstRunHandle = null;

function isEnabled() {
  const v = String(process.env.CRM_REMINDER_WORKER_ENABLED || 'true').toLowerCase();
  return v !== 'false' && v !== '0' && v !== 'no';
}

function tick() {
  return dispatchDueReminders({}).then((summary) => {
    // Only log when something actually happened -- a quiet tick every 5
    // minutes would otherwise flood the log.
    if (summary.sent || summary.failed || summary.claimed) {
      // eslint-disable-next-line no-console
      console.log('[appointmentReminders] dispatched', {
        sent: summary.sent, claimed: summary.claimed, failed: summary.failed,
      });
    }
    return summary;
  });
}

function start() {
  if (intervalHandle) return { started: false, reason: 'ALREADY_STARTED' };
  if (!isEnabled()) return { started: false, reason: 'DISABLED_BY_ENV' };
  const intervalMs = Number(process.env.CRM_REMINDER_WORKER_INTERVAL_MS) || DEFAULT_INTERVAL_MS;
  const firstRunMs = Number(process.env.CRM_REMINDER_WORKER_FIRST_RUN_MS) || DEFAULT_FIRST_RUN_DELAY_MS;

  firstRunHandle = setTimeout(() => {
    tick().catch((e) => {
      // eslint-disable-next-line no-console
      console.error('[appointmentReminders] first-run error', (e && e.message) || 'unknown');
    });
  }, firstRunMs);
  if (firstRunHandle && typeof firstRunHandle.unref === 'function') firstRunHandle.unref();

  intervalHandle = setInterval(() => {
    tick().catch((e) => {
      // eslint-disable-next-line no-console
      console.error('[appointmentReminders] tick error', (e && e.message) || 'unknown');
    });
  }, intervalMs);
  // Don't hold the event loop open just for this timer.
  if (intervalHandle && typeof intervalHandle.unref === 'function') intervalHandle.unref();

  return { started: true, intervalMs, firstRunMs };
}

function stop() {
  if (firstRunHandle) { clearTimeout(firstRunHandle); firstRunHandle = null; }
  if (!intervalHandle) return { stopped: false };
  clearInterval(intervalHandle);
  intervalHandle = null;
  return { stopped: true };
}

module.exports = {
  dispatchDueReminders,
  start,
  stop,
  isEnabled,
  // Exposed for tests / diagnostics.
  istNowSql,
  buildNotes,
  KINDS,
};
