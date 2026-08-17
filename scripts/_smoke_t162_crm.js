// T-2026-162 smoke: verify the CRM list surfaces every non-deleted
// enquiry_properties row (including the identity-less id=19) and
// that the JSON-first live projection returns the fresh Enquiry
// Person Details name/mobile/email rather than the stale
// owner_name / owner_contact columns.
//
// Usage: `node scripts/_smoke_t162_crm.js`  (ephemeral -- delete after run)

require('dotenv').config();
const { pool } = require('../server/db/pool');
const crmList = require('../server/services/crm/enquiries');

(async () => {
  try {
    const [[epCount]] = await pool.query(
      `SELECT COUNT(*) AS c FROM enquiry_properties WHERE deleted_at IS NULL`,
    );
    const [[leadsCount]] = await pool.query(
      `SELECT COUNT(*) AS c FROM leads WHERE deleted_at IS NULL`,
    );

    const res = await crmList.list({ page: 1, pageSize: 200, unmasked: true });
    const npdRows = res.rows.filter((r) => r.source_type === 'npd');
    const webRows = res.rows.filter((r) => r.source_type === 'website');

    console.log('== T-2026-162 smoke ==');
    console.log('enquiry_properties non-deleted:', epCount.c);
    console.log('CRM npd rows visible:          ', npdRows.length);
    console.log('leads non-deleted:             ', leadsCount.c);
    console.log('CRM website rows visible:      ', webRows.length);
    console.log('orphan_hidden:                 ', res.orphan_hidden);
    console.log('');
    console.log('== NPD rows (source_id, enquiry_code, live name/mobile/email) ==');
    for (const r of npdRows.sort((a, b) => a.source_id - b.source_id)) {
      console.log(
        `  src=${r.source_id}  ${r.enquiry_code}  parent=${JSON.stringify(r.parent?.full_name)}  mobile=${JSON.stringify(r.parent?.normalized_mobile)}  email=${JSON.stringify(r.parent?.normalized_email)}  is_orphan=${r.is_orphan}`,
      );
    }

    const pass = (npdRows.length === epCount.c) && (webRows.length === leadsCount.c);
    console.log('');
    console.log('T1 count parity:', pass ? 'PASS' : 'FAIL');

    // D2 check: find a row where owner_name != contacts[0].name and
    // confirm the DTO surfaces the JSON name.
    const [[edited]] = await pool.query(
      `SELECT id, owner_name, JSON_UNQUOTE(JSON_EXTRACT(details, '$.dynamicData.contacts[0].name')) AS json_name
         FROM enquiry_properties
        WHERE deleted_at IS NULL
          AND owner_name IS NOT NULL
          AND JSON_UNQUOTE(JSON_EXTRACT(details, '$.dynamicData.contacts[0].name')) IS NOT NULL
          AND JSON_UNQUOTE(JSON_EXTRACT(details, '$.dynamicData.contacts[0].name')) <> owner_name
        LIMIT 1`,
    );
    if (edited) {
      const row = npdRows.find((r) => r.source_id === edited.id);
      const jsonName = String(edited.json_name || '');
      const dtoName  = String(row?.parent?.full_name || '');
      const t2pass = row && dtoName === jsonName;
      console.log(`T2 JSON-first name projection (id=${edited.id}): owner_name=${JSON.stringify(edited.owner_name)}  json_name=${JSON.stringify(jsonName)}  dto=${JSON.stringify(dtoName)}  ->  ${t2pass ? 'PASS' : 'FAIL'}`);
    } else {
      console.log('T2 JSON-first name projection: SKIPPED (no divergent row in DB)');
    }
  } catch (err) {
    console.error('ERROR', err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
