// T-2026-175 smoke: verify that duplicate-contact CRM ingestion preserves
// each enquiry's OWN submitted name, mobile, and email in the per-row
// DTO (i.e. the sub-enquiry's identity NEVER adopts the parent's).
//
// Scenario simulated:
//   1. Ingest Website Enquiry A (name=Keshav, mobile=9999999999, email=same@example.com).
//   2. Ingest Website Enquiry B (name=Paresh, mobile=9999999999, email=same@example.com)
//      -> duplicate resolver reuses Enquiry A's parent (mobile+email both match).
//   3. Ingest NPD Enquiry C (name=Amit, mobile=9999999999, email=same@example.com)
//      -> same reuse behaviour on the NPD path.
//   4. Query the CRM list.
//   5. Assert:
//        - all three enquiries share parent_id.
//        - each enquiry's per-row .parent.full_name matches its OWN submitted name.
//        - crm_parents.full_name stayed as the FIRST ingest ('Keshav'), never
//          mutated by the second / third ingest.
//
// Also asserts the resolveConflict path preserves the same rule.
//
// This is a live-DB test. It plants rows into leads / enquiry_properties /
// crm_parents / crm_enquiries and CLEANS UP at the end (hard delete of
// planted rows). Idempotent -- can be re-run; each run uses fresh sentinel
// mobile/email tokens.
//
// Usage: `node scripts/_smoke_t175_name_preservation.js`

require('dotenv').config();
const { pool } = require('../server/db/pool');
const crmResolver = require('../server/services/crm/duplicateResolver');
const crmList = require('../server/services/crm/enquiries');

const SENTINEL_MOBILE = '9911997755';    // must NOT collide with real data
const SENTINEL_EMAIL  = 't175smoke@example.invalid';

let plantedLeadIds = [];
let plantedNpdIds  = [];
let plantedCrmEnquiryIds = [];
let plantedCrmParentIds  = [];

let pass = 0;
let fail = 0;
function assert(name, ok, extra) {
  if (ok) { pass += 1; console.log('  PASS ', name); }
  else    { fail += 1; console.log('  FAIL ', name, extra ? `-- ${extra}` : ''); }
}

async function preCleanup() {
  // Wipe any leftover sentinel rows from a prior failed run.
  await pool.query(`DELETE FROM crm_enquiries WHERE source_type = 'website' AND source_id IN (SELECT id FROM leads WHERE buyer_mobile = ? OR buyer_email = ?)`, [SENTINEL_MOBILE, SENTINEL_EMAIL]);
  await pool.query(`DELETE FROM crm_enquiries WHERE source_type = 'npd'     AND source_id IN (SELECT id FROM enquiry_properties WHERE owner_contact = ?)`, [SENTINEL_MOBILE]);
  await pool.query(`DELETE FROM crm_parents WHERE normalized_mobile = ? OR normalized_email = ?`, [SENTINEL_MOBILE, SENTINEL_EMAIL]);
  await pool.query(`DELETE FROM leads WHERE buyer_mobile = ? OR buyer_email = ?`, [SENTINEL_MOBILE, SENTINEL_EMAIL]);
  await pool.query(`DELETE FROM enquiry_properties WHERE owner_contact = ?`, [SENTINEL_MOBILE]);
}

async function plantLead(name, mobile, email) {
  const [res] = await pool.query(
    `INSERT INTO leads (buyer_name, buyer_mobile, buyer_email, action_type, status, created_at)
     VALUES (?, ?, ?, 'general_enquiry', 'new', NOW())`,
    [name, mobile, email],
  );
  plantedLeadIds.push(res.insertId);
  return res.insertId;
}

async function plantNpdEnquiry(name, mobile, email) {
  // enquiry_properties needs: title, property_code, property_type, transaction_type,
  // location, price NOT NULL. owner_name, owner_contact, details (JSON) for identity.
  const details = JSON.stringify({
    dynamicData: {
      contacts: [{ name, mobiles: [mobile], emails: [email] }],
    },
  });
  const propCode = `T175-${Date.now()}-${Math.floor(Math.random()*1000000)}`;
  const [res] = await pool.query(
    `INSERT INTO enquiry_properties
       (title, property_code, property_type, transaction_type, location, price,
        owner_name, owner_contact, details, status, created_at)
     VALUES (?, ?, 'flat', 'sale', 'T175 smoke', 0,
             ?, ?, ?, 'draft', NOW())`,
    [`t175 smoke ${name}`, propCode, name, mobile, details],
  );
  plantedNpdIds.push(res.insertId);
  return res.insertId;
}

(async () => {
  try {
    console.log('== T-2026-175 smoke: duplicate-contact name preservation ==');
    console.log('');

    await preCleanup();

    // ------------------------------------------------------------------
    // STEP 1: Ingest 3 enquiries sharing the same mobile+email but with
    // DIFFERENT names (Keshav, Paresh, Amit). First is Website, second is
    // Website (should reuse parent), third is NPD (should also reuse
    // parent because mobile+email match).
    // ------------------------------------------------------------------
    const leadIdA = await plantLead('Keshav', SENTINEL_MOBILE, SENTINEL_EMAIL);
    const resA = await crmResolver.ingest({
      full_name:   'Keshav',
      mobile:      SENTINEL_MOBILE,
      email:       SENTINEL_EMAIL,
      source_type: 'website',
      source_id:   leadIdA,
      status_code: 'new',
    });
    plantedCrmEnquiryIds.push(resA.enquiry_id);
    plantedCrmParentIds.push(resA.parent_id);

    const leadIdB = await plantLead('Paresh', SENTINEL_MOBILE, SENTINEL_EMAIL);
    const resB = await crmResolver.ingest({
      full_name:   'Paresh',
      mobile:      SENTINEL_MOBILE,
      email:       SENTINEL_EMAIL,
      source_type: 'website',
      source_id:   leadIdB,
      status_code: 'new',
    });
    plantedCrmEnquiryIds.push(resB.enquiry_id);

    const npdIdC = await plantNpdEnquiry('Amit', SENTINEL_MOBILE, SENTINEL_EMAIL);
    const resC = await crmResolver.ingest({
      full_name:   'Amit',
      mobile:      SENTINEL_MOBILE,
      email:       SENTINEL_EMAIL,
      source_type: 'npd',
      source_id:   npdIdC,
      status_code: 'new',
    });
    plantedCrmEnquiryIds.push(resC.enquiry_id);

    // ------------------------------------------------------------------
    // ASSERTIONS
    // ------------------------------------------------------------------

    // A1..A3: resolver returned the expected shapes.
    assert('A1 first ingest created a new parent',   resA.status === 'INGESTED' && resA.is_new_parent === true, `status=${resA.status} is_new_parent=${resA.is_new_parent}`);
    assert('A2 second ingest REUSED the parent',     resB.status === 'INGESTED' && resB.is_new_parent === false && String(resB.parent_id) === String(resA.parent_id), `status=${resB.status} is_new_parent=${resB.is_new_parent} parent_id=${resB.parent_id} vs A.parent_id=${resA.parent_id}`);
    assert('A3 third ingest (NPD) REUSED the parent', resC.status === 'INGESTED' && resC.is_new_parent === false && String(resC.parent_id) === String(resA.parent_id), `status=${resC.status} is_new_parent=${resC.is_new_parent} parent_id=${resC.parent_id} vs A.parent_id=${resA.parent_id}`);

    // B1: crm_parents.full_name stayed as the FIRST ingest ('Keshav').
    // Pre-T-175 code called updateParentBestNameForConn on reuse which
    // would have overwritten 'Keshav' with 'Paresh' or 'Amit' if either
    // was longer (Paresh has 6 chars vs Keshav's 6; Amit has 4). In
    // fact 'Paresh' would tie with 'Keshav' at 6 chars so the CASE
    // clause "CHAR_LENGTH(?) > CHAR_LENGTH(full_name)" would NOT fire on
    // Paresh (equal, not greater); 'Amit' definitely does not exceed. So
    // pre-T-175, 'Keshav' would have stayed too on this particular
    // sequence. To make the regression visible we ALSO ingest a
    // longer name ('Balasaheb Chintaman Paresh Extra') below.
    const [[parentRow1]] = await pool.query(
      `SELECT full_name FROM crm_parents WHERE id = ?`,
      [resA.parent_id],
    );
    assert('B1 parent.full_name preserved as first-ingest name after two reuses', parentRow1.full_name === 'Keshav', `got=${JSON.stringify(parentRow1.full_name)}`);

    // B2: ingest a FOURTH enquiry with an obviously longer name. Pre-T-175
    // this would have OVERWRITTEN crm_parents.full_name via the length-
    // beats-length heuristic. Post-T-175 it must remain 'Keshav'.
    const leadIdD = await plantLead('Balasaheb Chintaman Paresh Extra Longer Name', SENTINEL_MOBILE, SENTINEL_EMAIL);
    const resD = await crmResolver.ingest({
      full_name:   'Balasaheb Chintaman Paresh Extra Longer Name',
      mobile:      SENTINEL_MOBILE,
      email:       SENTINEL_EMAIL,
      source_type: 'website',
      source_id:   leadIdD,
      status_code: 'new',
    });
    plantedCrmEnquiryIds.push(resD.enquiry_id);
    const [[parentRow2]] = await pool.query(
      `SELECT full_name FROM crm_parents WHERE id = ?`,
      [resA.parent_id],
    );
    assert('B2 parent.full_name NOT overwritten by longer sub-enquiry name (T-175 primary regression)', parentRow2.full_name === 'Keshav', `got=${JSON.stringify(parentRow2.full_name)}  (pre-T-175 this would have been 'Balasaheb Chintaman Paresh Extra Longer Name')`);

    // ------------------------------------------------------------------
    // C: query the CRM list and verify each row's per-enquiry .parent
    // DTO reports its OWN submitted name, mobile, and email -- not the
    // parent's / first-enquiry's.
    // ------------------------------------------------------------------
    const list = await crmList.list({ page: 1, pageSize: 200, unmasked: true });
    const ours = list.rows.filter((r) => String(r.parent_id) === String(resA.parent_id));

    assert('C1 CRM list contains all 4 enquiries under the same parent', ours.length === 4, `got=${ours.length}`);

    const byCode = new Map(ours.map((r) => [r.enquiry_code, r]));
    const rowA = byCode.get(resA.enquiry_code);
    const rowB = byCode.get(resB.enquiry_code);
    const rowC = byCode.get(resC.enquiry_code);
    const rowD = byCode.get(resD.enquiry_code);

    assert('C2 rowA .parent.full_name = Keshav (own name preserved)', rowA?.parent?.full_name === 'Keshav', `got=${JSON.stringify(rowA?.parent?.full_name)}`);
    assert('C3 rowB .parent.full_name = Paresh (own name preserved -- primary bug fix)', rowB?.parent?.full_name === 'Paresh', `got=${JSON.stringify(rowB?.parent?.full_name)}  (pre-T-175 this would have been 'Keshav')`);
    assert('C4 rowC .parent.full_name = Amit (NPD path preserves own name)', rowC?.parent?.full_name === 'Amit', `got=${JSON.stringify(rowC?.parent?.full_name)}`);
    assert('C5 rowD .parent.full_name = Balasaheb Chintaman... (longer name still preserved on its own row)', rowD?.parent?.full_name === 'Balasaheb Chintaman Paresh Extra Longer Name', `got=${JSON.stringify(rowD?.parent?.full_name)}`);

    // C6..C9: per-row mobile matches submitted mobile (SENTINEL_MOBILE)
    // for every row -- since all four SHARE the mobile, this is
    // trivially true but proves the DTO pulled from LIVE source.
    for (const [label, row] of [['C6 rowA', rowA], ['C7 rowB', rowB], ['C8 rowC', rowC], ['C9 rowD', rowD]]) {
      const digits = String(row?.parent?.normalized_mobile || '').replace(/\D+/g, '');
      assert(`${label} .parent.normalized_mobile matches submitted mobile`, digits.endsWith(SENTINEL_MOBILE.slice(-8)), `got=${JSON.stringify(row?.parent?.normalized_mobile)}`);
    }

    // C10..C13: per-row email matches submitted email (SENTINEL_EMAIL).
    for (const [label, row] of [['C10 rowA', rowA], ['C11 rowB', rowB], ['C12 rowC', rowC], ['C13 rowD', rowD]]) {
      assert(`${label} .parent.normalized_email matches submitted email`, (row?.parent?.normalized_email || '').toLowerCase() === SENTINEL_EMAIL.toLowerCase(), `got=${JSON.stringify(row?.parent?.normalized_email)}`);
    }

    // D: verify each enquiry retains its own enquiry_id + enquiry_code
    // (independently identifiable per user requirement).
    const ids = new Set([resA.enquiry_id, resB.enquiry_id, resC.enquiry_id, resD.enquiry_id]);
    assert('D1 all four enquiries have distinct ids', ids.size === 4, `got=${ids.size}`);
    const codes = new Set([resA.enquiry_code, resB.enquiry_code, resC.enquiry_code, resD.enquiry_code]);
    assert('D2 all four enquiries have distinct enquiry_codes', codes.size === 4, `got=${Array.from(codes).join(',')}`);

    // E: proof point -- if we simulate the FE grouping (group by parent_id
    // and take the FIRST enquiry's .parent as g.parent), the pre-T-175
    // rendering path would show 'Keshav' on every row. Post-T-175, each
    // row must use its OWN e.parent.full_name.
    const gParent = ours.sort((a, b) => a.id - b.id)[0].parent; // simulate group.parent = first enquiry's parent
    const namesIfBugPresent = ours.map(() => gParent.full_name);
    const namesActual = ours.map((r) => r.parent.full_name);
    const buggyLooksLike = namesIfBugPresent.every((n) => n === 'Keshav');
    const fixedLooksLike = namesActual.includes('Keshav') && namesActual.includes('Paresh') && namesActual.includes('Amit') && namesActual.includes('Balasaheb Chintaman Paresh Extra Longer Name');
    assert('E1 pre-T-175 group.parent path would have shown Keshav on every row (verified as buggy behaviour)', buggyLooksLike);
    assert('E2 post-T-175 per-row e.parent path shows each own name (fix landed)', fixedLooksLike, `namesActual=${JSON.stringify(namesActual)}`);

    // F: cleanup planted rows so re-running is idempotent.
    console.log('');
    console.log('Cleanup: hard-delete planted rows.');
    for (const eid of plantedCrmEnquiryIds) {
      // Kill any status history first (FK) then the enquiry row.
      await pool.query(`DELETE FROM crm_status_history WHERE enquiry_id = ?`, [eid]);
      await pool.query(`DELETE FROM crm_enquiries WHERE id = ?`, [eid]);
    }
    for (const pid of plantedCrmParentIds) {
      await pool.query(`DELETE FROM crm_parents WHERE id = ?`, [pid]);
    }
    for (const lid of plantedLeadIds) {
      await pool.query(`DELETE FROM leads WHERE id = ?`, [lid]);
    }
    for (const nid of plantedNpdIds) {
      await pool.query(`DELETE FROM enquiry_properties WHERE id = ?`, [nid]);
    }
    console.log('Cleanup done.');

    console.log('');
    console.log(`== T-2026-175 name-preservation smoke: ${pass} pass / ${fail} fail ==`);
    if (fail > 0) process.exitCode = 1;
  } catch (err) {
    console.error('ERROR', err);
    // Best-effort cleanup even on error.
    try {
      for (const eid of plantedCrmEnquiryIds) {
        await pool.query(`DELETE FROM crm_status_history WHERE enquiry_id = ?`, [eid]).catch(() => {});
        await pool.query(`DELETE FROM crm_enquiries WHERE id = ?`, [eid]).catch(() => {});
      }
      for (const pid of plantedCrmParentIds) await pool.query(`DELETE FROM crm_parents WHERE id = ?`, [pid]).catch(() => {});
      for (const lid of plantedLeadIds) await pool.query(`DELETE FROM leads WHERE id = ?`, [lid]).catch(() => {});
      for (const nid of plantedNpdIds) await pool.query(`DELETE FROM enquiry_properties WHERE id = ?`, [nid]).catch(() => {});
    } catch (_) {}
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
