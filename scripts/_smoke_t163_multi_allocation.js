// T-2026-163 smoke: Lead Allocation multi-source (Website + NPD
// independent checkboxes on same property).
//
// Runs acceptance tests T1..T8 end-to-end against the real DB via the
// service layer (addToEnquiry / removeFromEnquiry / listByProperty),
// mirroring exactly what the FE would call via POST /admin/crm/
// enquiries/:id/allocation/{add,remove} + GET /admin/crm/allocations/
// by-property.
//
// The property row used is a REAL inventory_properties row (picked as
// the newest to minimize collision with prior smoke runs). All
// mutations are done, verified, then unwound so the smoke is
// idempotent + non-destructive.
//
// Usage: `node scripts/_smoke_t163_multi_allocation.js`
//
// Convention (matches _smoke_t162_crm.js): kept in-tree post-ship so a
// future ticket can re-run for regression detection.

require('dotenv').config();
const { pool } = require('../server/db/pool');
const allocations = require('../server/services/crm/allocations');
const crmList = require('../server/services/crm/enquiries');

function print(...args) {
  // eslint-disable-next-line no-console
  console.log(...args);
}

async function q(sql, params) {
  const [rows] = await pool.query(sql, params);
  return rows;
}

(async () => {
  const results = { pass: 0, fail: 0, skipped: 0 };
  function record(label, ok, detail = '') {
    if (ok) {
      results.pass += 1;
      print(`  [PASS] ${label} ${detail}`);
    } else {
      results.fail += 1;
      print(`  [FAIL] ${label} ${detail}`);
    }
  }

  try {
    // ----------------------------------------------------------------
    // Pre-flight: pick 4 enquiries (2 Website + 2 NPD) + 1 property.
    // ----------------------------------------------------------------
    const websites = await q(
      `SELECT id, enquiry_code, source_id FROM crm_enquiries WHERE source_type='website' ORDER BY id LIMIT 2`,
    );
    const npds = await q(
      `SELECT id, enquiry_code, source_id FROM crm_enquiries WHERE source_type='npd' ORDER BY id LIMIT 2`,
    );
    const props = await q(
      `SELECT id, property_code FROM inventory_properties WHERE deleted_at IS NULL ORDER BY id DESC LIMIT 1`,
    );
    if (websites.length < 2 || npds.length < 2 || props.length < 1) {
      print('SKIPPED: need >=2 website + >=2 npd + >=1 property in DB.');
      return;
    }
    const [wA, wB] = websites;
    const [nC, nD] = npds;
    const prop = props[0];
    print('== T-2026-163 smoke ==');
    print(`Test property:  id=${prop.id}  code=${prop.property_code}`);
    print(`Website A:      id=${wA.id}  code=${wA.enquiry_code}`);
    print(`Website B:      id=${wB.id}  code=${wB.enquiry_code}`);
    print(`NPD C:          id=${nC.id}  code=${nC.enquiry_code}`);
    print(`NPD D:          id=${nD.id}  code=${nD.enquiry_code}`);
    print('');

    // Baseline: capture current interested_property_ids for all 4 so we
    // can restore. Also stash any prior link to `prop.id` and remove it
    // for clean starting state.
    const baseline = new Map();
    for (const e of [wA, wB, nC, nD]) {
      const [row] = await q(
        `SELECT interested_property_ids FROM crm_enquiries WHERE id = ?`,
        [e.id],
      );
      baseline.set(e.id, row?.interested_property_ids);
      // Force clean start.
      await allocations.removeFromEnquiry({ enquiryId: e.id, propertyId: prop.property_code });
    }
    print('-- baseline captured; test property removed from all 4 enquiries --');
    print('');

    // Scope every assertion to the FOUR enquiries this test owns.
    //
    // The test only clears its own 4, but listByProperty legitimately returns
    // EVERY enquiry allocated to the property -- and the property it picks
    // (newest inventory row) may already be allocated to unrelated enquiries
    // by real usage. When that happens each count assertion inflates and the
    // test reports failures for data it never created. Filtering here makes
    // the test independent of whatever else lives in the database, which is
    // what a smoke test needs to be.
    const TEST_ENQUIRY_IDS = new Set([wA.id, wB.id, nC.id, nD.id]);
    const listMine = async () =>
      (await allocations.listByProperty({ propertyId: prop.property_code }))
        .filter((c) => TEST_ENQUIRY_IDS.has(c.id));

    const outsiders = (await allocations.listByProperty({ propertyId: prop.property_code }))
      .filter((c) => !TEST_ENQUIRY_IDS.has(c.id));
    if (outsiders.length) {
      print(`-- note: ${outsiders.length} pre-existing allocation(s) on this property from other enquiries `
        + `(${outsiders.map((o) => o.enquiry_code || o.id).join(', ')}); excluded from assertions --`);
      print('');
    }

    // T1: fresh -> select Website A + Website B only. Reload -> only
    // Website side has 2; NPD empty.
    print('T1: allocate Website A + Website B; NPD empty.');
    await allocations.addToEnquiry({ enquiryId: wA.id, propertyId: prop.property_code });
    await allocations.addToEnquiry({ enquiryId: wB.id, propertyId: prop.property_code });
    let list = await listMine();
    const t1WebIds = list.filter((c) => c.source_type === 'website').map((c) => c.id).sort();
    const t1NpdIds = list.filter((c) => c.source_type === 'npd').map((c) => c.id);
    const t1Expected = [wA.id, wB.id].sort();
    record('T1 Website ids', JSON.stringify(t1WebIds) === JSON.stringify(t1Expected), `got=${JSON.stringify(t1WebIds)} expected=${JSON.stringify(t1Expected)}`);
    record('T1 NPD empty', t1NpdIds.length === 0, `got=${JSON.stringify(t1NpdIds)}`);
    record('T1 total', list.length === 2, `got=${list.length}`);
    print('');

    // T2: enable NPD too. Add NPD C + D. Reload -> Website A+B AND NPD C+D all present.
    print('T2: also allocate NPD C + NPD D; Website side untouched.');
    await allocations.addToEnquiry({ enquiryId: nC.id, propertyId: prop.property_code });
    await allocations.addToEnquiry({ enquiryId: nD.id, propertyId: prop.property_code });
    list = await listMine();
    const t2WebIds = list.filter((c) => c.source_type === 'website').map((c) => c.id).sort();
    const t2NpdIds = list.filter((c) => c.source_type === 'npd').map((c) => c.id).sort();
    const t2NpdExp = [nC.id, nD.id].sort();
    record('T2 Website ids preserved', JSON.stringify(t2WebIds) === JSON.stringify(t1Expected), `got=${JSON.stringify(t2WebIds)} expected=${JSON.stringify(t1Expected)}`);
    record('T2 NPD ids added', JSON.stringify(t2NpdIds) === JSON.stringify(t2NpdExp), `got=${JSON.stringify(t2NpdIds)} expected=${JSON.stringify(t2NpdExp)}`);
    record('T2 total = 4', list.length === 4, `got=${list.length}`);
    print('');

    // T3: uncheck Website B. Website reconcile does NOT touch NPD rows.
    print('T3: uncheck Website B -> Website reconcile must NOT touch NPD.');
    await allocations.removeFromEnquiry({ enquiryId: wB.id, propertyId: prop.property_code });
    list = await listMine();
    const t3WebIds = list.filter((c) => c.source_type === 'website').map((c) => c.id).sort();
    const t3NpdIds = list.filter((c) => c.source_type === 'npd').map((c) => c.id).sort();
    record('T3 Website A only', JSON.stringify(t3WebIds) === JSON.stringify([wA.id]), `got=${JSON.stringify(t3WebIds)}`);
    record('T3 NPD untouched', JSON.stringify(t3NpdIds) === JSON.stringify(t2NpdExp), `got=${JSON.stringify(t3NpdIds)} expected=${JSON.stringify(t2NpdExp)}`);
    record('T3 total = 3', list.length === 3, `got=${list.length}`);
    print('');

    // T4: uncheck NPD C. NPD reconcile does NOT touch Website.
    print('T4: uncheck NPD C -> NPD reconcile must NOT touch Website.');
    await allocations.removeFromEnquiry({ enquiryId: nC.id, propertyId: prop.property_code });
    list = await listMine();
    const t4WebIds = list.filter((c) => c.source_type === 'website').map((c) => c.id).sort();
    const t4NpdIds = list.filter((c) => c.source_type === 'npd').map((c) => c.id).sort();
    record('T4 Website A only', JSON.stringify(t4WebIds) === JSON.stringify([wA.id]), `got=${JSON.stringify(t4WebIds)}`);
    record('T4 NPD D only', JSON.stringify(t4NpdIds) === JSON.stringify([nD.id]), `got=${JSON.stringify(t4NpdIds)}`);
    record('T4 total = 2', list.length === 2, `got=${list.length}`);
    print('');

    // T5: fresh-read persistence.
    print('T5: explicit fresh reload persistence check.');
    list = await listMine();
    record('T5 fresh read matches T4', list.length === 2, `got=${list.length}`);
    print('');

    // T6: CRM listing carries the property CODE for each allocated enquiry.
    //
    // interested_property_ids stores globally-unique property_code strings,
    // not row ids. The assertions here used `.map(Number).includes(prop.id)`
    // from when it held integers -- Number('AKL-BNG-26-0XCQYR5') is NaN, so
    // that comparison can never be true again and this test would report a
    // false failure against correct code.
    print('T6: CRM list projection has property_code in each allocated row.');
    const crmRes = await crmList.list({ page: 1, pageSize: 200 });
    const targetWA = crmRes.rows.find((r) => r.id === wA.id);
    const targetND = crmRes.rows.find((r) => r.id === nD.id);
    record('T6 Website A carries property_code',
      Array.isArray(targetWA?.interested_property_ids) && targetWA.interested_property_ids.includes(prop.property_code),
      `got=${JSON.stringify(targetWA?.interested_property_ids)}`);
    record('T6 NPD D carries property_code',
      Array.isArray(targetND?.interested_property_ids) && targetND.interested_property_ids.includes(prop.property_code),
      `got=${JSON.stringify(targetND?.interested_property_ids)}`);
    print('');

    // T7: LIVE projection on listByProperty (T-162 flagged followup).
    print('T7: NPD JSON-first live projection on listByProperty.');
    const npdRow = list.find((c) => c.source_type === 'npd');
    if (!npdRow) {
      results.skipped += 1;
      print('  [SKIPPED] T7 no NPD row on this property');
    } else {
      const [[epRow]] = await pool.query(
        `SELECT ep.id, ep.owner_name,
                JSON_UNQUOTE(JSON_EXTRACT(ep.details, '$.dynamicData.contacts[0].name')) AS json_name,
                ep.details
           FROM crm_enquiries e
           JOIN enquiry_properties ep ON ep.id = e.source_id
          WHERE e.id = ?`,
        [npdRow.id],
      );
      if (!epRow) {
        results.skipped += 1;
        print('  [SKIPPED] T7 could not find backing enquiry_properties row');
      } else {
        const originalDetails = epRow.details;
        const marker = `T163-JSON-NAME-${Date.now()}`;
        const parsed = typeof originalDetails === 'string' ? JSON.parse(originalDetails) : (originalDetails || {});
        parsed.dynamicData = parsed.dynamicData || {};
        parsed.dynamicData.contacts = parsed.dynamicData.contacts && parsed.dynamicData.contacts.length
          ? parsed.dynamicData.contacts
          : [{}];
        parsed.dynamicData.contacts[0] = { ...(parsed.dynamicData.contacts[0] || {}), name: marker };
        await pool.query(
          `UPDATE enquiry_properties SET details = ? WHERE id = ?`,
          [JSON.stringify(parsed), epRow.id],
        );
        await pool.query(
          `UPDATE enquiry_properties SET owner_name = 'STALE-COLUMN-T163' WHERE id = ?`,
          [epRow.id],
        );
        const post = await allocations.listByProperty({ propertyId: prop.property_code, unmasked: true });
        const postRow = post.find((c) => c.id === npdRow.id);
        record('T7 listByProperty NPD name = JSON path (not stale column)',
          postRow?.parent?.full_name === marker,
          `got=${JSON.stringify(postRow?.parent?.full_name)}`);
        await pool.query(
          `UPDATE enquiry_properties SET details = ?, owner_name = ? WHERE id = ?`,
          [typeof originalDetails === 'string' ? originalDetails : JSON.stringify(originalDetails), epRow.owner_name, epRow.id],
        );
      }
    }
    print('');

    // T8: duplicate protection.
    print('T8: duplicate protection.');
    const dup = await allocations.addToEnquiry({ enquiryId: wA.id, propertyId: prop.property_code });
    record('T8 add duplicate returns ALREADY_PRESENT', dup.status === 'ALREADY_PRESENT', `got=${dup.status}`);
    const list8 = await listMine();
    const wACount = list8.filter((c) => c.id === wA.id).length;
    record('T8 no row duplication', wACount === 1, `got count=${wACount}`);
    print('');

    // Restore baseline.
    for (const e of [wA, wB, nC, nD]) {
      await allocations.removeFromEnquiry({ enquiryId: e.id, propertyId: prop.property_code });
    }
    for (const [id, prior] of baseline) {
      await pool.query(
        `UPDATE crm_enquiries SET interested_property_ids = ? WHERE id = ?`,
        [prior, id],
      );
    }
    print('-- baseline restored --');
    print('');

    print(`RESULTS: ${results.pass} PASS  ${results.fail} FAIL  ${results.skipped} SKIPPED`);
    if (results.fail > 0) process.exitCode = 1;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('ERROR', err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
