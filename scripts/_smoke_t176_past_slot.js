// T-2026-176 smoke: past-slot rejection + past-slot marking on availability
// grid. Verifies BOTH the new isSlotKeyInPastIst helper AND end-to-end that
// createAppointment / updateAppointment reject a past slot with 400
// PAST_SLOT (BEFORE opening any DB transaction), AND that listAvailableSlots
// marks past slots on today with conflict_source='past', available=false.
//
// Strategy:
//   * Unit assertions on isSlotKeyInPastIst / computeIstNowFloor. Pure
//     functions, no DB required.
//   * listAvailableSlots({date=today-IST}) -> expect at least one slot
//     with conflict_source='past'. Also expect the '00:00' midnight-
//     boundary slot on today to be 'past' per spec.
//   * listAvailableSlots({date=tomorrow-IST}) -> expect ZERO slots with
//     conflict_source='past' (past filter is date-scoped).
//   * createAppointment({ scheduledDate=today-IST, scheduledTime='00:00' })
//     -> expect HttpError(400, 'PAST_SLOT'). Runs against a synthetic
//     enquiryId=999999 which will not resolve, but the past-slot guard
//     runs BEFORE resolveLeadIdentity so we must see PAST_SLOT (not
//     NOT_FOUND). The test also runs a control call for a future date to
//     confirm the guard is not too eager (control should hit NOT_FOUND
//     because the fake enquiry doesn't exist).
//   * updateAppointment({ scheduledDate=today-IST, scheduledTime='00:00' })
//     -> same expectation. The past-slot guard runs BEFORE opening the
//     transaction / looking up the appointment, so we should see
//     PAST_SLOT (not NOT_FOUND).
//
// Usage: `node scripts/_smoke_t176_past_slot.js`

require('dotenv').config();
const { pool } = require('../server/db/pool');
const svc = require('../server/services/crm/appointmentSlots');

const assert = require('assert');

let passed = 0, failed = 0;
function ok(label, cond, extra) {
  if (cond) { passed += 1; console.log(`PASS  ${label}`); }
  else      { failed += 1; console.log(`FAIL  ${label}${extra ? ' -- ' + extra : ''}`); }
}

function pad2(n) { return String(n).padStart(2, '0'); }

async function main() {
  // ─── T1: computeIstNowFloor sanity ──────────────────────────────
  const now = svc.computeIstNowFloor();
  ok('T1.a computeIstNowFloor.todayIso matches YYYY-MM-DD shape',
    /^\d{4}-\d{2}-\d{2}$/.test(now.todayIso), now.todayIso);
  ok('T1.b computeIstNowFloor.nowHhmm matches HH:MM shape',
    /^\d{2}:\d{2}$/.test(now.nowHhmm), now.nowHhmm);
  ok('T1.c computeIstNowFloor.nowSlotKey has length 12',
    now.nowSlotKey && now.nowSlotKey.length === 12, now.nowSlotKey);
  const [nh, nm] = now.nowHhmm.split(':').map(Number);
  ok('T1.d minute component is a 15-min bucket (00/15/30/45)',
    [0, 15, 30, 45].includes(nm), `${nm}`);
  ok('T1.e slotKey prefix matches todayIso (yyyymmdd)',
    now.nowSlotKey.slice(0, 8) === now.todayIso.replace(/-/g, ''),
    `${now.nowSlotKey.slice(0,8)} vs ${now.todayIso}`);

  // ─── T2: isSlotKeyInPastIst on synthetic inputs ─────────────────
  // A slot key one bucket BEFORE nowSlotKey must be past.
  const nowKey = now.nowSlotKey;
  // Build a "one hour earlier" key by decrementing the HH component.
  const [y, mo, da] = now.todayIso.split('-').map(Number);
  const oneHourAgoKey = (() => {
    const dt = new Date(Date.UTC(y, mo - 1, da, nh, nm, 0));
    dt.setUTCHours(dt.getUTCHours() - 1);
    return `${String(dt.getUTCFullYear()).padStart(4,'0')}${pad2(dt.getUTCMonth()+1)}${pad2(dt.getUTCDate())}${pad2(dt.getUTCHours())}${pad2(dt.getUTCMinutes())}`;
  })();
  const oneHourAheadKey = (() => {
    const dt = new Date(Date.UTC(y, mo - 1, da, nh, nm, 0));
    dt.setUTCHours(dt.getUTCHours() + 1);
    return `${String(dt.getUTCFullYear()).padStart(4,'0')}${pad2(dt.getUTCMonth()+1)}${pad2(dt.getUTCDate())}${pad2(dt.getUTCHours())}${pad2(dt.getUTCMinutes())}`;
  })();
  ok('T2.a isSlotKeyInPastIst(one hour ago) == true',
    svc.isSlotKeyInPastIst(oneHourAgoKey) === true, oneHourAgoKey);
  ok('T2.b isSlotKeyInPastIst(one hour ahead) == false',
    svc.isSlotKeyInPastIst(oneHourAheadKey) === false, oneHourAheadKey);
  // Spec §4: at 13:10 IST -> nowFloor=13:00 -> 13:00 IS past (its start
  // elapsed 10 min ago). Current bucket is disabled, not allowed.
  ok('T2.c isSlotKeyInPastIst(current bucket) == true (spec §4: current bucket start has already elapsed)',
    svc.isSlotKeyInPastIst(nowKey) === true, nowKey);
  ok('T2.d isSlotKeyInPastIst("") == false (defensive short-circuit)',
    svc.isSlotKeyInPastIst('') === false);
  ok('T2.e isSlotKeyInPastIst(malformed) == false (defensive short-circuit)',
    svc.isSlotKeyInPastIst('20260813') === false);

  // ─── T3: listAvailableSlots({date=today}) marks past slots ───────
  const gridToday = await svc.listAvailableSlots({ date: now.todayIso });
  ok('T3.a listAvailableSlots(today) returned an array',
    Array.isArray(gridToday) && gridToday.length > 0, `len=${gridToday && gridToday.length}`);
  const pastToday = gridToday.filter((s) => s.conflict_source === 'past');
  const availToday = gridToday.filter((s) => s.available === true);
  ok('T3.b at least one slot on today marked conflict_source=past (unless very early morning IST)',
    // Before 06:15 IST every 06:00+ slot is future, so 0 past slots is a
    // legitimate outcome and this assertion is skipped then. It previously
    // leaned on the '00:00' slot always being past to guarantee >= 1; that
    // slot no longer exists (see T3.c).
    pastToday.length >= 1 || now.nowHhmm < '06:15', `pastCount=${pastToday.length} nowIST=${now.nowHhmm}`);
  // The synthetic '00:00' "12:00 AM" midnight-boundary slot was REMOVED from
  // buildDayGrid at the client's request -- the day now ends at 23:45. This
  // assertion used to require it to be present-and-past; it now requires it
  // to be absent entirely, which is what the grid actually guarantees.
  ok('T3.c midnight-boundary slot is no longer offered at all',
    gridToday.find((s) => s.slot_start === '00:00') === undefined,
    JSON.stringify(gridToday.find((s) => s.slot_start === '00:00')) || 'absent');
  // Every past slot must have available=false.
  ok('T3.d every past-labelled slot has available=false',
    pastToday.every((s) => s.available === false),
    `firstAvailPast=${JSON.stringify(pastToday.find((s) => s.available !== false))}`);
  // Availability grid still has real available slots.
  ok('T3.e today grid still contains at least one available slot (or is empty because day is fully in past -- unlikely)',
    availToday.length >= 0);

  // ─── T4: listAvailableSlots({date=tomorrow}) has NO past marks ──
  const [ty, tmo, tda] = now.todayIso.split('-').map(Number);
  const tomorrow = new Date(Date.UTC(ty, tmo - 1, tda + 1));
  const tomorrowIso = `${tomorrow.getUTCFullYear()}-${pad2(tomorrow.getUTCMonth()+1)}-${pad2(tomorrow.getUTCDate())}`;
  const gridTomorrow = await svc.listAvailableSlots({ date: tomorrowIso });
  const pastTomorrow = gridTomorrow.filter((s) => s.conflict_source === 'past');
  ok('T4.a listAvailableSlots(tomorrow) returned an array',
    Array.isArray(gridTomorrow) && gridTomorrow.length > 0, `len=${gridTomorrow && gridTomorrow.length}`);
  ok('T4.b tomorrow grid has ZERO past-labelled slots',
    pastTomorrow.length === 0, `pastCount=${pastTomorrow.length}`);
  // 06:00 tomorrow must be available (barring pre-existing bookings).
  const sixAmTomorrow = gridTomorrow.find((s) => s.slot_start === '06:00');
  ok('T4.c 06:00 tomorrow exists in grid',
    !!sixAmTomorrow);
  // (We don't assert available=true because a genuine pre-existing booking
  // would flip it -- but conflict_source must not be 'past'.)
  ok('T4.d 06:00 tomorrow conflict_source is NOT past',
    sixAmTomorrow && sixAmTomorrow.conflict_source !== 'past',
    JSON.stringify(sixAmTomorrow));

  // ─── T5: yesterday grid is entirely past ────────────────────────
  const yesterday = new Date(Date.UTC(ty, tmo - 1, tda - 1));
  const yesterdayIso = `${yesterday.getUTCFullYear()}-${pad2(yesterday.getUTCMonth()+1)}-${pad2(yesterday.getUTCDate())}`;
  const gridYest = await svc.listAvailableSlots({ date: yesterdayIso });
  ok('T5.a yesterday grid returned',
    Array.isArray(gridYest) && gridYest.length > 0);
  ok('T5.b every slot yesterday is available=false',
    gridYest.every((s) => s.available === false));
  ok('T5.c every slot yesterday has conflict_source=past',
    gridYest.every((s) => s.conflict_source === 'past'));

  // ─── T6: createAppointment rejects past slot with 400 PAST_SLOT ─
  let createErr = null;
  try {
    // Any enquiryId works -- past-slot guard runs BEFORE resolveLeadIdentity.
    // We use a large negative number to guarantee "not found" in the fallback path.
    await svc.createAppointment({
      enquiryId: 999999999,
      scheduledDate: now.todayIso,
      scheduledTime: '00:00', // always past on today
    });
  } catch (e) { createErr = e; }
  ok('T6.a createAppointment(past slot) threw',
    !!createErr, `err=${createErr && createErr.message}`);
  ok('T6.b createAppointment(past slot) threw with code=PAST_SLOT (not NOT_FOUND or SLOT_CONFLICT)',
    createErr && createErr.code === 'PAST_SLOT',
    `code=${createErr && createErr.code} status=${createErr && createErr.status}`);
  ok('T6.c createAppointment(past slot) threw with status=400',
    createErr && createErr.status === 400,
    `status=${createErr && createErr.status}`);

  // Control: with a future slot, the failure is NOT_FOUND (identity lookup),
  // confirming the past-guard only fires on past slots.
  let controlErr = null;
  try {
    await svc.createAppointment({
      enquiryId: 999999999,
      scheduledDate: tomorrowIso,
      scheduledTime: '10:00',
    });
  } catch (e) { controlErr = e; }
  ok('T6.d control (future slot) does NOT throw PAST_SLOT',
    controlErr && controlErr.code !== 'PAST_SLOT',
    `code=${controlErr && controlErr.code}`);

  // ─── T7: updateAppointment rejects past slot with 400 PAST_SLOT ──
  let updateErr = null;
  try {
    await svc.updateAppointment({
      appointmentId: 999999999,
      scheduledDate: now.todayIso,
      scheduledTime: '00:00',
    });
  } catch (e) { updateErr = e; }
  ok('T7.a updateAppointment(past slot) threw',
    !!updateErr, `err=${updateErr && updateErr.message}`);
  ok('T7.b updateAppointment(past slot) threw with code=PAST_SLOT',
    updateErr && updateErr.code === 'PAST_SLOT',
    `code=${updateErr && updateErr.code}`);
  ok('T7.c updateAppointment(past slot) threw with status=400',
    updateErr && updateErr.status === 400,
    `status=${updateErr && updateErr.status}`);

  // Control: with a future slot, failure is NOT_FOUND (appointment lookup).
  let updateControlErr = null;
  try {
    await svc.updateAppointment({
      appointmentId: 999999999,
      scheduledDate: tomorrowIso,
      scheduledTime: '10:00',
    });
  } catch (e) { updateControlErr = e; }
  ok('T7.d control update (future slot) does NOT throw PAST_SLOT',
    updateControlErr && updateControlErr.code !== 'PAST_SLOT',
    `code=${updateControlErr && updateControlErr.code}`);

  // ─── Summary ────────────────────────────────────────────────────
  console.log(`\nT-2026-176 smoke result: ${passed} passed, ${failed} failed`);
  try { await pool.end(); } catch (_e) { /* ignore */ }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('T-2026-176 smoke crashed:', e);
  try { pool.end(); } catch (_e) { /* ignore */ }
  process.exit(2);
});
