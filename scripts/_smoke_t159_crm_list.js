/**
 * T-2026-159 smoke: invoke enquiries.list() through the real service
 * layer to confirm the /admin/crm listing endpoint returns rows after
 * migration 105 backfilled crm_parents + crm_enquiries from the
 * historical `leads` + `enquiry_properties` sources.
 *
 * Usage: node scripts/_smoke_t159_crm_list.js
 *
 * Expected on the local dev DB (nasik_property_deals2, MariaDB 10.4.32
 * under D:\Xaamp 3\mysql\) after `node scripts/migrate.js`:
 *   total = 15   (13 website leads + 2 NPD enquiries with usable mobile)
 *   orphan_hidden = 0
 *
 * If total = 0, migration 105 did not run -- re-check schema_migrations.
 * If orphan_hidden > 0, a source row was soft-deleted after ingest --
 * inspect crm_enquiries for the offending source_id.
 */
require('dotenv').config();
const enquiries = require('../server/services/crm/enquiries');

(async () => {
  try {
    const res = await enquiries.list({ page: 1, pageSize: 50, unmasked: true });
    console.log('total=', res.total, 'orphan_hidden=', res.orphan_hidden, 'rows.length=', res.rows.length);
    res.rows.forEach((r, i) => {
      console.log(
        `  ${String(i + 1).padStart(2)}. ${r.enquiry_code}  [${r.source_type}]  ` +
        `name="${r.parent && r.parent.full_name || ''}"  ` +
        `mob=${r.parent && r.parent.normalized_mobile || ''}  ` +
        `email=${r.parent && r.parent.normalized_email || ''}  ` +
        `src_prop=${r.source_property_code || ''}  ` +
        `status=${r.status_code}`
      );
    });
  } catch (err) {
    console.error('SMOKE FAILED:', err.message);
    console.error(err.stack);
    process.exitCode = 1;
  }
  process.exit();
})();
