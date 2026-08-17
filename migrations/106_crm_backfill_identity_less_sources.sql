-- ============================================================
-- 106 - CRM: Backfill placeholder-parent overlay rows for source
--       enquiries that have NO Enquiry-Person identity captured yet
--       (owner_name / owner_contact BOTH NULL / blank, contacts JSON
--       empty). Ensures every non-deleted `enquiry_properties` row is
--       visible in /admin/crm even before the operator captures a
--       contact.
-- ============================================================
-- T-2026-162 (corrective for T-2026-151 Phase 1 + T-2026-159).
--
-- Problem this migration solves:
--   Migration 105 (T-2026-159) backfilled crm_parents + crm_enquiries
--   from every non-deleted `leads` row + every non-deleted
--   `enquiry_properties` row that had at least one usable identity
--   (mobile or email). Rows that had NEITHER a mobile NOR an email
--   (e.g., an admin who saved an NPD Enquiry Property draft before
--   filling the Enquiry Person Details section) were silently
--   excluded by the guard clauses:
--     * step 1: `WHERE t.norm_mobile IS NOT NULL`
--     * step 2: `WHERE t.norm_mobile IS NULL AND t.norm_email IS NOT NULL`
--   That mirrored the runtime `duplicateResolver.ingest` throw:
--     `if (!normalizedMobile && !normalizedEmail) throw CRM_INGEST_NO_KEY`
--   which the try/catch wrapper in
--   `services/enquiry/management.js#ingestIntoCrm` silently swallows so
--   the admin form-save never fails. Net effect: the row exists in
--   `enquiry_properties` but has NO overlay row in `crm_enquiries`
--   and is invisible in `/admin/crm`.
--
--   Concrete pre-fix example (nasik_property_deals2 on 2026-08-11):
--     SELECT COUNT(*) FROM enquiry_properties WHERE deleted_at IS NULL;
--     -> 4  (ids 19, 20, 21, 22)
--     SELECT COUNT(*) FROM crm_enquiries WHERE source_type='npd';
--     -> 3  (source_ids 20, 21, 22)
--     enquiry_properties.id=19 (property_code=NSK-FLT-26-LCKTZ9P,
--       owner_name=NULL, owner_contact=NULL, is_draft=1) had no
--       matching CRM row.
--
-- Fix (matches T-2026-162 runtime resolver relaxation):
--   For every non-deleted `enquiry_properties` (and `leads`) row that
--   (a) has no CRM overlay row yet AND (b) cannot be identified by
--   mobile or email at backfill time, create a fresh PLACEHOLDER
--   `crm_parents` row (normalized_mobile = NULL, normalized_email = NULL;
--   MySQL treats NULLs as distinct in UNIQUE indexes so multiple
--   placeholder parents coexist safely) plus the matching
--   `crm_enquiries` overlay + initial `crm_status_history` row.
--
--   Placeholder parent full_name is derived from the source row:
--     * NPD:     'Enquiry #<enquiry_properties.id>'
--     * Website: 'Lead #<leads.id>'
--
--   The runtime resolver's T-2026-162 no-identity branch (see
--   `services/crm/duplicateResolver.js`) uses the identical placeholder
--   convention so future ingest of a no-identity source row keeps the
--   same shape.
--
-- Non-destructive:
--   * Zero UPDATE on either source table.
--   * Zero DROP anywhere.
--   * INSERT IGNORE-style guards (NOT EXISTS on (source_type, source_id))
--     on the enquiry INSERT so a second run is a no-op.
--   * Session variable is used to hold the newly-inserted parent id
--     between the parent INSERT and the enquiry INSERT for a single row
--     (each source row processed independently via an intermediary
--     temp table so the sequence advances deterministically).
--
-- Idempotency guarantees:
--   Second run: WHERE NOT EXISTS filters out every row that was
--   inserted on the first run. The temp table used to stage the
--   backfill set is fully repopulated on each run so partial state
--   from a prior aborted run does not leak.
--
-- Sequence handling:
--   crm_enquiry_sequence.next_seq is advanced by GREATEST(existing,
--   start + N) after the batch, mirroring migration 105's guard so
--   runtime ingests never collide with backfilled codes.
--
-- Collation:
--   No JOIN on crm_parents.normalized_* in this migration (identity is
--   NULL by definition here), so no SESSION collation override is
--   needed. Still call SET NAMES for safety on the placeholder
--   full_name string comparisons.
-- ============================================================

SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ------------------------------------------------------------------
-- 1) Stage the backfill set: source rows that need a placeholder
--    parent + enquiry.
-- ------------------------------------------------------------------
-- Table structure:
--   source_type ('website' | 'npd')
--   source_id   (id in the source table)
--   placeholder_name  (derived; 'Enquiry #N' or 'Lead #N')
--   created_at  (from source row -- preserves temporal ordering)
DROP TEMPORARY TABLE IF EXISTS _t162_backfill_targets;
CREATE TEMPORARY TABLE _t162_backfill_targets (
  seq          BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  source_type  VARCHAR(16)    NOT NULL,
  source_id    BIGINT UNSIGNED NOT NULL,
  placeholder_name VARCHAR(255) NOT NULL,
  created_at   DATETIME       NOT NULL,
  parent_id    BIGINT UNSIGNED NULL,
  KEY ix_src (source_type, source_id)
) ENGINE=InnoDB CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Non-deleted enquiry_properties rows that have (a) no CRM overlay yet
-- AND (b) no usable identity (owner_name blank AND no >=10-digit
-- owner_contact AND no @-containing contacts JSON email).
INSERT INTO _t162_backfill_targets (source_type, source_id, placeholder_name, created_at)
SELECT 'npd',
       ep.id,
       CONCAT('Enquiry #', ep.id),
       ep.created_at
  FROM enquiry_properties ep
 WHERE ep.deleted_at IS NULL
   AND (ep.owner_name IS NULL OR TRIM(ep.owner_name) = '')
   AND (
     ep.owner_contact IS NULL
     OR CHAR_LENGTH(REGEXP_REPLACE(COALESCE(ep.owner_contact, ''), '[^0-9]', '')) < 10
   )
   AND (
     JSON_EXTRACT(ep.details, '$.dynamicData.contacts[0].emails[0]') IS NULL
     OR JSON_UNQUOTE(JSON_EXTRACT(ep.details, '$.dynamicData.contacts[0].emails[0]')) = ''
     OR JSON_UNQUOTE(JSON_EXTRACT(ep.details, '$.dynamicData.contacts[0].emails[0]')) NOT LIKE '%@%'
   )
   AND (
     JSON_EXTRACT(ep.details, '$.dynamicData.contacts[0].mobiles[0]') IS NULL
     OR CHAR_LENGTH(REGEXP_REPLACE(
         COALESCE(JSON_UNQUOTE(JSON_EXTRACT(ep.details, '$.dynamicData.contacts[0].mobiles[0]')), ''),
         '[^0-9]', '')) < 10
   )
   AND NOT EXISTS (
     SELECT 1 FROM crm_enquiries ce
      WHERE ce.source_type = 'npd' AND ce.source_id = ep.id
   );

-- Non-deleted leads rows same shape (defence-in-depth -- leads has
-- explicit buyer_mobile / buyer_email columns so this branch is
-- typically empty, but if a legacy row somehow persisted with both
-- blank, we still surface it).
INSERT INTO _t162_backfill_targets (source_type, source_id, placeholder_name, created_at)
SELECT 'website',
       l.id,
       CONCAT('Lead #', l.id),
       l.created_at
  FROM leads l
 WHERE l.deleted_at IS NULL
   AND (
     l.buyer_mobile IS NULL
     OR CHAR_LENGTH(REGEXP_REPLACE(COALESCE(l.buyer_mobile, ''), '[^0-9]', '')) < 10
   )
   AND (
     l.buyer_email IS NULL
     OR TRIM(l.buyer_email) = ''
     OR l.buyer_email NOT LIKE '%@%'
   )
   AND NOT EXISTS (
     SELECT 1 FROM crm_enquiries ce
      WHERE ce.source_type = 'website' AND ce.source_id = l.id
   );

-- ------------------------------------------------------------------
-- 2) Reserve the enquiry-code range up-front so we can assign codes
--    without a per-row round-trip.
-- ------------------------------------------------------------------
SET @year_prefix = CAST(YEAR(CURRENT_TIMESTAMP) AS CHAR);
SET @backfill_count = (SELECT COUNT(*) FROM _t162_backfill_targets);

-- Ensure the sequence row exists for the current year.
INSERT IGNORE INTO crm_enquiry_sequence (year_prefix, next_seq)
VALUES (@year_prefix, 1);

SET @start_seq = 0;
SELECT next_seq INTO @start_seq
  FROM crm_enquiry_sequence
 WHERE year_prefix = @year_prefix;

-- ------------------------------------------------------------------
-- 3) Insert one placeholder parent per staged row and remember its id
--    on the temp table so step 4 can reference it.
-- ------------------------------------------------------------------
-- Row-at-a-time via a cursor-less loop implemented with a session
-- variable + a repeated INSERT is possible but ugly; simpler approach:
-- INSERT ALL placeholders, then re-associate via a keyed insert result.
-- Cleanest MariaDB-friendly path: use a temp table row-by-row via
-- an ordered scan with INSERT ... SELECT and RETURNING? MariaDB 10.5+
-- supports INSERT ... RETURNING but 10.4.32 (this deployment) does
-- NOT. Fallback: use a stored-code-free approach -- insert parents
-- in one shot, then match them back by full_name (which is unique
-- per source row: 'Enquiry #<id>' / 'Lead #<id>').
--
-- CAVEAT: this reuse of full_name as a temporary correlation key is
-- ONLY safe because these placeholder names are constructed to be
-- globally unique per (source_type, source_id) pair. A real full_name
-- collision (an admin later renaming a genuine parent to
-- 'Enquiry #19') would confuse the correlation on subsequent
-- backfill runs -- but the second-run NOT EXISTS guard (step 4)
-- makes that path unreachable (the enquiry already exists so we
-- skip the parent INSERT for that source_id entirely).

INSERT INTO crm_parents (full_name, normalized_mobile, normalized_email, source_hint, created_at, updated_at)
SELECT t.placeholder_name, NULL, NULL, t.source_type, t.created_at, t.created_at
  FROM _t162_backfill_targets t
 WHERE NOT EXISTS (
   SELECT 1 FROM crm_enquiries ce
    WHERE ce.source_type = t.source_type AND ce.source_id = t.source_id
 );

-- Correlate temp rows -> newly-created parent ids by matching on
-- (source_hint, full_name). source_hint is set on insert to the
-- source_type, so the pair uniquely identifies the placeholder.
UPDATE _t162_backfill_targets t
  JOIN crm_parents p
    ON p.source_hint = t.source_type
   AND p.full_name   = t.placeholder_name
   AND p.normalized_mobile IS NULL
   AND p.normalized_email  IS NULL
   SET t.parent_id = p.id
 WHERE t.parent_id IS NULL;

-- ------------------------------------------------------------------
-- 4) Insert the crm_enquiries overlay row per staged source row.
-- ------------------------------------------------------------------
-- Enquiry code assignment: (@start_seq + row_number - 1), 5-digit
-- zero-padded. row_number derived from the temp table PK order.
INSERT INTO crm_enquiries
  (parent_id, enquiry_code, source_type, source_id, status_code, created_at, updated_at)
SELECT t.parent_id,
       CONCAT('ENQ-', @year_prefix, '-', LPAD(@start_seq + ROW_NUMBER() OVER (ORDER BY t.seq) - 1, 5, '0')),
       t.source_type,
       t.source_id,
       'new',
       t.created_at,
       t.created_at
  FROM _t162_backfill_targets t
 WHERE t.parent_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM crm_enquiries ce
      WHERE ce.source_type = t.source_type AND ce.source_id = t.source_id
   );

-- Advance the per-year sequence past every code we just consumed.
UPDATE crm_enquiry_sequence
   SET next_seq = GREATEST(next_seq, @start_seq + @backfill_count)
 WHERE year_prefix = @year_prefix;

-- ------------------------------------------------------------------
-- 5) Initial status_history row per enquiry (from NULL -> 'new').
-- ------------------------------------------------------------------
INSERT INTO crm_status_history
  (enquiry_id, from_status, to_status, note, changed_by_admin_id, calendar_activity_id, created_at)
SELECT e.id, NULL, 'new',
       'Initial ingestion (no identity captured yet)',
       NULL, NULL, e.created_at
  FROM crm_enquiries e
  JOIN _t162_backfill_targets t
    ON t.source_type = e.source_type
   AND t.source_id   = e.source_id
 WHERE NOT EXISTS (
   SELECT 1 FROM crm_status_history h
    WHERE h.enquiry_id = e.id AND h.from_status IS NULL
 );

-- ------------------------------------------------------------------
-- 6) Cleanup.
-- ------------------------------------------------------------------
DROP TEMPORARY TABLE IF EXISTS _t162_backfill_targets;
