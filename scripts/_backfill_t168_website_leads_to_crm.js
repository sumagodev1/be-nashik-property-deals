/**
 * T-2026-168 backfill: for every `leads` row (Website Buyer Enquiry
 * surface) that DOES NOT already have a matching crm_enquiries row
 * (source_type='website' + source_id=leads.id), run the CRM ingest
 * hook so that /admin/crm shows the enquiry.
 *
 * Why this exists
 * ---------------
 * T-2026-156 attached the CRM ingestion hook on services/public/
 * leads.js#verify (Contact Seller / View Location), but the general
 * enquiry paths (services/public/general_enquiries.js#verify and
 * #submit) never had the hook. Any lead created via ContactPage's
 * "Send an Inquiry" or PropertyDetailPage's "Send Enquiry" form
 * ended up in /admin/leads but never in /admin/crm.
 *
 * The runtime hook is added in T-2026-168 (services/public/
 * crmIngestion.js reused by both leads.js and general_enquiries.js),
 * but historical rows that were missed still need to be projected
 * once. This script does the one-off backfill.
 *
 * Safety
 * ------
 *   - Idempotent: duplicateResolver.ingest is idempotent by
 *     (source_type, source_id) -- a lead that ALREADY has a
 *     matching crm_enquiries row is skipped by the WHERE NOT EXISTS
 *     clause, and a lead that races another ingest is deduplicated
 *     by the resolver's UNIQUE(source_type, source_id) semantics.
 *   - Dry-run by default: pass --apply to actually run the ingest.
 *     Without --apply, prints only the count + example IDs.
 *   - Bounded: skips soft-deleted rows (l.deleted_at IS NULL) so
 *     already-purged leads do not resurface in CRM.
 *   - PII-safe log: prints lead_id + action_type only. Never buyer
 *     name / mobile / email.
 *
 * Usage
 * -----
 *   node scripts/_backfill_t168_website_leads_to_crm.js          # dry-run
 *   node scripts/_backfill_t168_website_leads_to_crm.js --apply  # actually run
 */

'use strict';

const path = require('path');
const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const { pool } = require('../server/db/pool');
const crmResolver = require('../server/services/crm/duplicateResolver');

const APPLY = process.argv.includes('--apply');

async function findMissingLeads() {
  // Any non-deleted `leads` row without a matching crm_enquiries row
  // (source_type='website' AND source_id=leads.id) is a T-168 miss.
  const [rows] = await pool.query(
    `SELECT l.id,
            l.action_type,
            l.buyer_name,
            l.buyer_mobile,
            l.buyer_email,
            l.created_at
       FROM leads l
      WHERE l.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM crm_enquiries e
           WHERE e.source_type = 'website'
             AND e.source_id   = l.id
        )
      ORDER BY l.id ASC`,
  );
  return rows;
}

function pickIdentity(lead) {
  // Fields as duplicateResolver.ingest expects them. Empty strings
  // -> null so the resolver's normalizeMobile / normalizeEmail
  // treat them consistently.
  const buyerName = lead.buyer_name && String(lead.buyer_name).trim();
  const buyerMobile = lead.buyer_mobile && String(lead.buyer_mobile).trim();
  const buyerEmail = lead.buyer_email && String(lead.buyer_email).trim();
  return {
    full_name:   buyerName || null,
    mobile:      buyerMobile || null,
    email:       buyerEmail || null,
    source_type: 'website',
    source_id:   lead.id,
    status_code: 'new',
  };
}

async function main() {
  const missing = await findMissingLeads();
  const mode = APPLY ? 'APPLY' : 'DRY-RUN';
  // eslint-disable-next-line no-console
  console.log(`[T-168 backfill] mode=${mode} candidates=${missing.length}`);

  if (missing.length === 0) {
    // eslint-disable-next-line no-console
    console.log('[T-168 backfill] nothing to do -- every non-deleted lead already has a CRM row.');
    await pool.end();
    return;
  }

  // Print up to 10 example IDs so the operator can eyeball the set
  // before applying. No PII (only id + action_type + created_at).
  const preview = missing.slice(0, 10).map((r) => ({
    id: r.id,
    action_type: r.action_type,
    created_at: r.created_at,
  }));
  // eslint-disable-next-line no-console
  console.log('[T-168 backfill] preview (first 10):', preview);

  if (!APPLY) {
    // eslint-disable-next-line no-console
    console.log('[T-168 backfill] dry-run only. Re-run with --apply to project these leads into CRM.');
    await pool.end();
    return;
  }

  let ok = 0;
  let skipped = 0;
  let failed = 0;
  for (const lead of missing) {
    try {
      const res = await crmResolver.ingest(pickIdentity(lead));
      // status='INGESTED' with is_new_parent true = fresh parent
      // status='INGESTED' with is_new_parent false = attached to existing parent
      // status='DUPLICATE_CONFLICT' = staged for admin resolution (still counts as processed)
      if (res && res.status === 'INGESTED') {
        ok += 1;
        // eslint-disable-next-line no-console
        console.log(`[T-168 backfill] lead_id=${lead.id} -> enquiry_id=${res.enquiry_id} enquiry_code=${res.enquiry_code} new_parent=${res.is_new_parent}`);
      } else if (res && res.status === 'DUPLICATE_CONFLICT') {
        skipped += 1;
        // eslint-disable-next-line no-console
        console.log(`[T-168 backfill] lead_id=${lead.id} -> DUPLICATE_CONFLICT conflict_id=${res.conflict_id} (staged; resolve in /admin/crm)`);
      } else {
        skipped += 1;
        // eslint-disable-next-line no-console
        console.log(`[T-168 backfill] lead_id=${lead.id} -> unexpected status=${res && res.status}`);
      }
    } catch (err) {
      failed += 1;
      // eslint-disable-next-line no-console
      console.warn(`[T-168 backfill] lead_id=${lead.id} FAILED: ${err && err.message}`);
    }
  }

  // eslint-disable-next-line no-console
  console.log(`[T-168 backfill] done. ok=${ok} conflict=${skipped} failed=${failed} total=${missing.length}`);
  await pool.end();
}

main().catch(async (err) => {
  // eslint-disable-next-line no-console
  console.error('[T-168 backfill] fatal:', err && err.message);
  try { await pool.end(); } catch (_) { /* noop */ }
  process.exit(1);
});
