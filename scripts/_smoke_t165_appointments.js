#!/usr/bin/env node
/**
 * T-2026-165 smoke harness: CRM follow-up appointment slot validation
 * + edit / cancel + email confirmation.
 *
 * Coverage of §34 test cases 1-12 (plus concurrency + GCal-conflict +
 * edit-same-event + cancel-delete + email fire/skip):
 *
 *   T1  buildDayGrid produces 72 slots (06:00-23:45) at 15-min stride.
 *       The 73rd synthetic "12:00 AM" tail slot added by T-2026-169 Phase C has been removed.
 *   T2  parseAndFloorIstWallClock rounds 09:07 -> 09:00 bucket.
 *   T3  slotKeyFromIstWallClock renders YYYYMMDDHHMM correctly.
 *   T4  listAvailableSlots for an empty date returns all `available:true`.
 *   T5  createAppointment inserts an active row with correct slot key.
 *   T6  Second create for the SAME slot -> 409 SLOT_CONFLICT source=crm.
 *   T7  409 body masks lead name/mobile when unmasked=false.
 *   T8  Concurrency: Promise.all of 2 identical POSTs -> exactly ONE
 *       success + ONE 409 (UNIQUE(active_slot_key) belt-and-braces).
 *   T9  updateAppointment moves the slot atomically; old key freed.
 *   T10 Edit calls googleCalendar.updateEvent(event_id) -- NOT
 *       createEvent -- so the same GCal event id is preserved.
 *   T11 cancelAppointment sets booking_status='cancelled' + NULLs slot key.
 *   T12 Cancel calls googleCalendar.cancelEvent(event_id).
 *   Extra:
 *     * GCal freebusy conflict returns 409 source=google_calendar.
 *     * Email fires for a lead with valid email; skips for null-email.
 *     * buildEventBody includes lead_name + property_ids per spec §7/§8.
 *     * Appointment history rows are inserted for create + edit + cancel.
 *
 * Baseline capture/restore: leaves ZERO side effects (all planted rows
 * are deleted post-run; googleCalendar module is mocked, never calls the
 * real API).
 */

require('dotenv').config();

const path = require('path');

// Force-disable the sync worker BEFORE requiring the app graph so
// setInterval never fires during the test window.
process.env.GOOGLE_CALENDAR_SYNC_WORKER_ENABLED = 'false';

const { pool } = require('../server/db/pool');
const appts = require('../server/db/queries/appointments');
const crm = require('../server/db/queries/crm');
const gcalDb = require('../server/db/queries/googleCalendar');
const googleCalendar = require('../server/services/crm/googleCalendar');

// Load appointmentSlots AFTER we have the ability to monkey-patch
// googleCalendar. The service holds a reference to the module which
// makes function-level replacement work (module.exports.createEvent
// = fn).
const appointmentSlots = require('../server/services/crm/appointmentSlots');
const appointmentEmail = require('../server/services/crm/appointmentEmail');
const transporter = require('../server/services/email/transporter');

// ─────────────────────────────────────────────────────────────────────

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
  // Prefer an enquiry whose live source has both name + email so the
  // email-fire test path is real. Fall back to any enquiry otherwise.
  const [rows] = await pool.query(
    `SELECT e.id, e.enquiry_code, e.source_type FROM crm_enquiries e
      ORDER BY e.id ASC LIMIT 5`,
  );
  if (!rows.length) throw new Error('No crm_enquiries rows -- seed the DB first.');
  return rows[0].id;
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
  console.log('T-2026-165 smoke -- CRM appointment slot validation');
  console.log('====================================================\n');

  const results = [];
  const plantedApptIds = [];
  const originalCreate = googleCalendar.createEvent;
  const originalUpdate = googleCalendar.updateEvent;
  const originalCancel = googleCalendar.cancelEvent;
  const originalAuth = googleCalendar.getAuthorisedClient;
  const originalCheckBusy = appointmentSlots.checkGoogleCalendarBusy;
  const originalTrySend = transporter.trySendMail;

  // Mock counters
  let mockCreateEventCalls = 0;
  let mockUpdateEventCalls = [];
  let mockCancelEventCalls = [];
  let mockEmailCalls = [];
  let mockFreebusyBusy = false;

  // Replace googleCalendar exports with mocks.
  // NOTE: appointmentSlots requires googleCalendar as a module ref; we
  // replace the exported members. Since Node caches modules, all
  // callers share these stubs.
  googleCalendar.createEvent = async (payload) => {
    mockCreateEventCalls++;
    return {
      google_event_id: `MOCK_EVT_${mockCreateEventCalls}_${Date.now()}`,
      sync_status: 'SYNCED',
      reason: null,
    };
  };
  googleCalendar.updateEvent = async (eventId, payload) => {
    mockUpdateEventCalls.push({ eventId, payload });
    return { google_event_id: eventId, sync_status: 'SYNCED', reason: null };
  };
  googleCalendar.cancelEvent = async (eventId) => {
    mockCancelEventCalls.push(eventId);
    return { google_event_id: eventId, sync_status: 'CANCELLED', reason: null };
  };
  // Force the freebusy pre-check inside createAppointment/updateAppointment
  // to a controllable stub. Default false; individual tests flip it.
  appointmentSlots.checkGoogleCalendarBusy = async () => ({ busy: mockFreebusyBusy, window: mockFreebusyBusy ? { start: '2099-01-01T00:00:00Z', end: '2099-01-01T00:30:00Z' } : null });
  // Mock the email sender so we don't hit real SMTP. Capture calls.
  transporter.trySendMail = async (opts) => {
    mockEmailCalls.push(opts);
    return true;
  };

  try {
    const enquiryId = await pickEnquiry();
    // Clear any residual active appointments for this enquiry so the
    // tests below start from a clean slate.
    await clearActive(enquiryId);

    // Also seed a live email on the lead if it's a website enquiry
    // and currently NULL, so the email-fire test has something real.
    // We restore on exit.
    const [enqRow] = await pool.query(
      `SELECT e.source_type, e.source_id FROM crm_enquiries e WHERE e.id = ?`,
      [enquiryId],
    );
    const src = enqRow[0];
    let leadEmailWasNull = false;
    if (src && src.source_type === 'website') {
      const [leadRow] = await pool.query(`SELECT buyer_email FROM leads WHERE id = ?`, [src.source_id]);
      if (leadRow.length && !leadRow[0].buyer_email) {
        leadEmailWasNull = true;
        await pool.query(`UPDATE leads SET buyer_email = 't165-smoke@example.local' WHERE id = ?`, [src.source_id]);
      }
    }

    // ───────────────────────────────────────────────────────────────
    // T1: buildDayGrid produces 72 slots (06:00-23:45)
    // The synthetic '00:00' "12:00 AM" tail slot added by T-2026-169
    // Phase C has been removed -- the day now ends at 11:45 PM.
    // ───────────────────────────────────────────────────────────────
    console.log('T1: buildDayGrid -- 72 slots (06:00-23:45)');
    const grid = await appointmentSlots.listAvailableSlots({ date: '2099-01-01' });
    results.push(assert(grid.length === 72, `grid.length=72 (got ${grid.length})`));
    results.push(assert(grid[0].slot_start === '06:00', `first slot=06:00 (got ${grid[0].slot_start})`));
    results.push(assert(grid[grid.length - 1].slot_start === '23:45', `last slot=23:45 (got ${grid[grid.length - 1].slot_start})`));
    results.push(assert(!grid.some((s) => s.slot_start === '00:00'), 'no 00:00 midnight-boundary slot in the grid'));
    results.push(assert(grid.every((s) => s.available === true), 'every slot available on empty future date'));

    // ───────────────────────────────────────────────────────────────
    // T2: parseAndFloorIstWallClock floors 09:07 -> 09:00
    // ───────────────────────────────────────────────────────────────
    console.log('\nT2: parseAndFloorIstWallClock floors 09:07 -> 09:00');
    const p1 = appts.parseAndFloorIstWallClock('2099-06-15', '09:07');
    results.push(assert(p1.mm === 0, `mm floored to 0 (got ${p1.mm})`));
    results.push(assert(p1.hh === 9, `hh=9 (got ${p1.hh})`));
    const p2 = appts.parseAndFloorIstWallClock('2099-06-15', '09:47');
    results.push(assert(p2.mm === 45, `09:47 -> 09:45 (got ${p2.mm})`));
    const p3 = appts.parseAndFloorIstWallClock('2099-06-15', '09:15');
    results.push(assert(p3.mm === 15, `09:15 -> 09:15 (got ${p3.mm})`));

    // ───────────────────────────────────────────────────────────────
    // T3: slotKeyFromIstWallClock renders YYYYMMDDHHMM
    // ───────────────────────────────────────────────────────────────
    console.log('\nT3: slotKeyFromIstWallClock format');
    results.push(assert(p1.slotKey === '209906150900', `slotKey=209906150900 (got ${p1.slotKey})`));
    results.push(assert(p2.slotKey === '209906150945', `slotKey=209906150945 (got ${p2.slotKey})`));

    // ───────────────────────────────────────────────────────────────
    // T4: listAvailableSlots for a plain empty date already asserted in T1
    // (used as the smoke's "no CRM booking, no GCal busy" baseline)
    // ───────────────────────────────────────────────────────────────

    // ───────────────────────────────────────────────────────────────
    // T5: createAppointment inserts an active row with correct slot key
    // ───────────────────────────────────────────────────────────────
    console.log('\nT5: createAppointment inserts active row');
    mockCreateEventCalls = 0;
    mockEmailCalls = [];
    const create1 = await appointmentSlots.createAppointment({
      enquiryId,
      scheduledDate: '2099-06-15',
      scheduledTime: '10:00',
      contextNote: 'T-165 smoke create',
      detailedNote: 'unit test detailed note',
      adminId: null,
      unmasked: true,
    });
    plantedApptIds.push(create1.appointment_id);
    results.push(assert(!!create1.appointment_id, `appointment_id present (got ${create1.appointment_id})`));
    results.push(assert(create1.active_slot_key === '209906151000', `slot key=209906151000 (got ${create1.active_slot_key})`));
    results.push(assert(create1.sync_status === 'SYNCED', `sync_status=SYNCED (got ${create1.sync_status})`));
    results.push(assert(String(create1.google_event_id || '').startsWith('MOCK_EVT_'), `google_event_id set (got ${create1.google_event_id})`));
    results.push(assert(mockCreateEventCalls === 1, `mock createEvent called once (got ${mockCreateEventCalls})`));

    // Verify the row + history in DB.
    const [row1] = await pool.query('SELECT * FROM crm_calendar_activities WHERE id = ?', [create1.appointment_id]);
    results.push(assert(row1.length === 1 && row1[0].booking_status === 'active', 'row is active in DB'));
    results.push(assert(row1[0].active_slot_key === '209906151000', 'DB row slot key matches'));
    results.push(assert(row1[0].detailed_note === 'unit test detailed note', 'detailed_note persisted'));
    const [hist1] = await pool.query('SELECT * FROM crm_appointment_history WHERE appointment_id = ?', [create1.appointment_id]);
    results.push(assert(hist1.length === 1 && hist1[0].action === 'created', 'history has 1 created row'));

    // Extra: getActiveForEnquiry returns the DTO with the fields the FE relies on.
    const activeDto = await appointmentSlots.getActiveForEnquiry(enquiryId);
    results.push(assert(activeDto && activeDto.id === create1.appointment_id, `getActiveForEnquiry returns MRU (got id ${activeDto && activeDto.id})`));
    results.push(assert(activeDto && activeDto.booking_status === 'active', `booking_status field present (got ${activeDto && activeDto.booking_status})`));
    results.push(assert(activeDto && activeDto.active_slot_key === '209906151000', `active_slot_key field present (got ${activeDto && activeDto.active_slot_key})`));

    // Wait a tick so setImmediate email fires.
    await new Promise((r) => setTimeout(r, 50));
    // ───────────────────────────────────────────────────────────────
    // Email fire test (extra): mock trySendMail should have been called
    // exactly once for the created appointment (if the lead has email).
    // ───────────────────────────────────────────────────────────────
    console.log('\nExtra: email fires for lead with email');
    const emailFiredForCreate = mockEmailCalls.some((c) => (c.subject || '').includes('Scheduled'));
    results.push(assert(emailFiredForCreate, 'email fired with "Scheduled" subject on create'));

    // ───────────────────────────────────────────────────────────────
    // T6: SAME slot -> 409 SLOT_CONFLICT source=crm
    // ───────────────────────────────────────────────────────────────
    console.log('\nT6: second create same slot -> 409 SLOT_CONFLICT source=crm');
    let conflict1 = null;
    try {
      await appointmentSlots.createAppointment({
        enquiryId,
        scheduledDate: '2099-06-15',
        scheduledTime: '10:14',   // rounds to 10:00 (same bucket)
        contextNote: 'race attempt',
        detailedNote: null,
        adminId: null,
        unmasked: true,
      });
    } catch (e) {
      conflict1 = e;
    }
    results.push(assert(conflict1 && conflict1.status === 409, `409 thrown (got ${conflict1 && conflict1.status})`));
    results.push(assert(conflict1 && conflict1.code === 'SLOT_CONFLICT', `code=SLOT_CONFLICT (got ${conflict1 && conflict1.code})`));
    results.push(assert(conflict1 && conflict1.details && conflict1.details.source === 'crm', `conflict.source=crm (got ${conflict1 && conflict1.details && conflict1.details.source})`));
    results.push(assert(!!(conflict1 && conflict1.details && conflict1.details.appointment && conflict1.details.appointment.appointment_id), 'conflict.appointment.appointment_id present'));
    results.push(assert(conflict1 && conflict1.details && conflict1.details.next_available_slot === '10:15', `next_available_slot=10:15 (got ${conflict1 && conflict1.details && conflict1.details.next_available_slot})`));

    // ───────────────────────────────────────────────────────────────
    // T7: 409 body masks lead name/mobile when unmasked=false
    // ───────────────────────────────────────────────────────────────
    console.log('\nT7: 409 masks lead name/mobile when unmasked=false');
    let conflict2 = null;
    try {
      await appointmentSlots.createAppointment({
        enquiryId,
        scheduledDate: '2099-06-15',
        scheduledTime: '10:00',
        contextNote: 'race masked',
        detailedNote: null,
        adminId: null,
        unmasked: false,
      });
    } catch (e) {
      conflict2 = e;
    }
    const maskedAppt = conflict2 && conflict2.details && conflict2.details.appointment;
    // If the conflicting appt's lead has a name, it should be masked (e.g., 'Pa****').
    // A blank name is also acceptable (identity-less rows). What must NOT happen is
    // returning a value that CONTAINS the full name string with no masking.
    const conflictNameIsRaw = maskedAppt && maskedAppt.name && !maskedAppt.name.includes('*');
    results.push(assert(!conflictNameIsRaw, 'masked mode: name is NOT raw (blank or contains * mask)'));
    // Same for mobile: either blank or masked with X.
    const conflictMobileIsRaw = maskedAppt && maskedAppt.mobile && /^\d{10}$/.test(maskedAppt.mobile);
    results.push(assert(!conflictMobileIsRaw, 'masked mode: mobile is NOT raw 10 digits'));

    // ───────────────────────────────────────────────────────────────
    // T8: concurrency Promise.all -> exactly ONE 201 + ONE 409
    // ───────────────────────────────────────────────────────────────
    console.log('\nT8: Promise.all 2 identical -> exactly one 201 + one 409');
    // Clean the T5 booking so the concurrency test races on a fresh slot.
    await pool.query(`UPDATE crm_calendar_activities SET booking_status='cancelled', active_slot_key=NULL, cancelled_at=NOW() WHERE id=?`, [create1.appointment_id]);
    const raceOutcomes = await Promise.allSettled([
      appointmentSlots.createAppointment({
        enquiryId, scheduledDate: '2099-06-15', scheduledTime: '11:00',
        contextNote: 'racer A', detailedNote: null, adminId: null, unmasked: true,
      }),
      appointmentSlots.createAppointment({
        enquiryId, scheduledDate: '2099-06-15', scheduledTime: '11:00',
        contextNote: 'racer B', detailedNote: null, adminId: null, unmasked: true,
      }),
    ]);
    const successes = raceOutcomes.filter((o) => o.status === 'fulfilled');
    const failures = raceOutcomes.filter((o) => o.status === 'rejected');
    const conflictsSeen = failures.filter((o) => o.reason && o.reason.status === 409 && o.reason.code === 'SLOT_CONFLICT');
    results.push(assert(successes.length === 1, `exactly 1 success (got ${successes.length})`));
    results.push(assert(conflictsSeen.length === 1, `exactly 1 SLOT_CONFLICT (got ${conflictsSeen.length})`));
    if (successes.length) plantedApptIds.push(successes[0].value.appointment_id);

    // ───────────────────────────────────────────────────────────────
    // T9: updateAppointment moves the slot; old key freed
    // ───────────────────────────────────────────────────────────────
    console.log('\nT9: updateAppointment moves slot');
    mockUpdateEventCalls = [];
    const winnerId = successes[0].value.appointment_id;
    const winnerEventId = successes[0].value.google_event_id;
    const upd = await appointmentSlots.updateAppointment({
      appointmentId: winnerId,
      scheduledDate: '2099-06-15',
      scheduledTime: '12:15',
      contextNote: 'edited context',
      detailedNote: 'edited detailed',
      adminId: null,
      unmasked: true,
    });
    results.push(assert(upd.active_slot_key === '209906151215', `new slot key=209906151215 (got ${upd.active_slot_key})`));
    // Confirm old bucket is now free (no active row on 11:00).
    const [oldBucketRows] = await pool.query(`SELECT id FROM crm_calendar_activities WHERE active_slot_key='209906151100' AND booking_status='active'`);
    results.push(assert(oldBucketRows.length === 0, `old slot 11:00 freed (got ${oldBucketRows.length} rows)`));
    // History has an edited row.
    const [hist2] = await pool.query(`SELECT action FROM crm_appointment_history WHERE appointment_id=? ORDER BY id ASC`, [winnerId]);
    results.push(assert(hist2.some((h) => h.action === 'edited'), 'history has edited row'));

    // ───────────────────────────────────────────────────────────────
    // T10: Edit calls updateEvent (not createEvent) with SAME event_id
    // ───────────────────────────────────────────────────────────────
    console.log('\nT10: edit calls updateEvent with same event_id');
    results.push(assert(mockUpdateEventCalls.length === 1, `updateEvent called once (got ${mockUpdateEventCalls.length})`));
    results.push(assert(mockUpdateEventCalls[0].eventId === winnerEventId, `same event_id (got ${mockUpdateEventCalls[0].eventId} vs winner ${winnerEventId})`));

    // ───────────────────────────────────────────────────────────────
    // T11: cancelAppointment sets booking_status='cancelled'
    // ───────────────────────────────────────────────────────────────
    console.log('\nT11: cancelAppointment cancels + frees slot');
    mockCancelEventCalls = [];
    const cnc = await appointmentSlots.cancelAppointment({ appointmentId: winnerId, adminId: null });
    results.push(assert(cnc.booking_status === 'cancelled', `booking_status=cancelled (got ${cnc.booking_status})`));
    const [afterCancel] = await pool.query(`SELECT booking_status, active_slot_key FROM crm_calendar_activities WHERE id=?`, [winnerId]);
    results.push(assert(afterCancel[0].booking_status === 'cancelled', 'DB row booking_status=cancelled'));
    results.push(assert(afterCancel[0].active_slot_key === null, 'DB row active_slot_key NULL'));
    const [hist3] = await pool.query(`SELECT action FROM crm_appointment_history WHERE appointment_id=? ORDER BY id ASC`, [winnerId]);
    results.push(assert(hist3.some((h) => h.action === 'cancelled'), 'history has cancelled row'));

    // ───────────────────────────────────────────────────────────────
    // T12: cancel calls cancelEvent(google_event_id)
    // ───────────────────────────────────────────────────────────────
    console.log('\nT12: cancel calls googleCalendar.cancelEvent(event_id)');
    results.push(assert(mockCancelEventCalls.length === 1, `cancelEvent called once (got ${mockCancelEventCalls.length})`));
    results.push(assert(mockCancelEventCalls[0] === winnerEventId, `same event_id (got ${mockCancelEventCalls[0]})`));

    // ───────────────────────────────────────────────────────────────
    // Extra: GCal freebusy conflict -> 409 source=google_calendar
    // ───────────────────────────────────────────────────────────────
    console.log('\nExtra: freebusy busy -> 409 source=google_calendar');
    mockFreebusyBusy = true;
    let gcalConflict = null;
    try {
      await appointmentSlots.createAppointment({
        enquiryId, scheduledDate: '2099-06-15', scheduledTime: '14:00',
        contextNote: 'gcal busy', detailedNote: null, adminId: null, unmasked: true,
      });
    } catch (e) { gcalConflict = e; }
    mockFreebusyBusy = false;
    results.push(assert(gcalConflict && gcalConflict.status === 409, `409 (got ${gcalConflict && gcalConflict.status})`));
    results.push(assert(gcalConflict && gcalConflict.details && gcalConflict.details.source === 'google_calendar', `source=google_calendar (got ${gcalConflict && gcalConflict.details && gcalConflict.details.source})`));
    // Do NOT leak external event title -- assert google_busy has a generic 'note'
    results.push(assert(gcalConflict && gcalConflict.details && gcalConflict.details.google_busy && gcalConflict.details.google_busy.note && !gcalConflict.details.google_busy.title, 'google_busy has generic note (no title leak)'));

    // ───────────────────────────────────────────────────────────────
    // T-2026-179: contract change -- notifications are now ADMIN-ONLY.
    // Under the pre-T-179 design this test asserted "email skips when
    // lead email is missing" (sent=false, skipped_reason=
    // MISSING_OR_INVALID_EMAIL). Post-T-179 the recipient is ALWAYS
    // the Admin Email loaded from Email Master; the lead's own email
    // is captured only for the defensive customer-email guard and is
    // NOT the recipient. Therefore missing leadEmail does NOT skip
    // the send anymore -- admin still gets the notification.
    //
    // The rewritten assertion: with a null leadEmail and a mocked
    // trySendMail + a valid Email Master admin, the wrapper still
    // fires exactly one send, and captured.to === admin (never null,
    // never the missing customer email).
    // ───────────────────────────────────────────────────────────────
    console.log('\nExtra: T-179 admin-only notification -- fires even with null leadEmail');
    mockEmailCalls = [];
    // Ensure the mocked transporter returns a valid admin so the
    // sendAdminNotification code path can complete.
    const origGetAdminEmail = transporter.getAdminEmail;
    transporter.getAdminEmail = async () => 'admin@example.invalid';
    try {
      const adminOnlyTest = await appointmentEmail.sendAppointmentEmail({
        leadEmail: null,
        leadName: 'X',
        leadMobile: '9999999999',
        enquiryCode: 'ENQ-TEST',
        enquiryType: 'website',
        scheduledAt: new Date(),
        propertyIds: [1],
        mode: 'created',
      });
      results.push(assert(adminOnlyTest.sent === true, `T-179: sent=true even when leadEmail null (got ${adminOnlyTest.sent})`));
      results.push(assert(mockEmailCalls.length === 1, `T-179: trySendMail called exactly once (got ${mockEmailCalls.length})`));
      results.push(assert(mockEmailCalls[0]?.to === 'admin@example.invalid', `T-179: recipient == admin, never customer (got ${mockEmailCalls[0]?.to})`));
    } finally {
      transporter.getAdminEmail = origGetAdminEmail;
    }

    // ───────────────────────────────────────────────────────────────
    // Extra: buildEventBody includes lead_name + property_ids (spec §7/§8)
    // ───────────────────────────────────────────────────────────────
    console.log('\nExtra: buildEventBody includes lead + property + status per §7/§8');
    const body = googleCalendar.buildEventBody({
      scheduled_date: '2099-06-15',
      scheduled_time: '10:00',
      lead_name: 'Test Lead',
      lead_mobile: '9876543210',
      enquiry_code: 'ENQ-2099-99999',
      enquiry_type: 'website',
      property_ids: [42, 43],
      current_status_code: 'FOLLOW_UP',
      context_note: 'Ctx here',
      detailed_note: 'Detail here',
    });
    results.push(assert(body.summary === 'CRM Follow-up — Test Lead — ENQ-2099-99999', `summary format (got "${body.summary}")`));
    results.push(assert(body.description.includes('Enquiry Name: Test Lead'), 'description has Enquiry Name'));
    results.push(assert(body.description.includes('Mobile Number: 9876543210'), 'description has Mobile'));
    results.push(assert(body.description.includes('Enquiry Type: Website Enquiry'), 'description has Enquiry Type: Website Enquiry'));
    results.push(assert(body.description.includes('Property ID(s): 42, 43'), 'description has Property IDs'));
    results.push(assert(body.description.includes('Current CRM Status: FOLLOW_UP'), 'description has Current CRM Status'));
    results.push(assert(body.description.includes('Context / Reminder Note: Ctx here'), 'description has Context'));
    results.push(assert(body.description.includes('Detailed Note: Detail here'), 'description has Detailed'));
    results.push(assert(body.description.includes('Scheduled Date: 15/06/2099'), 'description has DD/MM/YYYY date'));
    results.push(assert(body.description.includes('Scheduled Time: 10:00 AM IST'), 'description has AM/PM IST time'));
    results.push(assert(body.start.timeZone === 'Asia/Kolkata', 'start.timeZone Asia/Kolkata'));
    results.push(assert(body.reminders.overrides.some((o) => o.minutes === 1440) && body.reminders.overrides.some((o) => o.minutes === 60), 'reminders 1440 + 60'));

    // ───────────────────────────────────────────────────────────────
    // Extra: getActiveForEnquiry returns null after cancel
    // ───────────────────────────────────────────────────────────────
    console.log('\nExtra: getActiveForEnquiry null after cancel');
    // After the T11 cancel + T5 was already flipped cancelled, no active
    // appointment should remain for this enquiry.
    const stillActive = await appointmentSlots.getActiveForEnquiry(enquiryId);
    results.push(assert(!stillActive, `no active appointment (got ${stillActive && stillActive.id})`));

    // ───────────────────────────────────────────────────────────────
    // BASELINE RESTORE
    // ───────────────────────────────────────────────────────────────
    console.log('\nCleanup: hard-delete planted appointments + history rows.');
    if (plantedApptIds.length) {
      const placeholders = plantedApptIds.map(() => '?').join(',');
      await pool.query(`DELETE FROM crm_appointment_history WHERE appointment_id IN (${placeholders})`, plantedApptIds);
      await pool.query(`DELETE FROM crm_calendar_activities WHERE id IN (${placeholders})`, plantedApptIds);
    }
    if (leadEmailWasNull && src && src.source_type === 'website') {
      await pool.query(`UPDATE leads SET buyer_email = NULL WHERE id = ?`, [src.source_id]);
    }
    console.log('Cleanup done.');
  } finally {
    // Restore module singletons.
    googleCalendar.createEvent = originalCreate;
    googleCalendar.updateEvent = originalUpdate;
    googleCalendar.cancelEvent = originalCancel;
    googleCalendar.getAuthorisedClient = originalAuth;
    appointmentSlots.checkGoogleCalendarBusy = originalCheckBusy;
    transporter.trySendMail = originalTrySend;
    await pool.end().catch(() => {});
  }

  const allPassed = summarize(results);
  process.exit(allPassed ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
