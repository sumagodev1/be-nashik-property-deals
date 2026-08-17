-- ============================================================
-- 101 - CRM Module: Parents + Enquiries + Status History + Calendar Activities
-- ============================================================
-- T-2026-151 Phase 1 (Strategy-C stub for Google Calendar).
--
-- Introduces the CRM subsystem that replaces the old Leads menu. Combines
-- Website Buyer Enquiries + NPD (admin) Enquiry Persons into a single
-- Parent -> Sub-Enquiry data model:
--
--   crm_parents:
--     Unique person (normalized mobile OR email match => same parent).
--     One row per real-world lead. Carries name + normalized_mobile +
--     normalized_email + source hint. Deduped at insert time by the
--     duplicateResolver service (unique indexes here are the DB-side
--     backstop for the JS resolver).
--
--   crm_enquiries:
--     Individual enquiry occurrence attached to a parent. Every ingestion
--     (website_properties INSERT / enquiry_properties INSERT / manual
--     admin CRM add) produces exactly one crm_enquiries row. Carries the
--     unique enquiry_code (ENQ-YYYY-NNNNN), current status code, source
--     type + source id (nullable FK to the originating row), and the raw
--     ingestion snapshot as JSON so future changes to source rows do not
--     mutate the enquiry's historical context.
--
--   crm_status_history:
--     Immutable append-only log of every status change on an enquiry.
--     No UPDATE, no DELETE. Powers the "Enquiry History" panel.
--
--   crm_calendar_activities:
--     One row per follow-up scheduled from the status-change dialog.
--     Carries scheduled_at + reminder_minutes_before_a/b + context_note +
--     google_event_id (nullable) + sync_status. Strategy-C ships with
--     sync_status default 'PENDING' -- the googleCalendar service module
--     returns PENDING synchronously when GOOGLE_CALENDAR_MODE is not
--     'live'. When creds land, the same rows are picked up by a future
--     sync worker that fills google_event_id and flips sync_status.
--
--   crm_duplicate_conflicts:
--     Staged ingestions that hit spec section 75 (mobile matches Parent A
--     AND email matches Parent B, both different, non-null). Rather than
--     auto-merge (dangerous - could unify two real people), the resolver
--     inserts a conflict row for the admin to resolve via the Phase-2
--     conflict resolution UI. Payload JSON carries the full ingestion
--     context so no data is lost if the admin ignores the conflict for
--     days.
--
-- Concurrency safety (spec sections 9, 57, 75):
--   The duplicateResolver JS service wraps its "find or create parent"
--   query in a single BEGIN...COMMIT with SELECT ... FOR UPDATE on the
--   parent match. The unique indexes below (ux_parent_norm_mobile,
--   ux_parent_norm_email) are the DB-side backstop against races.
--
-- Backward compatibility:
--   Zero existing tables altered. Zero existing columns dropped or
--   renamed. Every new table CREATE guarded with IF NOT EXISTS so re-run
--   is a no-op. INSERT IGNORE used for future seed idempotency.
--
-- Related files (created in this phase):
--   * server/services/crm/duplicateResolver.js
--   * server/services/crm/parents.js
--   * server/services/crm/enquiries.js
--   * server/services/crm/statuses.js
--   * server/services/crm/statusHistory.js
--   * server/services/crm/googleCalendar.js  (Strategy-C stub)
--   * server/db/queries/crm.js
--   * server/routes/admin/crm.js
--
-- Related files (modified in this phase):
--   * server/services/masters/management.js  (register crm_status master)
--   * server/services/enquiry/management.js  (ingestion hook)
--   * server/services/website_property/management.js  (ingestion hook)
--   * server/routes/admin/index.js  (mount /crm)
--   * server/constants/modules.js  (add CRM_MANAGEMENT)
-- ============================================================

SET NAMES utf8mb4;

-- ------------------------------------------------------------------
-- 1) crm_parents
-- ------------------------------------------------------------------
-- normalized_mobile:  10-digit E.164-lite (India). Country code + +/-/spaces
--                     stripped. Nullable because some website enquiries
--                     may lack a mobile (legacy rows).
-- normalized_email:   lowercased + trimmed. Nullable for the same reason.
-- At least one of the two MUST be non-null (enforced by JS validator; DB
-- allows both null for future-proofing).
-- Uniqueness enforced on the non-null variants so races can't create two
-- parents with the same mobile OR the same email.
CREATE TABLE IF NOT EXISTS crm_parents (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  full_name           VARCHAR(255) NOT NULL DEFAULT ''
    COMMENT 'Best-known display name (last-write-wins from ingested enquiries)',
  normalized_mobile   VARCHAR(20) NULL
    COMMENT 'Digits only. Duplicate-detection key #1.',
  normalized_email    VARCHAR(255) NULL
    COMMENT 'Lowercased, trimmed. Duplicate-detection key #2.',
  source_hint         VARCHAR(32) NOT NULL DEFAULT 'unknown'
    COMMENT 'First-seen source: website | npd | manual | unknown',
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
                              ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY ux_parent_norm_mobile (normalized_mobile),
  UNIQUE KEY ux_parent_norm_email  (normalized_email),
  KEY idx_parent_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='T-2026-151: unique person (dedup key = normalized mobile OR email)';

-- ------------------------------------------------------------------
-- 2) crm_enquiries
-- ------------------------------------------------------------------
-- Every ingestion (Website POST + NPD POST + manual add) writes one row.
-- enquiry_code format: ENQ-YYYY-NNNNN (zero-padded per-year sequence).
-- source_type discriminates the source table so admins can jump back to
-- the originating record. source_id is nullable (a manual CRM entry has
-- no source row).
CREATE TABLE IF NOT EXISTS crm_enquiries (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  parent_id           BIGINT UNSIGNED NOT NULL,
  enquiry_code        VARCHAR(32) NOT NULL
    COMMENT 'ENQ-YYYY-NNNNN, unique per-year sequence',
  source_type         VARCHAR(32) NOT NULL DEFAULT 'manual'
    COMMENT 'website | npd | manual',
  source_id           BIGINT UNSIGNED NULL
    COMMENT 'website_properties.id or enquiry_properties.id; NULL for manual',
  status_code         VARCHAR(64) NOT NULL DEFAULT 'new'
    COMMENT 'Current status. Master: crm_status (see migration 102).',
  ingestion_snapshot  JSON NOT NULL
    COMMENT 'Frozen copy of ingestion payload; source table changes never mutate this',
  interested_property_ids JSON NULL
    COMMENT 'Phase-3: array of inventory_properties.id the enquiry is interested in',
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
                              ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY ux_enquiry_code (enquiry_code),
  KEY idx_enquiry_parent (parent_id),
  KEY idx_enquiry_status (status_code),
  KEY idx_enquiry_source (source_type, source_id),
  KEY idx_enquiry_created_at (created_at),
  CONSTRAINT fk_crm_enq_parent
    FOREIGN KEY (parent_id) REFERENCES crm_parents (id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='T-2026-151: one row per ingestion (Website | NPD | manual)';

-- ------------------------------------------------------------------
-- 3) crm_status_history  (IMMUTABLE)
-- ------------------------------------------------------------------
-- Append-only. No route offers UPDATE or DELETE for these rows. The
-- service layer inserts on every status change (including the initial
-- ingest which creates a from_status=NULL row).
CREATE TABLE IF NOT EXISTS crm_status_history (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  enquiry_id          BIGINT UNSIGNED NOT NULL,
  from_status         VARCHAR(64) NULL
    COMMENT 'NULL on the initial ingest row',
  to_status           VARCHAR(64) NOT NULL,
  note                TEXT NULL
    COMMENT 'Free-text context supplied by the admin on the status-change dialog',
  changed_by_admin_id BIGINT UNSIGNED NULL
    COMMENT 'NULL when the change came from an automated ingest',
  calendar_activity_id BIGINT UNSIGNED NULL
    COMMENT 'FK crm_calendar_activities.id if the status change also scheduled a follow-up',
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_hist_enquiry (enquiry_id, created_at),
  CONSTRAINT fk_crm_hist_enquiry
    FOREIGN KEY (enquiry_id) REFERENCES crm_enquiries (id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='T-2026-151: immutable append-only status change log';

-- ------------------------------------------------------------------
-- 4) crm_calendar_activities  (Google Calendar sync surface)
-- ------------------------------------------------------------------
-- Strategy-C stub: rows inserted with sync_status='PENDING' when the
-- googleCalendar service module is in stub mode (no creds). When the
-- module later flips to 'live', a sync worker (out of scope for this
-- ticket) picks these up, calls createEvent(), and updates
-- google_event_id + sync_status.
--
-- Reminders (spec section 33): 1 day before + 1 hour before. Stored as
-- two integer columns (in minutes) so the future live-sync worker can
-- construct the Google Calendar reminder overrides without going back
-- to the frontend for the values.
CREATE TABLE IF NOT EXISTS crm_calendar_activities (
  id                        BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  enquiry_id                BIGINT UNSIGNED NOT NULL,
  scheduled_at              DATETIME NOT NULL
    COMMENT 'Follow-up date + time (Asia/Kolkata per spec, stored as UTC)',
  timezone                  VARCHAR(64) NOT NULL DEFAULT 'Asia/Kolkata',
  reminder_minutes_before_a INT NOT NULL DEFAULT 1440
    COMMENT 'Default 1 day = 1440 minutes',
  reminder_minutes_before_b INT NOT NULL DEFAULT 60
    COMMENT 'Default 1 hour = 60 minutes',
  context_note              TEXT NULL
    COMMENT 'Free-text context to include in the calendar event body',
  google_event_id           VARCHAR(255) NULL
    COMMENT 'Filled by live-sync worker; NULL while sync_status IN (PENDING, FAILED)',
  sync_status               ENUM('PENDING','SYNCED','FAILED','CANCELLED')
                            NOT NULL DEFAULT 'PENDING'
    COMMENT 'PENDING = stub mode or awaiting worker; SYNCED = google_event_id present; FAILED = last sync attempt errored (retry safe); CANCELLED = follow-up dropped',
  sync_last_attempt_at      DATETIME NULL,
  sync_last_error           VARCHAR(255) NULL,
  created_by_admin_id       BIGINT UNSIGNED NULL,
  created_at                DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
                                    ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_cal_enquiry (enquiry_id),
  KEY idx_cal_scheduled_at (scheduled_at),
  KEY idx_cal_sync_status (sync_status),
  CONSTRAINT fk_crm_cal_enquiry
    FOREIGN KEY (enquiry_id) REFERENCES crm_enquiries (id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='T-2026-151: Google Calendar sync surface. Strategy-C: rows begin PENDING; live worker fills google_event_id + flips to SYNCED.';

-- ------------------------------------------------------------------
-- 5) crm_duplicate_conflicts  (spec section 75)
-- ------------------------------------------------------------------
-- Mobile-matches-A vs email-matches-B case. The duplicateResolver
-- refuses to auto-merge and instead inserts a conflict row for the
-- admin to resolve. `payload_json` carries the full ingestion context
-- so no data is lost. `resolved_attach_to_parent_id` NULL until admin
-- picks a parent via POST /crm/parents/resolve-conflict.
CREATE TABLE IF NOT EXISTS crm_duplicate_conflicts (
  id                       BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  parent_a_id              BIGINT UNSIGNED NOT NULL
    COMMENT 'Parent matched by normalized_mobile',
  parent_b_id              BIGINT UNSIGNED NOT NULL
    COMMENT 'Parent matched by normalized_email',
  source_type              VARCHAR(32) NOT NULL,
  source_id                BIGINT UNSIGNED NULL,
  payload_json             JSON NOT NULL,
  resolved_attach_to_parent_id BIGINT UNSIGNED NULL,
  resolved_enquiry_id      BIGINT UNSIGNED NULL,
  resolved_by_admin_id     BIGINT UNSIGNED NULL,
  resolved_at              DATETIME NULL,
  created_at               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_conflict_unresolved (resolved_at, created_at),
  KEY idx_conflict_parent_a (parent_a_id),
  KEY idx_conflict_parent_b (parent_b_id),
  CONSTRAINT fk_crm_conflict_a FOREIGN KEY (parent_a_id) REFERENCES crm_parents (id) ON DELETE CASCADE,
  CONSTRAINT fk_crm_conflict_b FOREIGN KEY (parent_b_id) REFERENCES crm_parents (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='T-2026-151: spec section 75 conflict staging (mobile->A, email->B; admin resolves)';

-- ------------------------------------------------------------------
-- 6) crm_enquiry_sequence
-- ------------------------------------------------------------------
-- Per-year monotonic counter for the ENQ-YYYY-NNNNN code. Kept as a
-- separate one-row-per-year table (instead of a MySQL AUTO_INCREMENT
-- trick) because the year prefix needs to reset annually and we want
-- a strong FOR-UPDATE lock during code generation.
CREATE TABLE IF NOT EXISTS crm_enquiry_sequence (
  year_prefix  CHAR(4) NOT NULL,
  next_seq     INT UNSIGNED NOT NULL DEFAULT 1
    COMMENT 'Next NNNNN to assign for this year',
  updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
                       ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (year_prefix)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='T-2026-151: per-year monotonic counter for ENQ-YYYY-NNNNN codes';
