-- ============================================================================
-- 109_crm_lead_taxonomy.sql
--
-- T-2026-169 Phase A: Introduce the three-field CRM lead taxonomy
-- (Lead Stage / Lead Status / Lead Rating) alongside the legacy
-- crm_enquiries.status_code column that has served since T-2026-151.
--
-- USER REQUIREMENT (delegation §1-§2, §14-§18):
--   Replace the generic "CRM Status" with three independent fields:
--     A. Lead Stages  (master crm_lead_stage)
--          new (auto-ingest), follow_up, discussion, site_visit_requested,
--          site_visit_scheduled, site_visit_completed, converted_to_deal
--     B. Lead Status  (master crm_lead_status)
--          unattended (default), spoke, active, no_response, lost
--     C. Lead Rating  (master crm_lead_rating)
--          hot, warm, cold, not_interested (nullable)
--
-- DATA-PRESERVATION NON-NEGOTIABLE (delegation §2, §15, §16):
--   The existing crm_enquiries.status_code column MUST NOT be dropped in
--   the same release that adds the replacement. Historical records must
--   remain readable. This migration adds the three new columns as
--   additive fields with sensible defaults + back-fills them from the
--   existing status_code via a data-driven mapping table (below).
--
-- ADDITIVE SCHEMA CHANGES (all IF NOT EXISTS / IGNORE — re-run safe):
--   1. crm_enquiries.lead_stage_code   VARCHAR(64) NULL  -- default 'new'
--   2. crm_enquiries.lead_status_code  VARCHAR(64) NULL  -- default 'unattended'
--   3. crm_enquiries.lead_rating_code  VARCHAR(64) NULL  -- always nullable
--   4. crm_status_history.field_scope  VARCHAR(32) NOT NULL DEFAULT 'status'
--        — 'status' | 'lead_stage' | 'lead_status' | 'lead_rating' — lets
--        the history panel render a per-field timeline. Existing rows
--        default to 'status' so pre-T-169 history stays visible.
--   5. Three master vocabularies seeded via master_lookups.
--
-- HISTORICAL BACK-FILL MAPPING (delegation §16 "sensible mapping"):
--   Legacy status_code       -> lead_stage_code             -> lead_status_code
--   -----------------------   ----------------------------   -------------------
--   new                       -> new                         -> unattended
--   first_call_done           -> follow_up                   -> spoke
--   follow_up                 -> follow_up                   -> active
--   meeting_scheduled         -> discussion                  -> active
--   site_visit_scheduled      -> site_visit_scheduled        -> active
--   site_visit_done           -> site_visit_completed        -> active
--   negotiation               -> discussion                  -> active
--   booked                    -> converted_to_deal           -> active
--   closed_won                -> converted_to_deal           -> active
--   closed_lost               -> follow_up                   -> lost
--   on_hold                   -> follow_up                   -> no_response
--   (any other / null)        -> new                         -> unattended
--
--   Lead Rating cannot be inferred from a legacy status — left NULL for
--   admin classification.
--
--   Legacy status_code is PRESERVED verbatim so the T-166 auto-cancel-on-
--   CLOSED_WON/CLOSED_LOST logic (which reads status_code) continues to
--   fire. A follow-up migration will retire the legacy column once
--   downstream consumers migrate to reading lead_stage_code exclusively.
--
-- CONCURRENCY: All ALTERs are non-locking metadata operations in MariaDB
--   10.4 (InnoDB inplace ALGORITHM for ADD COLUMN + ADD INDEX).
--
-- No DELIMITER / CREATE PROCEDURE (per T-2026-157 lesson).
-- No DROP anywhere (additive-only forward migration).
-- ============================================================================

SET NAMES utf8mb4;

-- ------------------------------------------------------------------
-- (1) Add three new taxonomy columns to crm_enquiries
-- ------------------------------------------------------------------
ALTER TABLE crm_enquiries
  ADD COLUMN IF NOT EXISTS lead_stage_code VARCHAR(64) NULL DEFAULT 'new'
    COMMENT 'T-169: Lead Stage master code (crm_lead_stage). Nullable for legacy rows; default new on ingest.'
    AFTER status_code;

ALTER TABLE crm_enquiries
  ADD COLUMN IF NOT EXISTS lead_status_code VARCHAR(64) NULL DEFAULT 'unattended'
    COMMENT 'T-169: Lead Status master code (crm_lead_status). Nullable for legacy rows; default unattended on ingest.'
    AFTER lead_stage_code;

ALTER TABLE crm_enquiries
  ADD COLUMN IF NOT EXISTS lead_rating_code VARCHAR(64) NULL DEFAULT NULL
    COMMENT 'T-169: Lead Rating master code (crm_lead_rating). Nullable; admin sets during triage.'
    AFTER lead_status_code;

-- Indexes on the new codes so filter/search stays fast.
ALTER TABLE crm_enquiries
  ADD INDEX IF NOT EXISTS idx_enquiry_lead_stage  (lead_stage_code);
ALTER TABLE crm_enquiries
  ADD INDEX IF NOT EXISTS idx_enquiry_lead_status (lead_status_code);
ALTER TABLE crm_enquiries
  ADD INDEX IF NOT EXISTS idx_enquiry_lead_rating (lead_rating_code);

-- ------------------------------------------------------------------
-- (2) Extend crm_status_history with a field_scope discriminator
-- ------------------------------------------------------------------
-- Existing rows implicitly refer to the legacy status_code; default
-- 'status' preserves that semantics. New rows written by T-169's
-- extended changeStatus service carry field_scope IN ('lead_stage',
-- 'lead_status', 'lead_rating') so the History panel can render a
-- per-field timeline.
ALTER TABLE crm_status_history
  ADD COLUMN IF NOT EXISTS field_scope VARCHAR(32) NOT NULL DEFAULT 'status'
    COMMENT 'T-169: which field changed. status | lead_stage | lead_status | lead_rating. Pre-T-169 rows default to status.'
    AFTER to_status;

-- ------------------------------------------------------------------
-- (3) Seed the three CRM lead-taxonomy masters
-- ------------------------------------------------------------------
-- The generic services/masters/management.js LOOKUP_KEYS registry gets
-- these three keys wired in the SAME ticket (JS-side registration).
-- Seed rows here so both admin dropdowns and BE validation resolve
-- immediately post-migration.

-- Lead Stages (crm_lead_stage)
INSERT IGNORE INTO master_lookups (master_key, code, label, sort_order, is_active) VALUES
  ('crm_lead_stage', 'new',                     'New',                     5, 1),
  ('crm_lead_stage', 'follow_up',               'Follow-up',              10, 1),
  ('crm_lead_stage', 'discussion',              'Discussion',             20, 1),
  ('crm_lead_stage', 'site_visit_requested',    'Site Visit Requested',   30, 1),
  ('crm_lead_stage', 'site_visit_scheduled',    'Site Visit Scheduled',   40, 1),
  ('crm_lead_stage', 'site_visit_completed',    'Site Visit Completed',   50, 1),
  ('crm_lead_stage', 'converted_to_deal',       'Converted to Deal',      60, 1);

-- Lead Status (crm_lead_status)
INSERT IGNORE INTO master_lookups (master_key, code, label, sort_order, is_active) VALUES
  ('crm_lead_status', 'unattended',   'Unattended',   10, 1),
  ('crm_lead_status', 'spoke',        'Spoke',        20, 1),
  ('crm_lead_status', 'active',       'Active',       30, 1),
  ('crm_lead_status', 'no_response',  'No Response',  40, 1),
  ('crm_lead_status', 'lost',         'Lost',         50, 1);

-- Lead Rating (crm_lead_rating)
INSERT IGNORE INTO master_lookups (master_key, code, label, sort_order, is_active) VALUES
  ('crm_lead_rating', 'hot',            'Hot',             10, 1),
  ('crm_lead_rating', 'warm',           'Warm',            20, 1),
  ('crm_lead_rating', 'cold',           'Cold',            30, 1),
  ('crm_lead_rating', 'not_interested', 'Not Interested',  40, 1);

-- ------------------------------------------------------------------
-- (4) Back-fill lead_stage_code + lead_status_code from legacy status_code
-- ------------------------------------------------------------------
-- Only affects rows where the new columns are still their default
-- (post-ALTER new-column value is the DEFAULT). We use CASE mapping
-- so historical rows land on sensible taxonomy values without losing
-- their legacy status_code (which remains untouched for T-166 auto-
-- cancel semantics + backward compat).
UPDATE crm_enquiries
   SET lead_stage_code = CASE status_code
         WHEN 'new'                  THEN 'new'
         WHEN 'first_call_done'      THEN 'follow_up'
         WHEN 'follow_up'            THEN 'follow_up'
         WHEN 'meeting_scheduled'    THEN 'discussion'
         WHEN 'site_visit_scheduled' THEN 'site_visit_scheduled'
         WHEN 'site_visit_done'      THEN 'site_visit_completed'
         WHEN 'negotiation'          THEN 'discussion'
         WHEN 'booked'               THEN 'converted_to_deal'
         WHEN 'closed_won'           THEN 'converted_to_deal'
         WHEN 'closed_lost'          THEN 'follow_up'
         WHEN 'on_hold'              THEN 'follow_up'
         ELSE 'new'
       END,
       lead_status_code = CASE status_code
         WHEN 'new'                  THEN 'unattended'
         WHEN 'first_call_done'      THEN 'spoke'
         WHEN 'follow_up'            THEN 'active'
         WHEN 'meeting_scheduled'    THEN 'active'
         WHEN 'site_visit_scheduled' THEN 'active'
         WHEN 'site_visit_done'      THEN 'active'
         WHEN 'negotiation'          THEN 'active'
         WHEN 'booked'               THEN 'active'
         WHEN 'closed_won'           THEN 'active'
         WHEN 'closed_lost'          THEN 'lost'
         WHEN 'on_hold'              THEN 'no_response'
         ELSE 'unattended'
       END
 WHERE (lead_stage_code IS NULL OR lead_stage_code = 'new')
    OR (lead_status_code IS NULL OR lead_status_code = 'unattended');

-- Lead Rating stays NULL for all historical rows (cannot be inferred).
