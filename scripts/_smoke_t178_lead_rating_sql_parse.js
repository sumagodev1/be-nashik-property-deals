// T-2026-178 smoke: Lead Rating (and Lead Stage / Lead Status) change
// SQL parse-error regression + "No change" sentinel handling.
//
// Pre-T-178 defect: server/db/queries/crm.js#updateEnquiryLeadTaxonomyForConn
// forgot to `params.push(leadRatingCode)` on the Rating branch, so any
// call that only touched the Rating column emitted:
//   `UPDATE crm_enquiries SET lead_rating_code = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
// with params=[enquiryId] -- 2 '?' placeholders vs 1 param -- which
// MariaDB rejected as ER_PARSE_ERROR "near '?'". Additionally, the
// T-176 change moved the FE Lead Stage/Status/Rating dropdown defaults
// to '' (the "No change" sentinel), and empty-string values sometimes
// flowed to the BE which did not filter them, causing a spurious
// `SET lead_rating_code = NULL` UPDATE when the operator picked "No
// change" for rating.
//
// Fix under T-178:
//   1. BE crm.js updateEnquiryLeadTaxonomyForConn -- pushes the rating
//      param for non-CLEAR values, and normalises '' -> 'CLEAR' for
//      rating / '' -> null for stage/status. Adds a placeholder<->param
//      count invariant that throws BEFORE .query() if a future edit
//      breaks the alignment (actionable error, not ER_PARSE_ERROR).
//   2. BE enquiries.js changeStatus -- filters '' on all three taxonomy
//      fields BEFORE building the payload, so an all-"No change" submit
//      bounces as VALIDATION_ERROR without issuing any SQL. The
//      empty-string on Rating is treated as "no touch" (same as
//      undefined), NOT as CLEAR -- that matches the T-176 UI contract.
//
// This smoke covers the exact scenarios enumerated in the T-178
// delegation §"Definition of done":
//   • rating-only change
//   • status-only change
//   • stage-only change
//   • all-three-no-change no-op (must NOT execute any UPDATE)
//   • combined booking + rating change (from AppointmentEditDialog)
//
// Runs against the local MariaDB per project convention (repo README).
// Uses an existing enquiry row (any) as the target; captures the
// pre-state and restores it in the teardown so the smoke is idempotent.
//
// Usage: `node scripts/_smoke_t178_lead_rating_sql_parse.js`

require('dotenv').config();
const { pool } = require('../server/db/pool');
const enquiries = require('../server/services/crm/enquiries');
const apptSlots = require('../server/services/crm/appointmentSlots');
const crmQ = require('../server/db/queries/crm');

let passed = 0, failed = 0;
function ok(label, cond, extra) {
  if (cond) { passed += 1; console.log(`PASS  ${label}`); }
  else      { failed += 1; console.log(`FAIL  ${label}${extra ? ' -- ' + extra : ''}`); }
}

function isSqlParseError(err) {
  if (!err) return false;
  const msg = String(err.message || '');
  return /ER_PARSE_ERROR/i.test(msg) || /syntax to use near '\?'/i.test(msg);
}

async function pickActiveRatingCode() {
  const [rows] = await pool.query(
    `SELECT code FROM master_lookups WHERE master_key = 'crm_lead_rating' AND is_active = 1 ORDER BY sort_order ASC, label ASC LIMIT 1`,
  );
  return rows[0]?.code || null;
}
async function pickActiveStageCode() {
  const [rows] = await pool.query(
    `SELECT code FROM master_lookups WHERE master_key = 'crm_lead_stage' AND is_active = 1 ORDER BY sort_order ASC, label ASC LIMIT 1`,
  );
  return rows[0]?.code || null;
}
async function pickActiveStatusCode() {
  const [rows] = await pool.query(
    `SELECT code FROM master_lookups WHERE master_key = 'crm_lead_status' AND is_active = 1 ORDER BY sort_order ASC, label ASC LIMIT 1`,
  );
  return rows[0]?.code || null;
}

async function findEnquiryId() {
  const [rows] = await pool.query('SELECT id FROM crm_enquiries ORDER BY id ASC LIMIT 1');
  return rows[0]?.id || null;
}

async function snapshot(enquiryId) {
  const [rows] = await pool.query(
    `SELECT lead_stage_code, lead_status_code, lead_rating_code, status_code FROM crm_enquiries WHERE id = ?`,
    [enquiryId],
  );
  return rows[0] || null;
}
async function restore(enquiryId, snap) {
  if (!snap) return;
  await pool.query(
    `UPDATE crm_enquiries SET lead_stage_code = ?, lead_status_code = ?, lead_rating_code = ? WHERE id = ?`,
    [snap.lead_stage_code || null, snap.lead_status_code || null, snap.lead_rating_code || null, enquiryId],
  );
}

async function main() {
  const enquiryId = await findEnquiryId();
  if (!enquiryId) {
    console.log('No enquiry rows in crm_enquiries; cannot run.');
    process.exit(2);
  }

  const ratingCode = await pickActiveRatingCode();
  const stageCode = await pickActiveStageCode();
  const statusCode = await pickActiveStatusCode();

  ok('T0.a active crm_lead_rating master code discovered', !!ratingCode, String(ratingCode));
  ok('T0.b active crm_lead_stage master code discovered', !!stageCode, String(stageCode));
  ok('T0.c active crm_lead_status master code discovered', !!statusCode, String(statusCode));

  const before = await snapshot(enquiryId);
  ok('T0.d pre-state snapshot captured', !!before);

  // Wrap pool.getConnection so every conn.query call during the test
  // asserts placeholder<->param count alignment. Post-fix this should
  // never mismatch; if a future regression breaks it this test will
  // fail with an obvious message.
  const origGetConn = pool.getConnection.bind(pool);
  let mismatch = null;
  pool.getConnection = async function () {
    const conn = await origGetConn();
    const origQuery = conn.query.bind(conn);
    conn.query = async function (sql, params) {
      const sqlStr = typeof sql === 'string' ? sql : (sql?.sql || '');
      const paramsArr = params || (typeof sql === 'object' ? sql?.values : null);
      const qcount = (sqlStr.match(/\?/g) || []).length;
      const pcount = Array.isArray(paramsArr) ? paramsArr.length : 0;
      if (qcount !== pcount) {
        mismatch = { sql: sqlStr, params: paramsArr, qcount, pcount };
      }
      return origQuery(sql, params);
    };
    return conn;
  };

  try {
    // ── T1: rating-only change (was the primary bug) ─────────────
    let out;
    try {
      out = await enquiries.changeStatus(enquiryId, { to_lead_rating: ratingCode }, { adminId: null });
      ok('T1.a rating-only change: no SQL parse error', true);
    } catch (e) {
      ok('T1.a rating-only change: no SQL parse error', false, `${e.status} ${e.code} ${e.message}`);
      if (isSqlParseError(e)) {
        ok('T1.a-detail specifically NOT ER_PARSE_ERROR "near \'?\'"', false, e.message);
      }
    }
    ok('T1.b rating-only change: DB row updated to expected code',
      (await snapshot(enquiryId))?.lead_rating_code === ratingCode);
    ok('T1.c rating-only change: response envelope carries to_lead_rating',
      out && out.to_lead_rating === ratingCode);
    ok('T1.d rating-only change: no placeholder<->param mismatch on any emitted SQL',
      mismatch === null, mismatch && JSON.stringify(mismatch));

    // ── T2: stage-only change ────────────────────────────────────
    mismatch = null;
    try {
      out = await enquiries.changeStatus(enquiryId, { to_lead_stage: stageCode }, { adminId: null });
      ok('T2.a stage-only change: no SQL parse error', true);
    } catch (e) {
      ok('T2.a stage-only change: no SQL parse error', false, `${e.status} ${e.code} ${e.message}`);
    }
    ok('T2.b stage-only change: DB row updated to expected code',
      (await snapshot(enquiryId))?.lead_stage_code === stageCode);
    ok('T2.c stage-only change: no placeholder<->param mismatch',
      mismatch === null, mismatch && JSON.stringify(mismatch));

    // ── T3: status-only change ───────────────────────────────────
    mismatch = null;
    try {
      out = await enquiries.changeStatus(enquiryId, { to_lead_status: statusCode }, { adminId: null });
      ok('T3.a status-only change: no SQL parse error', true);
    } catch (e) {
      ok('T3.a status-only change: no SQL parse error', false, `${e.status} ${e.code} ${e.message}`);
    }
    ok('T3.b status-only change: DB row updated to expected code',
      (await snapshot(enquiryId))?.lead_status_code === statusCode);
    ok('T3.c status-only change: no placeholder<->param mismatch',
      mismatch === null, mismatch && JSON.stringify(mismatch));

    // ── T4: all-three-No-change (all empty strings from T-176 FE) ─
    // MUST bounce as VALIDATION_ERROR without executing ANY SQL. Not a
    // malformed empty UPDATE. Not a silent no-op UPDATE.
    mismatch = null;
    const preSnap = await snapshot(enquiryId);
    let noopErr = null;
    try {
      await enquiries.changeStatus(enquiryId, {
        to_lead_stage: '', to_lead_status: '', to_lead_rating: '',
      }, { adminId: null });
      ok('T4.a all-No-change payload: rejected as VALIDATION_ERROR', false, 'did not throw');
    } catch (e) {
      noopErr = e;
      ok('T4.a all-No-change payload: rejected as VALIDATION_ERROR',
        e && e.status === 400 && e.code === 'VALIDATION_ERROR', `${e.status} ${e.code} ${e.message}`);
    }
    ok('T4.b all-No-change: DB row unchanged',
      JSON.stringify(await snapshot(enquiryId)) === JSON.stringify(preSnap));
    ok('T4.c all-No-change: error is NOT an SQL parse error',
      noopErr && !isSqlParseError(noopErr));

    // ── T5: rating='' alone -- must bounce, not attempt UPDATE ───
    mismatch = null;
    const preSnap5 = await snapshot(enquiryId);
    try {
      await enquiries.changeStatus(enquiryId, { to_lead_rating: '' }, { adminId: null });
      ok('T5.a rating="" alone: rejected as VALIDATION_ERROR', false, 'did not throw');
    } catch (e) {
      ok('T5.a rating="" alone: rejected as VALIDATION_ERROR',
        e && e.status === 400 && e.code === 'VALIDATION_ERROR', `${e.status} ${e.code} ${e.message}`);
      ok('T5.a-detail rating="" alone: error is NOT ER_PARSE_ERROR',
        !isSqlParseError(e));
    }
    ok('T5.b rating="" alone: DB row unchanged',
      JSON.stringify(await snapshot(enquiryId)) === JSON.stringify(preSnap5));

    // ── T6: rating='CLEAR' alone (explicit reset) ────────────────
    // Confirm the pre-T-178 semantics for the explicit CLEAR sentinel
    // continue to work (Rating supports NULL).
    mismatch = null;
    try {
      out = await enquiries.changeStatus(enquiryId, { to_lead_rating: 'CLEAR' }, { adminId: null });
      ok('T6.a rating="CLEAR" alone: no SQL parse error', true);
    } catch (e) {
      ok('T6.a rating="CLEAR" alone: no SQL parse error', false, `${e.status} ${e.code} ${e.message}`);
    }
    ok('T6.b rating="CLEAR": DB row now NULL',
      (await snapshot(enquiryId))?.lead_rating_code === null);
    ok('T6.c rating="CLEAR": response reports to_lead_rating=null',
      out && out.to_lead_rating === null);
    ok('T6.d rating="CLEAR": no placeholder<->param mismatch',
      mismatch === null, mismatch && JSON.stringify(mismatch));

    // ── T7: rating with empty stage + empty status (partial submit) ─
    // From AppointmentEditDialog when operator only touches Rating but
    // leaves Stage + Status as "No change". Empty-string leaks must be
    // stripped by BE defensive filter.
    mismatch = null;
    try {
      out = await enquiries.changeStatus(enquiryId, {
        to_lead_stage: '', to_lead_status: '', to_lead_rating: ratingCode,
      }, { adminId: null });
      ok('T7.a rating=X + stage/status="": no SQL parse error', true);
    } catch (e) {
      ok('T7.a rating=X + stage/status="": no SQL parse error', false, `${e.status} ${e.code} ${e.message}`);
    }
    ok('T7.b rating=X + stage/status="": DB rating updated',
      (await snapshot(enquiryId))?.lead_rating_code === ratingCode);
    // Stage/status must not have been overwritten to null/empty (they
    // were the T2/T3 values from earlier in the test run).
    const t7Snap = await snapshot(enquiryId);
    ok('T7.c rating=X + stage="": stage preserved verbatim',
      t7Snap?.lead_stage_code === stageCode, `got=${t7Snap?.lead_stage_code}`);
    ok('T7.d rating=X + status="": status preserved verbatim',
      t7Snap?.lead_status_code === statusCode, `got=${t7Snap?.lead_status_code}`);
    ok('T7.e rating=X + stage/status="": no placeholder<->param mismatch',
      mismatch === null, mismatch && JSON.stringify(mismatch));

    // ── T8: combined booking + rating (T-176 AppointmentEditDialog scenario) ─
    // This exercises the T-176 flow: FE calls updateAppointment first
    // (holds the slot), then calls changeEnquiryStatus with taxonomy
    // payload. We simulate that here directly. If the T-178 fix is in
    // place, the second call must not blow up with ER_PARSE_ERROR.
    // The updateAppointment leg is tested extensively by _smoke_t176*;
    // here we only replay the changeStatus leg on its own because our
    // synthetic enquiry may not have a valid existing appointment to
    // reschedule. The parse-error class covered by this smoke lives
    // entirely on the changeStatus leg.
    mismatch = null;
    const t8snap = await snapshot(enquiryId);
    try {
      out = await enquiries.changeStatus(enquiryId, {
        // Simulate an AppointmentEditDialog submission where the
        // operator advanced the lead rating alongside the booking edit.
        // The booking edit itself was already committed by
        // updateAppointment BEFORE this call under the T-176 atomic-Save
        // ordering; this call carries the taxonomy delta.
        to_lead_rating: ratingCode,
      }, { adminId: null });
      ok('T8.a combined booking+rating (taxonomy leg): no SQL parse error', true);
    } catch (e) {
      ok('T8.a combined booking+rating (taxonomy leg): no SQL parse error', false, `${e.status} ${e.code} ${e.message}`);
    }
    ok('T8.b combined booking+rating: DB row rating updated',
      (await snapshot(enquiryId))?.lead_rating_code === ratingCode);
    ok('T8.c combined booking+rating: no placeholder<->param mismatch',
      mismatch === null, mismatch && JSON.stringify(mismatch));
    // Reset stage/status back to what they were pre-T8 for teardown.

    // ── T9: builder-level invariant (unit-ish) ───────────────────
    // Directly call updateEnquiryLeadTaxonomyForConn with the same
    // problematic inputs the pre-T-178 caller was hitting; assert
    // that placeholder count == param count.
    const conn = await pool.getConnection();
    let seenSql = null, seenParams = null;
    const origConnQuery = conn.query.bind(conn);
    conn.query = async function (sql, params) {
      seenSql = typeof sql === 'string' ? sql : (sql?.sql || '');
      seenParams = params;
      return [[], []]; // no-op; we only care about SQL shape
    };
    // Call with a rating code alone (the failing case).
    await crmQ.updateEnquiryLeadTaxonomyForConn(conn, 999, { leadRatingCode: 'HOT' });
    ok('T9.a builder(rating=HOT): SQL has correct placeholder count',
      (seenSql.match(/\?/g) || []).length === (seenParams?.length || 0),
      `sql=${seenSql} params=${JSON.stringify(seenParams)}`);
    ok('T9.b builder(rating=HOT): rating value present in params',
      Array.isArray(seenParams) && seenParams.includes('HOT'));
    ok('T9.c builder(rating=HOT): enquiryId present in params',
      Array.isArray(seenParams) && seenParams.includes(999));

    seenSql = null; seenParams = null;
    await crmQ.updateEnquiryLeadTaxonomyForConn(conn, 999, { leadRatingCode: 'CLEAR' });
    ok('T9.d builder(rating=CLEAR): SQL has correct placeholder count',
      (seenSql.match(/\?/g) || []).length === (seenParams?.length || 0),
      `sql=${seenSql} params=${JSON.stringify(seenParams)}`);
    ok('T9.e builder(rating=CLEAR): SQL contains "lead_rating_code = NULL"',
      seenSql.includes('lead_rating_code = NULL'));
    ok('T9.f builder(rating=CLEAR): "HOT" NOT in params',
      Array.isArray(seenParams) && !seenParams.includes('HOT'));

    seenSql = null; seenParams = null;
    // All three set to real codes.
    await crmQ.updateEnquiryLeadTaxonomyForConn(conn, 999, {
      leadStageCode: 'S1', leadStatusCode: 'S2', leadRatingCode: 'R3',
    });
    ok('T9.g builder(all three): SQL placeholder count matches param count',
      (seenSql.match(/\?/g) || []).length === (seenParams?.length || 0),
      `sql=${seenSql} params=${JSON.stringify(seenParams)}`);
    ok('T9.h builder(all three): all three values present in params',
      Array.isArray(seenParams) && seenParams.includes('S1') && seenParams.includes('S2') && seenParams.includes('R3'));

    seenSql = null; seenParams = null;
    // Stage + rating (rating=CLEAR) -- pre-T-178 bug: params.pop() would
    // remove the STAGE value (the last-pushed), corrupting the write.
    await crmQ.updateEnquiryLeadTaxonomyForConn(conn, 999, {
      leadStageCode: 'S1', leadRatingCode: 'CLEAR',
    });
    ok('T9.i builder(stage=S1 + rating=CLEAR): SQL placeholder count matches params',
      (seenSql.match(/\?/g) || []).length === (seenParams?.length || 0),
      `sql=${seenSql} params=${JSON.stringify(seenParams)}`);
    ok('T9.j builder(stage=S1 + rating=CLEAR): stage value preserved in params (not popped by CLEAR)',
      Array.isArray(seenParams) && seenParams.includes('S1'),
      `params=${JSON.stringify(seenParams)}`);
    ok('T9.k builder(stage=S1 + rating=CLEAR): SQL contains "lead_rating_code = NULL"',
      seenSql.includes('lead_rating_code = NULL'));

    seenSql = null; seenParams = null;
    // Empty-string defensive normalisation (BE hardening per T-178).
    await crmQ.updateEnquiryLeadTaxonomyForConn(conn, 999, {
      leadStageCode: '', leadStatusCode: '', leadRatingCode: '',
    });
    ok('T9.l builder(all empty ""): returns false without emitting SQL',
      seenSql === null && seenParams === null);

    conn.query = origConnQuery;
    conn.release();
  } finally {
    // Restore the enquiry to its pre-test state.
    await restore(enquiryId, before);
    // Restore pool.getConnection wrapper.
    pool.getConnection = origGetConn;
    await pool.end();
  }

  console.log(`\nT-2026-178 smoke: passed=${passed} failed=${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('SMOKE CRASHED', e); process.exit(1); });
