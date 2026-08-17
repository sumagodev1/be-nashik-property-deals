#!/usr/bin/env node
/**
 * T-2026-164 smoke harness: Google Calendar OAuth (Strategy B) live-mode.
 *
 * Coverage:
 *   T1  /api/google-calendar/status unauth        -> 401
 *   T2  /status authed (no row)                    -> connected:false
 *   T3  /connect authed                            -> auth_url + state,
 *                                                     URL has expected params
 *   T4  /callback ?state=<mismatched>              -> error redirect
 *   T5  /callback ?error=access_denied&state=<any> -> error redirect (user_denied)
 *   T6  mock token exchange -> upsertSingletonToken -> /status -> connected:true
 *   T7  createEvent (no token)                     -> PENDING NOT_CONNECTED
 *   T8  createEvent (mocked events.insert)         -> SYNCED with fake id
 *   T9  retry worker: seed PENDING -> runOnce mocked -> SYNCED persisted +
 *                                                       history denormalized
 *   T10 disconnect                                 -> row deleted
 *   T11 buildEventBody structure sanity (summary, IST, reminders)
 *   T12 combineIstToIso + addMinutesIst round-trip
 *
 * Restores DB baseline (token row + oauth_states rows + any planted
 * calendar activity) on exit so this script leaves zero side effects.
 */

require('dotenv').config();

const http = require('http');
const jwt = require('jsonwebtoken');
const { pool } = require('../server/db/pool');
const gcalDb = require('../server/db/queries/googleCalendar');
const gcal = require('../server/services/crm/googleCalendar');
const oauthSvc = require('../server/services/crm/googleCalendarOAuth');
const gcalWorker = require('../server/services/crm/googleCalendarSyncWorker');
const app = require('../app');

const PORT = 4111;
const BASE = `http://localhost:${PORT}`;

function req(method, path, { token, follow = false } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const options = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {},
    };
    if (token) options.headers.Authorization = `Bearer ${token}`;
    const rq = http.request(options, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        resolve({ status: res.statusCode, headers: res.headers, body });
      });
    });
    rq.on('error', reject);
    rq.end();
  });
}

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

async function main() {
  console.log('T-2026-164 smoke -- Google Calendar OAuth live-mode');
  console.log('====================================================\n');

  // 0. Baseline capture -----------------------------------------------
  const preTokenRow = await gcalDb.getSingletonToken();
  const [preStates] = await pool.query('SELECT id FROM google_calendar_oauth_states');
  // Capture full baseline of ALL crm_calendar_activities + linked
  // history.google_event_id so the worker step can't leave orphaned
  // mutations on pre-existing PENDING rows.
  const [preActivities] = await pool.query('SELECT id, sync_status, google_event_id, sync_last_attempt_at, sync_last_error FROM crm_calendar_activities');
  const [preHistoryGoogleIds] = await pool.query('SELECT id, google_event_id FROM crm_status_history WHERE google_event_id IS NOT NULL');
  if (preTokenRow) console.log('WARN: existing token row detected; will be restored.');
  console.log(`Baseline: token=${preTokenRow ? 'YES' : 'no'} oauth_states=${preStates.length} calendar_activities=${preActivities.length}\n`);

  // 1. Boot server ---------------------------------------------------
  // Force-disable the worker interval so it doesn't race the test.
  process.env.GOOGLE_CALENDAR_SYNC_WORKER_ENABLED = 'false';
  const server = app.listen(PORT);
  await new Promise((r) => server.on('listening', r));

  const results = [];
  let plantedActivityId = null;
  let plantedHistoryId = null;
  let plantedEnquiryId = null;

  try {
    // ---- T1: /status unauth -> 401 ----
    console.log('T1: GET /status unauth -> 401');
    const r1 = await req('GET', '/api/google-calendar/status');
    results.push(assert(r1.status === 401, `status=401 (got ${r1.status})`));

    // Build a JWT for a real admin. The seeded admin.id is inferred from the DB.
    const [adminRows] = await pool.query("SELECT id, email FROM admins LIMIT 1");
    if (!adminRows.length) throw new Error('No admin row -- run seed:admin first.');
    const adminId = adminRows[0].id;
    const adminEmail = adminRows[0].email;
    const adminToken = jwt.sign(
      { userId: adminId, id: adminId, email: adminEmail, role: 'admin' },
      process.env.JWT_ACCESS_SECRET,
      { expiresIn: '15m' },
    );

    // ---- T2: /status authed (no row) -> connected:false ----
    console.log('\nT2: GET /status authed (no row) -> connected:false');
    // If a prior token row exists we temporarily delete it for the test
    // and restore at the end.
    if (preTokenRow) await gcalDb.deleteSingletonToken();
    const r2 = await req('GET', '/api/google-calendar/status', { token: adminToken });
    const j2 = JSON.parse(r2.body);
    results.push(assert(r2.status === 200, `status 200 (got ${r2.status})`));
    results.push(assert(j2.connected === false, `connected=false (got ${j2.connected})`));
    results.push(assert(j2.calendar_id === (process.env.GOOGLE_CALENDAR_ID || 'primary'), `calendar_id (got ${j2.calendar_id})`));

    // ---- T3: /connect -> auth_url with all expected params ----
    console.log('\nT3: GET /connect -> auth_url with all expected params');
    const r3 = await req('GET', '/api/google-calendar/connect', { token: adminToken });
    const j3 = JSON.parse(r3.body);
    results.push(assert(r3.status === 200, `status 200 (got ${r3.status})`));
    results.push(assert(!!j3.auth_url, 'auth_url present'));
    results.push(assert(!!j3.state && j3.state.length === 64, `state present + 64 hex chars (got len ${j3.state && j3.state.length})`));
    const u3 = new URL(j3.auth_url);
    results.push(assert(u3.hostname === 'accounts.google.com', `hostname=accounts.google.com (got ${u3.hostname})`));
    results.push(assert(u3.searchParams.get('client_id') === process.env.GOOGLE_CLIENT_ID, 'client_id matches env'));
    results.push(assert(u3.searchParams.get('redirect_uri') === process.env.GOOGLE_REDIRECT_URI, 'redirect_uri matches env'));
    results.push(assert(u3.searchParams.get('access_type') === 'offline', 'access_type=offline'));
    results.push(assert(u3.searchParams.get('prompt') === 'consent', 'prompt=consent'));
    results.push(assert(String(u3.searchParams.get('scope')).includes('calendar.events'), 'scope includes calendar.events'));
    results.push(assert(u3.searchParams.get('state') === j3.state, 'state param on URL matches state field'));
    // Cleanup the seeded state row so it doesn't pollute the DB.
    await gcalDb.popOAuthState(j3.state);

    // ---- T4: /callback ?state=<mismatched> -> error redirect ----
    console.log('\nT4: GET /callback ?state=<mismatched> -> error redirect');
    const r4 = await req('GET', '/api/google-calendar/callback?code=fake&state=NOT-A-REAL-STATE-1234');
    results.push(assert(r4.status === 302, `status 302 (got ${r4.status})`));
    results.push(assert(String(r4.headers.location || '').includes('google_calendar=error'), 'redirect location has google_calendar=error'));
    results.push(assert(String(r4.headers.location || '').includes('reason=unknown_state'), 'redirect reason=unknown_state'));

    // ---- T5: /callback ?error=access_denied -> user_denied redirect ----
    console.log('\nT5: GET /callback ?error=access_denied -> error redirect (user_denied)');
    const r5 = await req('GET', '/api/google-calendar/callback?error=access_denied&state=whatever');
    results.push(assert(r5.status === 302, `status 302 (got ${r5.status})`));
    results.push(assert(String(r5.headers.location || '').includes('reason=user_denied'), 'reason=user_denied'));

    // ---- T6: mock token exchange -> upsertSingletonToken -> status flips ----
    console.log('\nT6: mock token exchange -> upsertSingletonToken -> status flips to connected:true');
    await gcalDb.upsertSingletonToken({
      refresh_token: 'FAKE_REFRESH_TOKEN_T164_SMOKE_' + Date.now(),
      access_token: 'FAKE_ACCESS_TOKEN_T164_SMOKE',
      access_token_expires_at: new Date(Date.now() + 55 * 60 * 1000),
      scope_granted: 'https://www.googleapis.com/auth/calendar.events',
      token_type: 'Bearer',
      connected_by_admin_id: adminId,
      connected_by_admin_email: adminEmail,
    });
    const r6 = await req('GET', '/api/google-calendar/status', { token: adminToken });
    const j6 = JSON.parse(r6.body);
    results.push(assert(j6.connected === true, `connected=true (got ${j6.connected})`));
    results.push(assert(j6.connected_by_admin_email === adminEmail, `email matches`));

    // ---- T7: createEvent (temporarily disconnected) -> PENDING NOT_CONNECTED ----
    console.log('\nT7: createEvent w/ no token row -> PENDING NOT_CONNECTED');
    await gcalDb.deleteSingletonToken();
    const r7 = await gcal.createEvent({
      scheduled_date: '2026-09-01',
      scheduled_time: '10:00',
      context_note: 'Smoke T7',
      detailed_note: 'Smoke test',
      enquiry_code: 'ENQ-2026-99999',
    });
    results.push(assert(r7.sync_status === 'PENDING', `sync_status=PENDING (got ${r7.sync_status})`));
    results.push(assert(r7.reason === 'NOT_CONNECTED', `reason=NOT_CONNECTED (got ${r7.reason})`));
    results.push(assert(r7.google_event_id === null, `google_event_id=null (got ${r7.google_event_id})`));

    // ---- T8: createEvent (mocked events.insert) -> SYNCED ----
    console.log('\nT8: createEvent w/ mocked events.insert -> SYNCED');
    // Re-plant the token row so getAuthorisedClient returns a client.
    await gcalDb.upsertSingletonToken({
      refresh_token: 'FAKE_REFRESH_TOKEN_T164_SMOKE_2',
      access_token: 'FAKE_ACCESS_TOKEN_T164_SMOKE_2',
      access_token_expires_at: new Date(Date.now() + 55 * 60 * 1000),
      scope_granted: 'https://www.googleapis.com/auth/calendar.events',
      token_type: 'Bearer',
      connected_by_admin_id: adminId,
      connected_by_admin_email: adminEmail,
    });
    // Monkeypatch googleapis at the module level: intercept events.insert.
    const googleapis = require('googleapis');
    const originalCalendar = googleapis.google.calendar;
    let capturedInsertBody = null;
    googleapis.google.calendar = function calendarMock(opts) {
      return {
        events: {
          insert: async ({ requestBody }) => {
            capturedInsertBody = requestBody;
            return { data: { id: 'evt_test_T164_1', summary: requestBody.summary } };
          },
        },
      };
    };
    const r8 = await gcal.createEvent({
      scheduled_date: '2026-09-01',
      scheduled_time: '10:00',
      context_note: 'Smoke T8 context',
      detailed_note: 'Smoke T8 detailed',
      enquiry_code: 'ENQ-2026-99999',
    });
    results.push(assert(r8.sync_status === 'SYNCED', `sync_status=SYNCED (got ${r8.sync_status})`));
    results.push(assert(r8.google_event_id === 'evt_test_T164_1', `google_event_id=evt_test_T164_1 (got ${r8.google_event_id})`));
    results.push(assert(!!capturedInsertBody, 'insert body captured'));
    results.push(assert(capturedInsertBody.start.timeZone === 'Asia/Kolkata', `start.timeZone=Asia/Kolkata (got ${capturedInsertBody.start.timeZone})`));
    results.push(assert(capturedInsertBody.start.dateTime === '2026-09-01T10:00:00+05:30', `start.dateTime IST (got ${capturedInsertBody.start.dateTime})`));
    results.push(assert(capturedInsertBody.end.dateTime === '2026-09-01T10:30:00+05:30', `end.dateTime = start+30min (got ${capturedInsertBody.end.dateTime})`));
    results.push(assert(capturedInsertBody.reminders.useDefault === false, 'reminders.useDefault=false'));
    results.push(assert(Array.isArray(capturedInsertBody.reminders.overrides) && capturedInsertBody.reminders.overrides.length === 2, 'reminders.overrides length 2'));
    const rems = capturedInsertBody.reminders.overrides.map((r) => r.minutes).sort((a, b) => a - b);
    results.push(assert(rems[0] === 60 && rems[1] === 1440, `reminders minutes = [60, 1440] (got [${rems.join(',')}])`));
    // T-2026-165 spec §7 supersedes the T-164 "summary=context_note"
    // behavior: when enquiry_code is present, the summary format is
    // "CRM Follow-up — {Name} — {enquiry_code}" (or "CRM Follow-up —
    // {enquiry_code}" when Name is absent). The context_note goes into
    // the "Context / Reminder Note" line of the description body.
    results.push(assert(capturedInsertBody.summary === 'CRM Follow-up — ENQ-2026-99999', `summary=T-165 §7 format (got "${capturedInsertBody.summary}")`));
    results.push(assert(String(capturedInsertBody.description || '').includes('Context / Reminder Note: Smoke T8 context'), 'description body has Context line with note'));
    results.push(assert(String(capturedInsertBody.description || '').includes('ENQ-2026-99999'), 'description includes enquiry_code footer'));

    // ---- T9: retry worker w/ seeded PENDING row ----
    console.log('\nT9: retry worker w/ seeded PENDING row -> SYNCED persisted');
    // Find any existing enquiry to attach a fake activity to. Use the first CRM enquiry.
    const [enqRows] = await pool.query('SELECT id, enquiry_code FROM crm_enquiries ORDER BY id LIMIT 1');
    if (!enqRows.length) {
      results.push(assert(false, 'need at least one crm_enquiries row for T9 (skipped)'));
    } else {
      plantedEnquiryId = enqRows[0].id;
      // Plant a PENDING calendar activity row.
      const [ins] = await pool.query(
        `INSERT INTO crm_calendar_activities
           (enquiry_id, scheduled_at, timezone, reminder_minutes_before_a, reminder_minutes_before_b,
            context_note, google_event_id, sync_status, created_by_admin_id)
         VALUES (?, ?, 'Asia/Kolkata', 1440, 60, 'T9 smoke context', NULL, 'PENDING', ?)`,
        [plantedEnquiryId, '2026-09-15 14:00:00', adminId],
      );
      plantedActivityId = ins.insertId;
      // Plant a linked history row.
      const [hins] = await pool.query(
        `INSERT INTO crm_status_history
           (enquiry_id, from_status, to_status, note, changed_by_admin_id, calendar_activity_id, google_event_id)
         VALUES (?, 'new', 'contacted', 'T9 smoke', ?, ?, NULL)`,
        [plantedEnquiryId, adminId, plantedActivityId],
      );
      plantedHistoryId = hins.insertId;

      // Re-arm the mock (already active from T8).
      googleapis.google.calendar = function calendarMock(opts) {
        return {
          events: {
            insert: async ({ requestBody }) => {
              return { data: { id: 'evt_test_T164_worker' } };
            },
          },
        };
      };
      const workerRes = await gcalWorker.runOnce();
      results.push(assert(workerRes && workerRes.processed >= 1, `worker processed >=1 (got ${workerRes && workerRes.processed})`));
      // Verify DB flip
      const [afterRows] = await pool.query('SELECT sync_status, google_event_id FROM crm_calendar_activities WHERE id=?', [plantedActivityId]);
      results.push(assert(afterRows[0].sync_status === 'SYNCED', `calendar_activities.sync_status=SYNCED (got ${afterRows[0].sync_status})`));
      results.push(assert(afterRows[0].google_event_id === 'evt_test_T164_worker', `calendar_activities.google_event_id set (got ${afterRows[0].google_event_id})`));
      // Verify denormalized column on history
      const [histAfter] = await pool.query('SELECT google_event_id FROM crm_status_history WHERE id=?', [plantedHistoryId]);
      results.push(assert(histAfter[0].google_event_id === 'evt_test_T164_worker', `history.google_event_id denorm (got ${histAfter[0].google_event_id})`));
    }

    // Restore original googleapis
    googleapis.google.calendar = originalCalendar;

    // ---- T10: disconnect -> row deleted, status flips ----
    console.log('\nT10: disconnect -> row deleted, status flips to connected:false');
    const disc = await oauthSvc.disconnect();
    results.push(assert(disc.disconnected === true, `disconnected=true (got ${disc.disconnected})`));
    const r10 = await req('GET', '/api/google-calendar/status', { token: adminToken });
    const j10 = JSON.parse(r10.body);
    results.push(assert(j10.connected === false, `post-disconnect connected=false (got ${j10.connected})`));

    // ---- T11: buildEventBody structure sanity ----
    console.log('\nT11: buildEventBody direct call (no network)');
    const body = gcal.buildEventBody({
      scheduled_date: '2026-10-05',
      scheduled_time: '15:30',
      context_note: '',
      detailed_note: 'Hello world',
      enquiry_code: 'ENQ-TEST',
    });
    // T-2026-165 spec §7: with enquiry_code present + no lead_name,
    // summary format is "CRM Follow-up — {enquiry_code}".
    results.push(assert(body.summary === 'CRM Follow-up — ENQ-TEST', `enquiry-code-only summary (got "${body.summary}")`));
    results.push(assert(String(body.description).includes('Hello world'), 'description includes detailed_note'));
    results.push(assert(String(body.description).includes('ENQ-TEST'), 'description includes enquiry_code'));
    results.push(assert(body.start.dateTime === '2026-10-05T15:30:00+05:30', `start.dateTime IST (got ${body.start.dateTime})`));
    results.push(assert(body.end.dateTime === '2026-10-05T16:00:00+05:30', `end.dateTime start+30 (got ${body.end.dateTime})`));

    // ---- T12: combineIstToIso + addMinutesIst round-trip ----
    console.log('\nT12: helpers combineIstToIso + addMinutesIst');
    const iso = gcal.combineIstToIso('2026-12-31', '23:45');
    results.push(assert(iso === '2026-12-31T23:45:00+05:30', `combine result (got ${iso})`));
    const plus15 = gcal.addMinutesIst(iso, 15);
    results.push(assert(plus15 === '2027-01-01T00:00:00+05:30', `+15min crosses year (got ${plus15})`));

  } finally {
    // Cleanup: drop planted rows first.
    if (plantedHistoryId) {
      try { await pool.query('DELETE FROM crm_status_history WHERE id=?', [plantedHistoryId]); } catch (_) {}
    }
    if (plantedActivityId) {
      try { await pool.query('DELETE FROM crm_calendar_activities WHERE id=?', [plantedActivityId]); } catch (_) {}
    }
    // Restore baseline of every pre-existing crm_calendar_activities row
    // that the T9 worker may have flipped from PENDING/FAILED to SYNCED.
    for (const pre of preActivities) {
      try {
        await pool.query(
          `UPDATE crm_calendar_activities
              SET sync_status = ?,
                  google_event_id = ?,
                  sync_last_attempt_at = ?,
                  sync_last_error = ?
            WHERE id = ?`,
          [pre.sync_status, pre.google_event_id, pre.sync_last_attempt_at, pre.sync_last_error, pre.id],
        );
      } catch (_) {}
    }
    // Restore baseline of crm_status_history.google_event_id (should be
    // all NULL before this smoke, but be defensive).
    try {
      await pool.query("UPDATE crm_status_history SET google_event_id = NULL WHERE google_event_id = 'evt_test_T164_worker'");
    } catch (_) {}
    for (const pre of preHistoryGoogleIds) {
      try {
        await pool.query('UPDATE crm_status_history SET google_event_id = ? WHERE id = ?', [pre.google_event_id, pre.id]);
      } catch (_) {}
    }
    // Restore baseline token row if it existed.
    try { await gcalDb.deleteSingletonToken(); } catch (_) {}
    if (preTokenRow) {
      try {
        await gcalDb.upsertSingletonToken({
          refresh_token: preTokenRow.refresh_token,
          access_token: preTokenRow.access_token,
          access_token_expires_at: preTokenRow.access_token_expires_at,
          scope_granted: preTokenRow.scope_granted,
          token_type: preTokenRow.token_type,
          connected_by_admin_id: preTokenRow.connected_by_admin_id,
          connected_by_admin_email: preTokenRow.connected_by_admin_email,
        });
      } catch (_) {}
    }
    // Clean up any oauth_states we didn't already pop.
    try { await pool.query('DELETE FROM google_calendar_oauth_states WHERE state LIKE ?', ['%whatever%']); } catch (_) {}
    server.close();
  }

  const ok = summarize(results);
  await pool.end().catch(() => {});
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error('SMOKE FAILED:', e && e.message);
  console.error(e && e.stack);
  process.exit(2);
});
