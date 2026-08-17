-- ============================================================
-- 103 - Restrict crm_enquiries.source_type + crm_parents.source_hint to
--       exactly ('website','npd')
-- ============================================================
-- T-2026-155 (corrective for T-2026-151 Phase 1).
--
-- Client requirement (source of truth, delivered 2026-08-11):
--   CRM must have EXACTLY two source types:
--     * 'website' -> ingested from Website Buyer Enquiry / Website Leads
--     * 'npd'     -> ingested from the admin NPD Enquiry Properties form
--   No third type. No standalone "manual CRM add" surface. No
--   independent CRM enquiry-type master. CRM is a projection over the
--   two real sources; it does NOT own records.
--
--   Under T-2026-151 Phase 1 the schema allowed a third value 'manual'
--   (see migration 101 crm_enquiries.source_type COMMENT and the
--   POST /admin/crm/enquiries manual-add endpoint). This corrective
--   ticket closes that off at both the DB layer (this migration) and
--   the BE layer (routes/admin/crm.js + services/crm/duplicateResolver.js).
--
-- What this migration does:
--   1. Deletes crm_enquiries rows whose source_type is NOT in
--      ('website','npd') via a normal DELETE (crm_status_history +
--      crm_calendar_activities cascade per migration 101 FKs).
--      Only 2 such rows exist in the live DB and both are Phase 1
--      smoke-test residue (source_id IS NULL, no admin engagement in
--      crm_status_history beyond the auto-generated initial-ingestion
--      row).
--   2. Adds a CHECK constraint enforcing source_type IN ('website','npd')
--      going forward. Idempotent: DROP IF EXISTS + ADD.
--   3. Normalizes crm_parents.source_hint = 'unknown' (or any other
--      non-website/non-npd value) to whichever of 'website' or 'npd'
--      appears in that parent's remaining crm_enquiries rows. If a
--      parent has both, keeps 'website' (per §16 spec, website is the
--      canonical inbound channel and NPD is the manual counterpart).
--      Does NOT add a CHECK on source_hint -- it's a first-seen HINT,
--      not a filter key, and the migration 101 default 'unknown' is
--      still valid for future-parent edge cases (e.g. a parent
--      manually resurrected after all its enquiries were CASCADE-
--      deleted).
--   4. Same-line cleanup of crm_duplicate_conflicts.source_type: any
--      stale unresolved conflict with source_type outside {website,npd}
--      is stripped (they can only have originated from the manual-add
--      code path which is being removed in this ticket).
--
-- Concurrency / safety:
--   * All operations are idempotent (DROP IF EXISTS + guarded DELETE +
--     conditional UPDATE). Re-running this migration is a no-op after
--     the first successful run.
--   * No table dropped. No column dropped. No existing legitimate
--     website/npd row touched.
--   * MariaDB 10.4.32 (per project reference-xampp-mariadb) supports
--     CHECK constraints natively (enforced since 10.2).
--
-- What this migration does NOT do:
--   * Does NOT drop the ingestion_snapshot column.
--   * Does NOT alter crm_enquiries.source_hint default (migration 101
--     already defaults to 'unknown' and that's still fine for parents
--     inserted before both enquiries are known).
--   * Does NOT introduce a new "crm_source_types" master table -- per
--     user's explicit direction the two allowed values are hardcoded
--     literals, not user-editable, not lookup-managed.
-- ============================================================

SET NAMES utf8mb4;

-- ------------------------------------------------------------------
-- 1) Clean up invalid crm_enquiries rows
-- ------------------------------------------------------------------
-- The FK from crm_status_history + crm_calendar_activities uses
-- ON DELETE CASCADE (migration 101), so deleting an enquiry row auto-
-- cleans its history + calendar entries. crm_parents rows are NOT
-- affected -- they stay so future ingestion can re-use them by mobile
-- or email match (case A / B / C in duplicateResolver.js).
DELETE FROM crm_enquiries
 WHERE source_type NOT IN ('website','npd');

-- ------------------------------------------------------------------
-- 2) Clean up duplicate conflicts with invalid source_type
-- ------------------------------------------------------------------
-- Both resolved AND unresolved rows are cleaned. Rationale:
--   * Unresolved with invalid source_type -- can only have originated
--     from the manual-add / smoke-test path being removed.
--   * Resolved with invalid source_type -- these were audit-trail rows
--     for a conflict that was already attached to a legitimate parent;
--     the source_type field on a resolved conflict is informational
--     only (the enquiry produced by resolveConflict lives in
--     crm_enquiries with its own source_type, which step 1 has already
--     restricted). Deleting the resolved conflict row does NOT delete
--     the resolved-into enquiry (no FK from enquiry back to conflict).
--   * Required so the CHECK constraint added in step 4 is not violated
--     by pre-existing bad data.
DELETE FROM crm_duplicate_conflicts
 WHERE source_type NOT IN ('website','npd');

-- ------------------------------------------------------------------
-- 3) Add / re-add the CHECK constraint on crm_enquiries.source_type
-- ------------------------------------------------------------------
-- MariaDB 10.4 syntax: ALTER TABLE ... DROP CONSTRAINT IF EXISTS is
-- supported (10.2+). ADD CONSTRAINT is standard.
ALTER TABLE crm_enquiries
  DROP CONSTRAINT IF EXISTS ck_crm_enq_source_type_allowed;

ALTER TABLE crm_enquiries
  ADD CONSTRAINT ck_crm_enq_source_type_allowed
      CHECK (source_type IN ('website','npd'));

-- ------------------------------------------------------------------
-- 4) Add / re-add the CHECK constraint on crm_duplicate_conflicts.source_type
-- ------------------------------------------------------------------
-- Same restriction so a future concurrent ingest that somehow feeds a
-- bad source_type can't slip through the conflict path either.
ALTER TABLE crm_duplicate_conflicts
  DROP CONSTRAINT IF EXISTS ck_crm_conflict_source_type_allowed;

ALTER TABLE crm_duplicate_conflicts
  ADD CONSTRAINT ck_crm_conflict_source_type_allowed
      CHECK (source_type IN ('website','npd'));

-- ------------------------------------------------------------------
-- 5) Normalize crm_parents.source_hint
-- ------------------------------------------------------------------
-- Best-effort: for each parent that currently has source_hint outside
-- {website,npd,unknown} (e.g. 'manual' or 'test' left over from Phase 1
-- smoke-test seeding), pick a hint from that parent's remaining
-- crm_enquiries. Website wins over NPD when both exist.
UPDATE crm_parents p
   SET p.source_hint = 'website'
 WHERE p.source_hint NOT IN ('website','npd','unknown')
   AND EXISTS (
     SELECT 1 FROM crm_enquiries e
      WHERE e.parent_id = p.id AND e.source_type = 'website'
   );

UPDATE crm_parents p
   SET p.source_hint = 'npd'
 WHERE p.source_hint NOT IN ('website','npd','unknown')
   AND EXISTS (
     SELECT 1 FROM crm_enquiries e
      WHERE e.parent_id = p.id AND e.source_type = 'npd'
   );

-- Any parent still on an invalid hint after the above (parent has no
-- surviving enquiries) falls back to 'unknown' -- the migration 101
-- default. Kept intentionally so nothing appears silently
-- misattributed on the UI.
UPDATE crm_parents
   SET source_hint = 'unknown'
 WHERE source_hint NOT IN ('website','npd','unknown');
