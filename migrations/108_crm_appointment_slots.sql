-- ============================================================================
-- 108_crm_appointment_slots.sql
--
-- T-2026-165: CRM follow-up appointment slot-validation + edit/cancel flows.
--
-- Design decision: EXTEND the existing crm_calendar_activities table
-- (from T-2026-151 migration 101) rather than fork a new "appointments"
-- table. Rationale:
--   * The T-151 status-change flow already inserts one calendar_activity
--     row per follow-up + denorms its FK on crm_status_history.
--   * A new table would fork the schema and require rewriting the
--     T-151/T-164 sync worker + retry endpoint + FE panels.
--   * Every column added here is nullable OR has a sensible default so
--     existing rows remain valid (no data migration needed).
--
-- Additive changes (all idempotent via ADD COLUMN IF NOT EXISTS -- MariaDB
-- 10.0.2+ supports this; project runs 10.4.32):
--   1. booking_status ENUM('active','cancelled','superseded') NOT NULL
--      DEFAULT 'active' -- lifecycle flag; 'cancelled' rows are preserved
--      for audit but freed from slot-uniqueness.
--   2. status_history_id BIGINT UNSIGNED NULL -- FK back to
--      crm_status_history.id when the appointment was created as part of
--      a status change (helps the FE co-render). NULL is valid (edit that
--      just moves the time does NOT create a new history row).
--   3. detailed_note TEXT NULL -- longer note the operator adds when
--      booking; separate from context_note (which becomes the calendar
--      title / short reminder).
--   4. active_slot_key VARCHAR(64) NULL -- normalized 15-min bucket key
--      (format: YYYYMMDDHHMM where MM is the 15-min-floor minute). Set
--      only when booking_status='active'; cleared to NULL on cancel.
--      NULLs are distinct in MySQL/MariaDB UNIQUE indexes, so cancelled
--      rows do NOT block future bookings for the same slot.
--   5. cancelled_by_admin_id BIGINT UNSIGNED NULL -- audit trail.
--   6. cancelled_at DATETIME NULL -- audit trail.
--   7. updated_by_admin_id BIGINT UNSIGNED NULL -- who last edited.
--   8. UNIQUE INDEX uq_active_slot ON (active_slot_key) -- belt-and-braces
--      concurrency guard: two racing Node processes attempting the same
--      slot will have exactly one INSERT succeed; the other gets a
--      MySQL error 1062 (ER_DUP_ENTRY) which the service layer catches
--      and re-raises as HTTP 409 SLOT_CONFLICT.
--
-- Plus one NEW table:
--   crm_appointment_history -- immutable timeline of create/edit/cancel
--   events for each appointment. FK to crm_calendar_activities (ON
--   DELETE RESTRICT so an audit trail always outlives the row).
--
-- Backward compatibility:
--   * Existing rows (T-151 seeded) receive DEFAULT values:
--     booking_status='active', all other new columns NULL.
--   * The existing INSERT statement in
--     server/db/queries/crm.js#insertCalendarActivityForConn is
--     extended in the SAME ticket to populate the new columns.
--   * Rows created before this migration but referenced by a new
--     history entry: the T-165 service layer treats "active but no
--     active_slot_key" as a legacy-shape row and back-fills the key
--     lazily on the first read/edit. This migration does NOT retro-
--     compute the key -- historical rows are rare (T-151 was recent)
--     and back-filling in bulk risks colliding with the new UNIQUE
--     index, so we prefer the lazy strategy.
--
-- No DELIMITER / CREATE PROCEDURE anywhere (T-2026-157 lesson).
-- No DROP anywhere (additive-only forward migration).
-- ============================================================================

-- (1) booking_status
ALTER TABLE crm_calendar_activities
  ADD COLUMN IF NOT EXISTS booking_status
    ENUM('active','cancelled','superseded') NOT NULL DEFAULT 'active'
    COMMENT 'T-165: appointment lifecycle. active = live booking; cancelled = admin cancelled; superseded = replaced by an edit (rare).'
    AFTER sync_last_error;

-- (2) status_history_id (nullable FK)
ALTER TABLE crm_calendar_activities
  ADD COLUMN IF NOT EXISTS status_history_id
    BIGINT UNSIGNED NULL
    COMMENT 'T-165: FK crm_status_history.id when this appointment was created as part of a status change. NULL when the appointment was created/edited independently.'
    AFTER booking_status;

-- (3) detailed_note
ALTER TABLE crm_calendar_activities
  ADD COLUMN IF NOT EXISTS detailed_note
    TEXT NULL
    COMMENT 'T-165: longer body text saved on the appointment (in addition to context_note which becomes the calendar title/reminder).'
    AFTER status_history_id;

-- (4) active_slot_key (nullable so cancelled rows don't block)
ALTER TABLE crm_calendar_activities
  ADD COLUMN IF NOT EXISTS active_slot_key
    VARCHAR(64) NULL
    COMMENT 'T-165: normalized 15-min slot bucket key (YYYYMMDDHHMM). Set only when booking_status=active. NULL for cancelled rows so slot is freed.'
    AFTER detailed_note;

-- (5) cancelled_by_admin_id
ALTER TABLE crm_calendar_activities
  ADD COLUMN IF NOT EXISTS cancelled_by_admin_id
    BIGINT UNSIGNED NULL
    COMMENT 'T-165: audit trail for cancel operation.'
    AFTER active_slot_key;

-- (6) cancelled_at
ALTER TABLE crm_calendar_activities
  ADD COLUMN IF NOT EXISTS cancelled_at
    DATETIME NULL
    COMMENT 'T-165: audit trail for cancel operation.'
    AFTER cancelled_by_admin_id;

-- (7) updated_by_admin_id
ALTER TABLE crm_calendar_activities
  ADD COLUMN IF NOT EXISTS updated_by_admin_id
    BIGINT UNSIGNED NULL
    COMMENT 'T-165: audit trail for edit operation. Distinct from created_by_admin_id which is stable.'
    AFTER cancelled_at;

-- (8) UNIQUE INDEX on active_slot_key
-- MySQL/MariaDB semantics: multiple NULL rows are distinct in a UNIQUE
-- index -- exactly what we want. cancelled/superseded rows have NULL
-- active_slot_key, so a fresh booking for the same wall-clock slot
-- proceeds without conflict.
--
-- The IF NOT EXISTS syntax on CREATE INDEX is supported by MariaDB
-- 10.1.4+. Verified against 10.4.32.
CREATE UNIQUE INDEX IF NOT EXISTS uq_cal_active_slot
  ON crm_calendar_activities (active_slot_key);

-- Helpful non-unique indexes for the reads we do most often.
CREATE INDEX IF NOT EXISTS idx_cal_booking_status
  ON crm_calendar_activities (booking_status);
CREATE INDEX IF NOT EXISTS idx_cal_status_history_id
  ON crm_calendar_activities (status_history_id);

-- ---------------------------------------------------------------------------
-- (NEW) crm_appointment_history -- immutable edit/cancel timeline
-- ---------------------------------------------------------------------------
-- One row per create / edit / cancel action against a
-- crm_calendar_activities appointment. Read by the FE
-- AppointmentHistoryPanel to render the timeline. Never mutated
-- after INSERT (audit-only).
--
-- ON DELETE RESTRICT is deliberate: even a soft-cancel keeps the parent
-- row (booking_status='cancelled') so history rows are never orphaned.
-- If a future ticket needs to hard-delete a calendar activity, it must
-- first archive-and-delete the history rows.
CREATE TABLE IF NOT EXISTS crm_appointment_history (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  appointment_id  BIGINT UNSIGNED NOT NULL
    COMMENT 'FK crm_calendar_activities.id',
  action          ENUM('created','edited','cancelled') NOT NULL,
  from_scheduled_at DATETIME NULL
    COMMENT 'For action=edited: the pre-edit scheduled_at. NULL on created.',
  to_scheduled_at   DATETIME NULL
    COMMENT 'For action=created/edited: the post-op scheduled_at.',
  admin_id        BIGINT UNSIGNED NULL
    COMMENT 'Who performed the action. NULL if system-driven.',
  action_note     TEXT NULL
    COMMENT 'Optional free-text (e.g. reason for cancellation).',
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ah_appointment (appointment_id, created_at),
  CONSTRAINT fk_ah_appointment
    FOREIGN KEY (appointment_id) REFERENCES crm_calendar_activities (id)
    ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='T-2026-165: audit timeline for follow-up appointment create/edit/cancel actions. Immutable after insert.';
