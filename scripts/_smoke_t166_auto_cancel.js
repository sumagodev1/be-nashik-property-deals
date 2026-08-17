#!/usr/bin/env node
/**
 * T-2026-166 smoke harness: auto-cancel active appointment when enquiry
 * status transitions to CLOSED_WON or CLOSED_LOST.
 *
 * Coverage (per ticket §Tester exercises):
 *   S1 CLOSED_WON auto-cancels an active future appointment.
 *      - crm_calendar_activities.booking_status flips to 'cancelled'
 *      - GCal events.delete mock is called with the row's
 *        google_event_id
 *      - crm_appointment_history gains a new row with action='cancelled',
 *        admin_id recorded, action_note contains 'auto:' prefix
 *      - response.auto_cancelled_appointment is populated with ok=true
 *   S2 CLOSED_LOST behaves identically.
 *   S3 A transition to any non-CLOSED status (e.g. 'first_call_done',
 *      'follow_up') leaves the active appointment intact and does NOT
 *      include the auto_cancelled_appointment field in the response.
 *   S4 CLOSED_WON on an enquiry with NO active appointment is a no-op
 *      -- no error, no new history row, response omits
 *      auto_cancelled_appointment.
 *   S5 Concurrency: manual cancel + status-change CLOSED_WON run in
 *      parallel -> both succeed. Whoever loses the row lock either
 *      cancels first or swallows ALREADY_CANCELLED. Final state: one
 *      cancelled row + at least one 'cancelled' history entry.
 *   S6 GCal delete mock throws -> status change still returns; response
 *      carries auto_cancelled_appointment.ok=true (per T-165: CRM
 *      cancellation is authoritative even if GCal fails) with
 *      gcal_sync_status='FAILED'. DB row is 'cancelled'.
 *   S7 Non-CLOSED transitions produce byte-identical response shape
 *      (no auto_cancelled_appointment key present).
 *   S8 Auto-cancel path does NOT log lead PII (name / mobile / email);
 *      captured console output should contain enquiry_code but not
 *      the lead's identifying fields.
 *
 * Baseline capture/restore: all planted rows are marked cancelled at
 * exit; status_code on the touched enquiry is restored. Google Calendar
 * module is mocked (no real API calls). Email transporter is mocked.
 */

require('dotenv').config();

// Force-disable the sync worker BEFORE requiring the app graph so
// setInterval never fires during the test window.
process.env.GOOGLE_CALENDAR_SYNC_WORKER_ENABLED = 'false';

const { pool } = require('../server/db/pool');
const appts = require('../server/db/queries/appointments');
const crm = require('../server/db/queries/crm');
const googleCalendar = require('../server/services/crm/googleCalendar');
const appointmentSlots = require('../server/services/crm/appointmentSlots');
const appointmentEmail = require('../server/services/crm/appointmentEmail');
const enquiries = require('../server/services/crm/enquiries');
const transporter = require('../server/services/email/transporter');

function assert(cond, label) {
  if (cond) {
    console.log(`  PASS  ${label}`);
    return true;
  }
  console.log(`  FAIL  ${label}`);
  return false;
}

function summarize(results) {
  const passed = results.filter(Boolean).length;
  const total = results.length;
  console.log(`\n== ${passed}/${total} assertions passed ==\n`);
  return passed === total;
}

async function pickEnquiry() {
  const [rows] = await pool.query(
    `SELECT e.id, e.enquiry_code, e.source_type, e.status_code
       FROM crm_enquiries e
       ORDER BY e.id ASC LIMIT 5`,
  );
  if (!rows.length) throw new Error('No crm_enquiries rows -- seed the DB first.');
  return rows[0];
}

async function clearActive(enquiryId) {
  await pool.query(
    `UPDATE crm_calendar_activities
        SET booking_status='cancelled', active_slot_key=NULL, cancelled_at=NOW()
      WHERE enquiry_id=? AND booking_status='active'`,
    [enquiryId],
  );
}

async function main() {
  console.log('T-2026-166 smoke -- auto-cancel on CLOSED_WON / CLOSED_LOST');
  console.log('=============================================================\n');

  const results = [];
  const plantedApptIds = [];

  // ── Mock googleCalendar exports ────────────────────────────────────
  const originalCreate = googleCalendar.createEvent;
  const originalCancel = googleCalendar.cancelEvent;
  const originalAuth = googleCalendar.getAuthorisedClient;
  const originalCheckBusy = appointmentSlots.checkGoogleCalendarBusy;
  const originalTrySend = transporter.trySendMail;
  const originalWarn = console.warn;

  let mockCreateSeq = 0;
  let mockCancelEventCalls = [];
  let cancelShouldFail = false;

  googleCalendar.createEvent = async () => {
    mockCreateSeq++;
    return {
      google_event_id: `MOCK_T166_EVT_${mockCreateSeq}_${Date.now()}`,
      sync_status: 'SYNCED',
      reason: null,
    };
  };
  googleCalendar.cancelEvent = async (eventId) => {
    mockCancelEventCalls.push(eventId);
    if (cancelShouldFail) {
      // Mirror the real cancelEvent's error-path shape (per
      // T-165 googleCalendar.cancelEvent contract: it never throws --
      // it returns { sync_status:'FAILED', reason:'GOOGLE_API_ERROR' }).
      return {
        google_event_id: eventId,
        sync_status: 'FAILED',
        reason: 'GOOGLE_API_ERROR',
      };
    }
    return { google_event_id: eventId, sync_status: 'CANCELLED', reason: null };
  };
  appointmentSlots.checkGoogleCalendarBusy = async () => ({ busy: false });
  transporter.trySendMail = async () => true;

  // Capture console.warn output so we can assert no-PII on failure paths.
  const warnCapture = [];
  console.warn = (...args) => {
    warnCapture.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };

  const originalStatus = {};

  try {
    const enquiry = await pickEnquiry();
    const enquiryId = enquiry.id;
    originalStatus[enquiryId] = enquiry.status_code;
    await clearActive(enquiryId);

    // Resolve identity for PII-in-log verification.
    const identity = await appointmentSlots.resolveLeadIdentity(enquiryId);

    // ── Helper: seed a fresh active appointment on a future slot. ──
    let slotCounter = 1;
    async function seedActive() {
      // Pick a unique far-future slot per call so parallel tests don't
      // collide with each other on the UNIQUE(active_slot_key) index.
      const day = 15 + slotCounter;
      slotCounter += 1;
      const dateStr = `2099-06-${String(day).padStart(2, '0')}`;
      const created = await appointmentSlots.createAppointment({
        enquiryId,
        scheduledDate: dateStr,
        scheduledTime: '10:00',
        contextNote: 'T-166 seed',
        detailedNote: 'seed for auto-cancel test',
        adminId: 1,
        unmasked: true,
      });
      plantedApptIds.push(created.appointment_id);
      return created;
    }

    // ────────────────────────────────────────────────────────────────
    // S1: CLOSED_WON auto-cancels active appointment
    // ────────────────────────────────────────────────────────────────
    console.log('S1: CLOSED_WON auto-cancels active appointment');
    mockCancelEventCalls = [];
    warnCapture.length = 0;
    const seed1 = await seedActive();
    const beforeHistCount = (await pool.query(
      'SELECT COUNT(*) AS c FROM crm_appointment_history WHERE appointment_id = ? AND action = ?',
      [seed1.appointment_id, 'cancelled'],
    ))[0][0].c;
    const res1 = await enquiries.changeStatus(enquiryId, { to_status: 'closed_won', note: 'S1 deal done' }, { adminId: 1 });
    results.push(assert(res1.status === 'OK', 'status change returns OK'));
    results.push(assert(res1.to_status === 'closed_won', 'to_status echoed'));
    results.push(assert(!!res1.auto_cancelled_appointment, 'auto_cancelled_appointment present'));
    results.push(assert(res1.auto_cancelled_appointment && res1.auto_cancelled_appointment.ok === true, 'auto_cancelled_appointment.ok=true'));
    results.push(assert(res1.auto_cancelled_appointment && res1.auto_cancelled_appointment.appointment_id === seed1.appointment_id, `auto_cancelled_appointment.appointment_id=${seed1.appointment_id}`));
    results.push(assert(res1.auto_cancelled_appointment && res1.auto_cancelled_appointment.google_event_id === seed1.google_event_id, 'auto_cancelled_appointment.google_event_id matches seed'));
    results.push(assert(res1.auto_cancelled_appointment && !!res1.auto_cancelled_appointment.scheduled_at, 'auto_cancelled_appointment.scheduled_at present'));
    // DB assertion: booking_status flipped.
    const [row1] = await pool.query('SELECT booking_status, cancelled_by_admin_id, cancelled_at FROM crm_calendar_activities WHERE id = ?', [seed1.appointment_id]);
    results.push(assert(row1[0] && row1[0].booking_status === 'cancelled', `DB booking_status='cancelled' (got ${row1[0] && row1[0].booking_status})`));
    results.push(assert(row1[0] && row1[0].cancelled_by_admin_id === 1, `cancelled_by_admin_id recorded (got ${row1[0] && row1[0].cancelled_by_admin_id})`));
    results.push(assert(row1[0] && row1[0].cancelled_at !== null, 'cancelled_at timestamp set'));
    // GCal delete assertion.
    results.push(assert(mockCancelEventCalls.length === 1, `googleCalendar.cancelEvent called once (got ${mockCancelEventCalls.length})`));
    results.push(assert(mockCancelEventCalls[0] === seed1.google_event_id, 'cancelEvent called with the correct event_id'));
    // History row assertion.
    const [hist1] = await pool.query(
      'SELECT action, admin_id, action_note FROM crm_appointment_history WHERE appointment_id = ? AND action = ? ORDER BY id DESC LIMIT 1',
      [seed1.appointment_id, 'cancelled'],
    );
    results.push(assert(hist1.length === 1, 'new history row with action=cancelled inserted'));
    results.push(assert(hist1[0] && hist1[0].admin_id === 1, `history admin_id=1 (got ${hist1[0] && hist1[0].admin_id})`));
    results.push(assert(hist1[0] && /^auto:/.test(hist1[0].action_note || ''), `history action_note starts with 'auto:' (got '${hist1[0] && hist1[0].action_note}')`));
    results.push(assert(hist1[0] && /CLOSED_WON/.test(hist1[0].action_note || ''), 'history action_note mentions CLOSED_WON'));
    // No PII in warn logs (there should be zero warns on the happy path).
    const s1WarnBlob = warnCapture.join(' | ');
    if (identity && identity.name) {
      results.push(assert(!s1WarnBlob.includes(identity.name), 'no lead name in warn logs (happy path)'));
    }
    if (identity && identity.mobile) {
      results.push(assert(!s1WarnBlob.includes(identity.mobile), 'no lead mobile in warn logs (happy path)'));
    }

    // ────────────────────────────────────────────────────────────────
    // S2: CLOSED_LOST also auto-cancels
    // ────────────────────────────────────────────────────────────────
    console.log('\nS2: CLOSED_LOST auto-cancels active appointment');
    mockCancelEventCalls = [];
    // Reset the enquiry status so the next transition is meaningful.
    await pool.query('UPDATE crm_enquiries SET status_code = ? WHERE id = ?', [originalStatus[enquiryId] || 'new_enquiry', enquiryId]);
    const seed2 = await seedActive();
    const res2 = await enquiries.changeStatus(enquiryId, { to_status: 'closed_lost', note: 'S2 deal dead' }, { adminId: 2 });
    results.push(assert(res2.status === 'OK', 'status change returns OK'));
    results.push(assert(!!res2.auto_cancelled_appointment && res2.auto_cancelled_appointment.ok === true, 'auto_cancelled_appointment.ok=true for CLOSED_LOST'));
    results.push(assert(res2.auto_cancelled_appointment && res2.auto_cancelled_appointment.appointment_id === seed2.appointment_id, 'CLOSED_LOST cancelled the correct appointment'));
    const [row2] = await pool.query('SELECT booking_status FROM crm_calendar_activities WHERE id = ?', [seed2.appointment_id]);
    results.push(assert(row2[0] && row2[0].booking_status === 'cancelled', 'CLOSED_LOST flipped DB booking_status to cancelled'));
    results.push(assert(mockCancelEventCalls.length === 1, 'CLOSED_LOST invoked GCal cancel once'));
    const [hist2] = await pool.query(
      'SELECT action_note FROM crm_appointment_history WHERE appointment_id = ? AND action = ? ORDER BY id DESC LIMIT 1',
      [seed2.appointment_id, 'cancelled'],
    );
    results.push(assert(hist2.length === 1 && /CLOSED_LOST/.test(hist2[0].action_note || ''), 'history note mentions CLOSED_LOST'));

    // ────────────────────────────────────────────────────────────────
    // S3: Non-CLOSED transition leaves appointment untouched
    // ────────────────────────────────────────────────────────────────
    console.log('\nS3: non-CLOSED transition does NOT auto-cancel');
    mockCancelEventCalls = [];
    await pool.query('UPDATE crm_enquiries SET status_code = ? WHERE id = ?', [originalStatus[enquiryId] || 'new_enquiry', enquiryId]);
    const seed3 = await seedActive();
    const res3 = await enquiries.changeStatus(enquiryId, { to_status: 'first_call_done', note: 'S3 just first call' }, { adminId: 1 });
    results.push(assert(res3.status === 'OK', 'first_call_done status change OK'));
    results.push(assert(res3.auto_cancelled_appointment === undefined, `auto_cancelled_appointment key omitted for non-CLOSED (got ${JSON.stringify(res3.auto_cancelled_appointment)})`));
    const [row3] = await pool.query('SELECT booking_status FROM crm_calendar_activities WHERE id = ?', [seed3.appointment_id]);
    results.push(assert(row3[0] && row3[0].booking_status === 'active', 'appointment still active after non-CLOSED transition'));
    results.push(assert(mockCancelEventCalls.length === 0, 'GCal cancelEvent NOT called'));
    // Try another non-CLOSED code to confirm the guard is exhaustive.
    const res3b = await enquiries.changeStatus(enquiryId, { to_status: 'follow_up' }, { adminId: 1 });
    results.push(assert(res3b.auto_cancelled_appointment === undefined, "follow_up transition also omits auto_cancelled_appointment"));
    const [row3b] = await pool.query('SELECT booking_status FROM crm_calendar_activities WHERE id = ?', [seed3.appointment_id]);
    results.push(assert(row3b[0].booking_status === 'active', 'appointment still active after follow_up'));
    // Clean up so subsequent tests get a clean slate.
    await pool.query(`UPDATE crm_calendar_activities SET booking_status='cancelled', active_slot_key=NULL, cancelled_at=NOW() WHERE id = ?`, [seed3.appointment_id]);

    // ────────────────────────────────────────────────────────────────
    // S4: CLOSED_WON on enquiry with NO active appointment -> no error
    // ────────────────────────────────────────────────────────────────
    console.log('\nS4: CLOSED_WON with no active appointment is a no-op');
    mockCancelEventCalls = [];
    await pool.query('UPDATE crm_enquiries SET status_code = ? WHERE id = ?', [originalStatus[enquiryId] || 'new_enquiry', enquiryId]);
    // Make absolutely sure there's no active appointment.
    await clearActive(enquiryId);
    const histCountBefore = (await pool.query(
      'SELECT COUNT(*) AS c FROM crm_appointment_history WHERE appointment_id IN (SELECT id FROM crm_calendar_activities WHERE enquiry_id = ?)',
      [enquiryId],
    ))[0][0].c;
    const res4 = await enquiries.changeStatus(enquiryId, { to_status: 'closed_won' }, { adminId: 1 });
    results.push(assert(res4.status === 'OK', 'status change OK with no active appointment'));
    results.push(assert(res4.auto_cancelled_appointment === undefined, `auto_cancelled_appointment omitted when no active appointment (got ${JSON.stringify(res4.auto_cancelled_appointment)})`));
    results.push(assert(mockCancelEventCalls.length === 0, 'GCal cancelEvent NOT called'));
    const histCountAfter = (await pool.query(
      'SELECT COUNT(*) AS c FROM crm_appointment_history WHERE appointment_id IN (SELECT id FROM crm_calendar_activities WHERE enquiry_id = ?)',
      [enquiryId],
    ))[0][0].c;
    results.push(assert(Number(histCountBefore) === Number(histCountAfter), `no new history row inserted (before=${histCountBefore} after=${histCountAfter})`));

    // ────────────────────────────────────────────────────────────────
    // S5: Concurrency -- manual cancel + auto-cancel race
    // ────────────────────────────────────────────────────────────────
    console.log('\nS5: concurrent manual cancel + status-change CLOSED_WON');
    mockCancelEventCalls = [];
    await pool.query('UPDATE crm_enquiries SET status_code = ? WHERE id = ?', [originalStatus[enquiryId] || 'new_enquiry', enquiryId]);
    const seed5 = await seedActive();
    // Fire both concurrently. Whichever wins the row lock cancels;
    // the loser either lands on ALREADY_CANCELLED (409 for the manual
    // path or swallowed on the auto path).
    const [manualRes, statusRes] = await Promise.allSettled([
      appointmentSlots.cancelAppointment({ appointmentId: seed5.appointment_id, adminId: 99, actionNote: 'manual concurrent' }),
      enquiries.changeStatus(enquiryId, { to_status: 'closed_won' }, { adminId: 1 }),
    ]);
    results.push(assert(statusRes.status === 'fulfilled', 'status-change promise resolved (auto path never re-throws)'));
    // The manual side is allowed to fail with ALREADY_CANCELLED if the auto side won,
    // and allowed to succeed if it won.
    const manualOk = manualRes.status === 'fulfilled';
    const manualAlreadyCancelled = manualRes.status === 'rejected' && manualRes.reason && manualRes.reason.code === 'ALREADY_CANCELLED';
    results.push(assert(manualOk || manualAlreadyCancelled, `manual cancel either succeeded or hit ALREADY_CANCELLED (state=${manualRes.status})`));
    const [row5] = await pool.query('SELECT booking_status, cancelled_by_admin_id FROM crm_calendar_activities WHERE id = ?', [seed5.appointment_id]);
    results.push(assert(row5[0] && row5[0].booking_status === 'cancelled', 'final DB row is cancelled after race'));
    // Two legal outcomes:
    //   (A) auto-path won the row lock -> auto_cancelled_appointment.ok=true,
    //       cancelled_by_admin_id=1 (the changeStatus caller).
    //   (B) manual-path won first -> by the time the auto path called
    //       getActiveAppointmentForEnquiry the row was already cancelled,
    //       so the field is omitted entirely. cancelled_by_admin_id=99.
    // Either way the appointment IS cancelled and no exception escaped.
    const autoR = statusRes.value && statusRes.value.auto_cancelled_appointment;
    const cancelledBy = row5[0] && row5[0].cancelled_by_admin_id;
    const outcomeA = autoR && autoR.ok === true && cancelledBy === 1;
    const outcomeB = autoR === undefined && cancelledBy === 99;
    // ALREADY_CANCELLED swallowed path: auto-path saw the row still
    // 'active' at lookup, tried to cancel it, and hit ALREADY_CANCELLED
    // during the tx acquire -> we treat as ok=true + reason='ALREADY_CANCELLED'.
    const outcomeC = autoR && autoR.ok === true && autoR.reason === 'ALREADY_CANCELLED';
    results.push(assert(outcomeA || outcomeB || outcomeC, `race outcome is (A) auto-won ok=true / (B) manual-won field-omitted / (C) ALREADY_CANCELLED swallowed. auto=${JSON.stringify(autoR)} cancelled_by=${cancelledBy}`));

    // ────────────────────────────────────────────────────────────────
    // S6: GCal delete fails -> DB still cancelled, ok=true, gcal_sync_status=FAILED
    // ────────────────────────────────────────────────────────────────
    console.log('\nS6: GCal delete fails -> DB cancelled, response flags GCal FAILED');
    mockCancelEventCalls = [];
    cancelShouldFail = true;
    try {
      await pool.query('UPDATE crm_enquiries SET status_code = ? WHERE id = ?', [originalStatus[enquiryId] || 'new_enquiry', enquiryId]);
      const seed6 = await seedActive();
      const res6 = await enquiries.changeStatus(enquiryId, { to_status: 'closed_won' }, { adminId: 1 });
      results.push(assert(res6.status === 'OK', 'status change still returns OK when GCal fails'));
      results.push(assert(!!res6.auto_cancelled_appointment, 'auto_cancelled_appointment present on GCal failure'));
      results.push(assert(res6.auto_cancelled_appointment && res6.auto_cancelled_appointment.ok === true, 'auto_cancelled_appointment.ok=true (CRM cancel is authoritative)'));
      results.push(assert(res6.auto_cancelled_appointment && res6.auto_cancelled_appointment.gcal_sync_status === 'FAILED', `gcal_sync_status=FAILED (got ${res6.auto_cancelled_appointment && res6.auto_cancelled_appointment.gcal_sync_status})`));
      results.push(assert(res6.auto_cancelled_appointment && res6.auto_cancelled_appointment.gcal_reason === 'GOOGLE_API_ERROR', `gcal_reason=GOOGLE_API_ERROR (got ${res6.auto_cancelled_appointment && res6.auto_cancelled_appointment.gcal_reason})`));
      const [row6] = await pool.query('SELECT booking_status FROM crm_calendar_activities WHERE id = ?', [seed6.appointment_id]);
      results.push(assert(row6[0] && row6[0].booking_status === 'cancelled', 'DB row cancelled even when GCal failed'));
      results.push(assert(mockCancelEventCalls.length === 1, 'GCal cancelEvent was invoked once'));
    } finally {
      cancelShouldFail = false;
    }

    // ────────────────────────────────────────────────────────────────
    // S7: Non-CLOSED response shape is byte-identical (regression on T-165)
    // ────────────────────────────────────────────────────────────────
    console.log('\nS7: non-CLOSED response shape unchanged (T-165 regression)');
    await pool.query('UPDATE crm_enquiries SET status_code = ? WHERE id = ?', [originalStatus[enquiryId] || 'new_enquiry', enquiryId]);
    const res7 = await enquiries.changeStatus(enquiryId, { to_status: 'on_hold' }, { adminId: 1 });
    const keys7 = Object.keys(res7).sort();
    const expected7 = ['appointment', 'calendar_activity_id', 'enquiry_id', 'status', 'to_status'];
    results.push(assert(JSON.stringify(keys7) === JSON.stringify(expected7), `non-CLOSED response keys = ${JSON.stringify(expected7)} (got ${JSON.stringify(keys7)})`));
    results.push(assert(!('auto_cancelled_appointment' in res7), 'auto_cancelled_appointment key absent on non-CLOSED'));

    // ────────────────────────────────────────────────────────────────
    // S8: No PII in warn logs even on failure path
    // ────────────────────────────────────────────────────────────────
    console.log('\nS8: no PII in warn logs even on failure path');
    warnCapture.length = 0;
    // Force appointmentSlots.cancelAppointment to throw a non-ALREADY_CANCELLED error.
    const originalCancelAppt = appointmentSlots.cancelAppointment;
    appointmentSlots.cancelAppointment = async () => {
      const e = new Error('synthetic DB blip for PII assertion');
      e.code = 'SYNTHETIC_ERR';
      throw e;
    };
    try {
      await pool.query('UPDATE crm_enquiries SET status_code = ? WHERE id = ?', [originalStatus[enquiryId] || 'new_enquiry', enquiryId]);
      const seed8 = await seedActive();
      const res8 = await enquiries.changeStatus(enquiryId, { to_status: 'closed_won' }, { adminId: 1 });
      results.push(assert(res8.status === 'OK', 'status change succeeds despite cancel failure'));
      results.push(assert(res8.auto_cancelled_appointment && res8.auto_cancelled_appointment.ok === false, 'auto_cancelled_appointment.ok=false on hard cancel failure'));
      results.push(assert(res8.auto_cancelled_appointment && res8.auto_cancelled_appointment.reason === 'SYNTHETIC_ERR', `reason propagated (got ${res8.auto_cancelled_appointment && res8.auto_cancelled_appointment.reason})`));
      const warnBlob = warnCapture.join(' | ');
      results.push(assert(warnBlob.length > 0, 'warn log captured'));
      if (identity && identity.name) {
        results.push(assert(!warnBlob.includes(identity.name), `lead name NOT in warn logs (identity.name='${identity.name}')`));
      }
      if (identity && identity.mobile) {
        results.push(assert(!warnBlob.includes(identity.mobile), `lead mobile NOT in warn logs`));
      }
      if (identity && identity.email) {
        results.push(assert(!warnBlob.includes(identity.email), `lead email NOT in warn logs`));
      }
      // Clean up the seed8 row manually since our stubbed cancel didn't.
      await pool.query(`UPDATE crm_calendar_activities SET booking_status='cancelled', active_slot_key=NULL, cancelled_at=NOW() WHERE id = ?`, [seed8.appointment_id]);
    } finally {
      appointmentSlots.cancelAppointment = originalCancelAppt;
    }

  } finally {
    // ── Restore mocks ───────────────────────────────────────────────
    googleCalendar.createEvent = originalCreate;
    googleCalendar.cancelEvent = originalCancel;
    googleCalendar.getAuthorisedClient = originalAuth;
    appointmentSlots.checkGoogleCalendarBusy = originalCheckBusy;
    transporter.trySendMail = originalTrySend;
    console.warn = originalWarn;

    // ── Restore enquiry state ───────────────────────────────────────
    for (const [id, code] of Object.entries(originalStatus)) {
      try {
        await pool.query('UPDATE crm_enquiries SET status_code = ? WHERE id = ?', [code, id]);
      } catch (_) { /* best effort */ }
    }

    // ── Sweep planted appointments so we leave zero residue ─────────
    if (plantedApptIds.length) {
      try {
        await pool.query(
          `UPDATE crm_calendar_activities
              SET booking_status='cancelled', active_slot_key=NULL, cancelled_at=IFNULL(cancelled_at, NOW())
            WHERE id IN (?)`,
          [plantedApptIds],
        );
      } catch (_) { /* best effort */ }
    }

    await pool.end();
  }

  const ok = summarize(results);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error('T-166 smoke crashed:', err && err.stack || err);
  process.exit(2);
});
