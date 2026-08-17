-- ============================================================
-- 104 - CRM listing becomes a LIVE PROJECTION over leads +
--       enquiry_properties; snapshot cache retired.
-- ============================================================
-- T-2026-156 (corrective for T-2026-151 Phase 1 + T-2026-155).
--
-- Problem this migration solves:
--   The Phase-1 CRM design stored an `ingestion_snapshot` JSON on
--   crm_enquiries + copied the parent's display fields onto
--   crm_parents at ingestion time. The FE listing rendered from
--   crm_parents (`full_name / normalized_mobile / normalized_email`),
--   which drifted from the live source (`leads` for Website,
--   `enquiry_properties` for NPD) any time the source row was renamed,
--   edited, or when smoke-test seed rows survived cleanup.
--
--   User reported the CRM listing showed "Al******" / "Bo******" rows
--   with source_ids (1001, 1002, 1099, 2001) that DO NOT resolve in
--   any real source table (max leads.id ~= 20, max enquiry_properties.id
--   ~= 21). These are Phase-1 smoke-test residue that T-2026-155 did
--   not catch (T-155 only removed source_type IN ('manual','test') with
--   NULL source_id; these rows have source_type IN ('website','npd')
--   with non-null but fake source_ids so they slipped through).
--
-- Fix (per T-2026-156 delegation):
--   1. Delete every CRM row whose source_id no longer resolves in its
--      declared source table (orphaned = fake or source-deleted). Also
--      delete the FK-cascaded history + calendar + conflict rows.
--   2. Delete every crm_parents that ends up with zero enquiries after
--      the orphan sweep (empty parent = seed residue).
--   3. Retire the `ingestion_snapshot` column. The CRM listing now
--      JOINs live source tables at read time (see
--      server/db/queries/crm.js#listEnquiries in the T-2026-156 diff)
--      so the snapshot is no longer a read source. Grepping FE + BE
--      confirmed zero remaining READ call-sites; the four remaining
--      writers (duplicateResolver.js + insertEnquiryForConn +
--      website_property/management.js + enquiry/management.js) are
--      updated in the same commit to stop passing `ingestion_snapshot`.
--
-- Idempotency: safe to re-run.
--   * DELETE ... WHERE NOT EXISTS(...) is a no-op the second time.
--   * DROP COLUMN uses `IF EXISTS` (MariaDB 10.0.2+) so re-running
--     after the first successful drop is a no-op instead of an error.
--     [T-2026-157 hotfix: the original stored-procedure guard used
--     `DELIMITER $$` which is a mysql CLI directive, not real SQL;
--     scripts/migrate.js uses mysql2 which forwards SQL straight to
--     MariaDB and rejects `DELIMITER $$` with a syntax error. Replaced
--     with the native `DROP COLUMN IF EXISTS` clause.]
--   * No table drops. No column renames. No breakage of any
--     T-2026-151..155 shipped behaviour.
--
-- Order matters:
--   Step 1 (orphan cleanup) MUST run BEFORE step 3 (drop column) so
--   that if step 3 fails on a driver quirk, at least the display data
--   is consistent for the new JOIN-based listing.
--
-- Sources referenced (both are the CANONICAL source-of-truth tables,
-- untouched by CRM):
--   * `leads` (migration 001) -- Website Buyer Enquiries. Columns:
--     id, buyer_name, buyer_mobile, buyer_email, website_property_id,
--     status, created_at, deleted_at.
--   * `enquiry_properties` (migration 048) -- NPD admin enquiries.
--     Columns: id, property_code, title, owner_name, owner_contact,
--     details JSON, created_at, deleted_at.
-- ============================================================

SET NAMES utf8mb4;

-- ------------------------------------------------------------------
-- 1) Delete orphaned WEBSITE enquiries (source_id has no row in
--    `leads` OR the leads row is soft-deleted).
-- ------------------------------------------------------------------
-- FK cascade on crm_status_history + crm_calendar_activities cleans
-- history + calendar rows automatically (see migration 101
-- fk_crm_hist_enquiry + fk_crm_cal_enquiry ON DELETE CASCADE).
DELETE e
  FROM crm_enquiries e
  LEFT JOIN leads l
    ON l.id = e.source_id
   AND l.deleted_at IS NULL
 WHERE e.source_type = 'website'
   AND l.id IS NULL;

-- ------------------------------------------------------------------
-- 2) Delete orphaned NPD enquiries (source_id has no row in
--    `enquiry_properties` OR the row is soft-deleted).
-- ------------------------------------------------------------------
DELETE e
  FROM crm_enquiries e
  LEFT JOIN enquiry_properties ep
    ON ep.id = e.source_id
   AND ep.deleted_at IS NULL
 WHERE e.source_type = 'npd'
   AND ep.id IS NULL;

-- ------------------------------------------------------------------
-- 3) Delete orphaned duplicate-conflict staging rows whose source_id
--    no longer resolves. These live outside crm_enquiries so cascade
--    does not touch them; we clean them by hand.
-- ------------------------------------------------------------------
DELETE c
  FROM crm_duplicate_conflicts c
  LEFT JOIN leads l
    ON l.id = c.source_id AND l.deleted_at IS NULL
 WHERE c.source_type = 'website'
   AND c.source_id IS NOT NULL
   AND l.id IS NULL
   AND c.resolved_at IS NULL;

DELETE c
  FROM crm_duplicate_conflicts c
  LEFT JOIN enquiry_properties ep
    ON ep.id = c.source_id AND ep.deleted_at IS NULL
 WHERE c.source_type = 'npd'
   AND c.source_id IS NOT NULL
   AND ep.id IS NULL
   AND c.resolved_at IS NULL;

-- ------------------------------------------------------------------
-- 4) Delete crm_parents rows that now have zero enquiries + zero
--    unresolved conflicts (empty parents are the tail-end of smoke
--    test residue -- Alice Smith / Bob Jones in the reported defect).
-- ------------------------------------------------------------------
DELETE p
  FROM crm_parents p
  LEFT JOIN crm_enquiries e ON e.parent_id = p.id
  LEFT JOIN crm_duplicate_conflicts ca ON ca.parent_a_id = p.id AND ca.resolved_at IS NULL
  LEFT JOIN crm_duplicate_conflicts cb ON cb.parent_b_id = p.id AND cb.resolved_at IS NULL
 WHERE e.id IS NULL
   AND ca.id IS NULL
   AND cb.id IS NULL;

-- ------------------------------------------------------------------
-- 5) Retire `ingestion_snapshot` -- CRM listing now JOINs live
--    sources at read time (see server/db/queries/crm.js#listEnquiries).
-- ------------------------------------------------------------------
-- Idempotent DROP COLUMN using MariaDB's native `IF EXISTS` clause
-- (supported since MariaDB 10.0.2; this project targets 10.4.32+).
-- Re-running after the first successful drop is a no-op instead of
-- an error.
--
-- T-2026-157 hotfix: the previous stored-procedure guard used
-- `DELIMITER $$` -- a mysql CLI directive that the mysql2 driver
-- does NOT preprocess, so MariaDB rejected it with a syntax error
-- on the first run (see scripts/migrate.js which does a single
-- conn.query(sql) with multipleStatements=true). This single-line
-- form uses only server-side SQL and works through mysql2 cleanly.
ALTER TABLE crm_enquiries DROP COLUMN IF EXISTS ingestion_snapshot;

-- ------------------------------------------------------------------
-- 6) Retire the display fields on crm_parents that were seeded once
--    at ingestion and never refreshed. The listing now reads
--    Name / Mobile / Email from the joined source row (`leads` or
--    `enquiry_properties`) so these become stale caches.
--
-- HOWEVER: `normalized_mobile` and `normalized_email` still serve as
-- the DUPLICATE-DETECTION KEYS for duplicateResolver.js (unique
-- indexes ux_parent_norm_mobile / ux_parent_norm_email). We MUST
-- keep them -- they're used for parent-identity, not display.
--
-- `full_name` is the only display-only column with no other purpose,
-- but we keep it too (no-cost) because:
--   a. Legacy tooling / manual DB queries may still reference it.
--   b. Dropping a NOT NULL DEFAULT '' column requires care around
--      MariaDB metadata locking on the second run of a hot deploy.
--   c. The FE listing SIMPLY IGNORES the parents.* display fields
--      after T-2026-156 (see enquiryDto in enquiries.js which now
--      pulls from live source columns).
-- So we do nothing to crm_parents here; the columns remain as
-- deduplication metadata + display fallback for legacy tooling.
-- ------------------------------------------------------------------

-- No further action.
