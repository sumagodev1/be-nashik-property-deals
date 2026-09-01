-- ============================================================================
-- 128_crm_lead_master_ids.sql
--
-- Store the CRM lead taxonomy as MASTER RECORD REFERENCES rather than as bare
-- strings, and repair one mis-cased historical value.
--
-- BACKGROUND
--   Migration 109 (T-2026-169) created the three vocabularies in master_lookups
--   (crm_lead_stage / crm_lead_status / crm_lead_rating) and three VARCHAR code
--   columns on crm_enquiries. The codes are already master codes rather than
--   free text, but nothing ties a lead row to the master ROW it came from.
--
-- WHAT THIS ADDS
--   crm_enquiries.lead_stage_id  -> master_lookups.id
--   crm_enquiries.lead_status_id -> master_lookups.id
--   crm_enquiries.lead_rating_id -> master_lookups.id  (nullable: rating is optional)
--
--   The three code columns are KEPT and kept in sync. They are not redundant:
--     - CrmList.jsx picks each chip's colour with a switch on the CODE
--       (stageClass / statusClass / ratingClass / statusDot), so the code is
--       what the UI reads to render;
--     - crm_status_history rows record from/to as codes and must stay
--       comparable with history written before this migration;
--     - the appointment confirmation email and the Google Calendar payload
--       both read codes today.
--   Dropping them would mean rewriting all of that for no gain, and would make
--   historical rows unreadable. The id is the authoritative reference; the code
--   is the denormalised display key, exactly as the project already does with
--   property_type_code alongside its master.
--
-- THE THREE MASTERS STAY INDEPENDENT
--   There is deliberately no combination/junction table and no parent_code
--   between them. Any active Stage may be saved with any active Status and any
--   active Rating; the backend validates that each id exists in its OWN
--   vocabulary and nothing more.
--
-- NO FOREIGN KEY CONSTRAINTS
--   Deliberate, and consistent with the rest of this schema
--   (master_property_forms references master codes without FKs either). The
--   masters service soft-deletes rather than hard-deletes, so referential
--   integrity is maintained in the service layer; a hard FK would instead make
--   an in-use master row undeletable at the engine level and break that flow.
--   The columns are indexed so joins stay fast.
--
-- INACTIVE VALUES REMAIN READABLE
--   A lead keeps pointing at its master row even if the admin later deactivates
--   it. Deactivating removes a value from the "choose a new one" lists; it must
--   not blank out leads already saved on it. Nothing here filters on is_active.
--
-- PORTABILITY: MySQL has no `ADD COLUMN IF NOT EXISTS` / `ADD INDEX IF NOT
--   EXISTS` — that is MariaDB-only, and this migration failed on a MySQL server
--   with a syntax error at exactly that clause. Every conditional DDL below
--   therefore uses the information_schema + PREPARE guard already established
--   by migration 063, which runs on both engines and keeps the re-run safety.
--
-- Additive only: no DROP, no column removal. Re-run safe throughout.
-- ============================================================================

SET NAMES utf8mb4;

-- ------------------------------------------------------------------
-- (1) Repair mis-cased rating codes BEFORE the backfill reads them
-- ------------------------------------------------------------------
-- One lead carries 'HOT' where the master row is 'hot'. Server-side this was
-- invisible: the column collates utf8mb4_unicode_ci, so 'HOT' = 'hot' in every
-- join and the backfill below would resolve it correctly anyway. The damage is
-- client-side, where comparisons ARE case-sensitive — CrmList.jsx ratingClass()
-- is a switch on the code, so 'HOT' fell through to a neutral grey chip, and
-- the Lead Rating <select> matches option values by string identity, so the
-- dropdown opened with nothing selected.
--
-- BINARY on both sides is required: without it the guard compares
-- case-insensitively, 'HOT' <> LOWER('HOT') is FALSE, and this updates nothing.
-- Only values whose lower-cased form actually exists in the master are touched,
-- so a genuinely unknown code is left for a human rather than bent into
-- something that merely looks valid.
UPDATE crm_enquiries e
   SET e.lead_rating_code = LOWER(e.lead_rating_code)
 WHERE e.lead_rating_code IS NOT NULL
   AND BINARY e.lead_rating_code <> BINARY LOWER(e.lead_rating_code)
   AND EXISTS (
         SELECT 1 FROM master_lookups m
          WHERE m.master_key = 'crm_lead_rating'
            AND BINARY m.code = BINARY LOWER(e.lead_rating_code)
            AND m.deleted_at IS NULL
       );

-- ------------------------------------------------------------------
-- (2) The three reference columns
-- ------------------------------------------------------------------
-- BIGINT UNSIGNED to match master_lookups.id (migration 026).
SET @c := (SELECT COUNT(*) FROM information_schema.columns
            WHERE table_schema = DATABASE() AND table_name = 'crm_enquiries'
              AND column_name = 'lead_stage_id');
SET @sql := IF(@c = 0,
  "ALTER TABLE crm_enquiries ADD COLUMN lead_stage_id BIGINT UNSIGNED NULL COMMENT 'master_lookups.id for master_key = crm_lead_stage. Authoritative reference; lead_stage_code is the denormalised display key.' AFTER lead_rating_code",
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c := (SELECT COUNT(*) FROM information_schema.columns
            WHERE table_schema = DATABASE() AND table_name = 'crm_enquiries'
              AND column_name = 'lead_status_id');
SET @sql := IF(@c = 0,
  "ALTER TABLE crm_enquiries ADD COLUMN lead_status_id BIGINT UNSIGNED NULL COMMENT 'master_lookups.id for master_key = crm_lead_status.' AFTER lead_stage_id",
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c := (SELECT COUNT(*) FROM information_schema.columns
            WHERE table_schema = DATABASE() AND table_name = 'crm_enquiries'
              AND column_name = 'lead_rating_id');
SET @sql := IF(@c = 0,
  "ALTER TABLE crm_enquiries ADD COLUMN lead_rating_id BIGINT UNSIGNED NULL COMMENT 'master_lookups.id for master_key = crm_lead_rating. NULL when no rating is set.' AFTER lead_status_id",
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @i := (SELECT COUNT(*) FROM information_schema.statistics
            WHERE table_schema = DATABASE() AND table_name = 'crm_enquiries'
              AND index_name = 'idx_enquiry_lead_stage_id');
SET @sql := IF(@i = 0,
  'ALTER TABLE crm_enquiries ADD INDEX idx_enquiry_lead_stage_id (lead_stage_id)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @i := (SELECT COUNT(*) FROM information_schema.statistics
            WHERE table_schema = DATABASE() AND table_name = 'crm_enquiries'
              AND index_name = 'idx_enquiry_lead_status_id');
SET @sql := IF(@i = 0,
  'ALTER TABLE crm_enquiries ADD INDEX idx_enquiry_lead_status_id (lead_status_id)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @i := (SELECT COUNT(*) FROM information_schema.statistics
            WHERE table_schema = DATABASE() AND table_name = 'crm_enquiries'
              AND index_name = 'idx_enquiry_lead_rating_id');
SET @sql := IF(@i = 0,
  'ALTER TABLE crm_enquiries ADD INDEX idx_enquiry_lead_rating_id (lead_rating_id)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ------------------------------------------------------------------
-- (3) Backfill from the existing codes
-- ------------------------------------------------------------------
-- Joined on code, so every lead ends up pointing at the master row whose label
-- it has been displaying all along — the displayed value does not change.
--
-- deleted_at IS NULL only: a soft-deleted master row is gone, and resolving to
-- it would resurrect a reference the admin removed. is_active is deliberately
-- NOT filtered — a lead sitting on a deactivated value must keep its reference,
-- per "inactive values remain readable" above.
--
-- A lead whose code matches no master row keeps a NULL id and its code. That is
-- visible (the id is NULL) rather than silently mapped to something plausible,
-- which is what a human needs in order to fix it.
UPDATE crm_enquiries e
  JOIN master_lookups m
    ON m.master_key = 'crm_lead_stage'
   AND m.code = e.lead_stage_code
   AND m.deleted_at IS NULL
   SET e.lead_stage_id = m.id
 WHERE e.lead_stage_code IS NOT NULL
   AND e.lead_stage_id IS NULL;

UPDATE crm_enquiries e
  JOIN master_lookups m
    ON m.master_key = 'crm_lead_status'
   AND m.code = e.lead_status_code
   AND m.deleted_at IS NULL
   SET e.lead_status_id = m.id
 WHERE e.lead_status_code IS NOT NULL
   AND e.lead_status_id IS NULL;

UPDATE crm_enquiries e
  JOIN master_lookups m
    ON m.master_key = 'crm_lead_rating'
   AND m.code = e.lead_rating_code
   AND m.deleted_at IS NULL
   SET e.lead_rating_id = m.id
 WHERE e.lead_rating_code IS NOT NULL
   AND e.lead_rating_id IS NULL;
