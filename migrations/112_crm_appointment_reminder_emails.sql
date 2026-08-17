-- ============================================================================
-- 112_crm_appointment_reminder_emails.sql
--
-- Admin reminder emails for booked CRM follow-up calls.
--
-- CLIENT REQUIREMENT (verbatim, from user follow-up):
--   "when calender booked time is arriving before 1 day and 1 hour before
--    admin should be recieved mail you have an booked phone call with this
--    enquqiry id and assigned enquiry property id , name and email and
--    message will be recieve on the email means admin know when have to call"
--
-- CONTEXT — WHAT ALREADY EXISTED:
--   crm_calendar_activities already carried reminder_minutes_before_a (1440)
--   and reminder_minutes_before_b (60). Those were ONLY ever forwarded to
--   Google Calendar as `{method:'popup'}` reminder overrides (see
--   services/crm/googleCalendar.js#buildEventBody). They produced a popup on
--   the connected Google account and nothing else — no email from this system,
--   and nothing at all when Google Calendar is disconnected. This migration
--   adds the state needed to ALSO dispatch our own admin email at those two
--   offsets, with the full enquiry context the operator needs to make the call.
--
-- SCHEMA CHANGE:
--   Two nullable dispatch stamps on crm_calendar_activities:
--     reminder_a_sent_at  — the 1-day  (reminder_minutes_before_a) email
--     reminder_b_sent_at  — the 1-hour (reminder_minutes_before_b) email
--   NULL = not yet dispatched. The dispatcher claims a row by stamping the
--   column inside a conditional UPDATE (... WHERE reminder_x_sent_at IS NULL),
--   so two concurrent cron invocations can never both win the same row and
--   the admin never gets a duplicate reminder.
--
--   These are deliberately NOT derived from the email_outbox table: outbox
--   rows are transient (pruned after send) and carry no link back to the
--   appointment, so they cannot answer "has this booking's 1-hour reminder
--   already gone out?" after a prune.
--
-- INDEX:
--   idx_cal_reminder_scan (booking_status, scheduled_at) — the dispatcher
--   scans "active bookings whose scheduled_at falls inside the next N
--   minutes" on every cron tick. The existing idx_cal_scheduled_at and
--   idx_cal_booking_status are single-column; the composite lets the range
--   scan start from the already-filtered 'active' partition.
--
-- BACKFILL:
--   None. Both columns default to NULL, meaning "no reminder sent yet".
--   Bookings already in the past are excluded by the dispatcher's
--   `scheduled_at > <ist-now>` predicate, so this migration will NOT cause a
--   burst of retroactive emails for historical appointments on first run.
--
-- IDEMPOTENCY:
--   ADD COLUMN IF NOT EXISTS / ADD INDEX IF NOT EXISTS (MariaDB 10.4) make a
--   re-run a no-op.
--
-- ROLLBACK:
--   ALTER TABLE crm_calendar_activities
--     DROP INDEX  idx_cal_reminder_scan,
--     DROP COLUMN reminder_a_sent_at,
--     DROP COLUMN reminder_b_sent_at;
--   (Plus remove the cron entry for /api/cron/crm/appointment-reminders/dispatch.)
-- ============================================================================

SET NAMES utf8mb4;

ALTER TABLE crm_calendar_activities
  ADD COLUMN IF NOT EXISTS reminder_a_sent_at DATETIME NULL DEFAULT NULL
    COMMENT 'When the 1-day-before admin reminder email was dispatched. NULL = not sent.'
    AFTER reminder_minutes_before_b,
  ADD COLUMN IF NOT EXISTS reminder_b_sent_at DATETIME NULL DEFAULT NULL
    COMMENT 'When the 1-hour-before admin reminder email was dispatched. NULL = not sent.'
    AFTER reminder_a_sent_at;

ALTER TABLE crm_calendar_activities
  ADD INDEX IF NOT EXISTS idx_cal_reminder_scan (booking_status, scheduled_at);
