-- ============================================================
-- 107 - Google Calendar User-OAuth2 (Strategy B) live-mode tables
-- ============================================================
-- T-2026-164. Flips the T-2026-151 Phase-1 Strategy-C stub in
-- server/services/crm/googleCalendar.js to a real live-mode client.
--
-- Adds:
--   1) google_calendar_tokens
--        Singleton row (scope='singleton', admin_id=NULL) storing the
--        long-lived Google refresh_token + short-lived access_token
--        cache + audit metadata for the admin who ran the OAuth Connect
--        flow. Nullable admin_id + scope column reserve room for a
--        per-admin token pool later without a second migration.
--
--   2) google_calendar_oauth_states
--        Short-lived CSRF nonce table for the /api/google-calendar/
--        connect -> callback round-trip. Every /connect request writes
--        a fresh row with a random state + admin_id + expires_at; the
--        /callback handler pops it (single-use) before token exchange.
--        A background reaper (also in the sync worker) prunes expired
--        rows.
--
--   3) crm_status_history.google_event_id
--        Denormalized copy of the Google Calendar event id when the
--        status change also scheduled a follow-up. crm_calendar_
--        activities.google_event_id remains the source of truth; this
--        is a convenience column that lets FE panels avoid the extra
--        join. Added via ALTER TABLE ... ADD COLUMN IF NOT EXISTS
--        (MariaDB 10.0.2+; project runs 10.4.32).
--
-- Idempotency:
--   * All table creates use IF NOT EXISTS.
--   * The ALTER on crm_status_history uses ADD COLUMN IF NOT EXISTS.
--   * No DELIMITER anywhere (T-2026-157 lesson).
--   * No CREATE PROCEDURE, no CREATE TRIGGER, no CREATE VIEW.
--   * Migration runner has multipleStatements:true so the semicolon-
--     separated statements execute in one go.
--
-- Security note:
--   The refresh_token column stores the raw Google refresh token.
--   Google refresh tokens are bearer credentials -- possession of one
--   grants ongoing access to the connected user's calendar. This
--   project's dev DB (Xaamp 3 MariaDB, root/no-password, local-only)
--   is treated as trust boundary; at-rest encryption of the column is
--   a follow-up (see also EMAIL_ENCRYPTION_KEY pattern in .env.example
--   which encrypts email SMTP passwords via AES-256-GCM; the same
--   helper could be reused). The application layer never logs, JSON-
--   serializes, or echoes the value out of any API response. The
--   /status endpoint returns booleans + admin_email only; there is no
--   route that surfaces the raw token.
-- ============================================================

SET NAMES utf8mb4;

-- ------------------------------------------------------------------
-- 1) google_calendar_tokens
-- ------------------------------------------------------------------
-- Singleton pattern: scope='singleton', admin_id=NULL means "the one
-- calendar the whole team's CRM writes to". If a future ticket wants
-- per-admin calendars, insert additional rows with scope='per_admin'
-- + admin_id=<n>; the UNIQUE KEY on (scope, admin_id) permits both
-- shapes to coexist. Note MySQL/MariaDB treats NULLs as DISTINCT in
-- UNIQUE indexes so the singleton row (admin_id=NULL) does not
-- conflict with any per-admin row.
CREATE TABLE IF NOT EXISTS google_calendar_tokens (
  id                        INT UNSIGNED NOT NULL AUTO_INCREMENT,
  scope                     VARCHAR(64) NOT NULL DEFAULT 'singleton'
    COMMENT 'singleton = one calendar for the whole team; per_admin = future per-admin tokens',
  admin_id                  BIGINT UNSIGNED NULL
    COMMENT 'FK admins.id when scope=per_admin; NULL for the singleton',
  refresh_token             TEXT NOT NULL
    COMMENT 'Long-lived Google refresh_token. NEVER logged or echoed out of any response.',
  access_token              TEXT NULL
    COMMENT 'Short-lived cache; refreshed via oauth2Client.getAccessToken() when expired',
  access_token_expires_at   DATETIME NULL
    COMMENT 'Cache expiry timestamp; refresh 60s before this to avoid mid-request expiry',
  scope_granted             TEXT NULL
    COMMENT 'Comma-separated scopes returned by Google (calendar.events + possibly openid/email)',
  token_type                VARCHAR(32) NULL
    COMMENT 'Usually "Bearer"',
  connected_by_admin_id     BIGINT UNSIGNED NULL
    COMMENT 'admins.id of the operator who ran the Connect flow',
  connected_by_admin_email  VARCHAR(255) NULL
    COMMENT 'Denormalized for display on the /status endpoint',
  connected_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
                                    ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_scope_admin (scope, admin_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='T-2026-164: Google Calendar OAuth2 (Strategy B) token store. Singleton row for the team calendar; per-admin rows are a future extension.';

-- ------------------------------------------------------------------
-- 2) google_calendar_oauth_states  (short-lived CSRF nonce)
-- ------------------------------------------------------------------
-- The /api/google-calendar/connect endpoint inserts one row per issued
-- OAuth authorization URL. The /callback handler SELECTs by state,
-- validates admin_id + expires_at, then DELETEs the row (single-use).
-- Rows older than expires_at are opportunistically reaped by the
-- Google Calendar sync worker on its 5-minute tick. Loose FK to
-- admins.id is intentional -- if the admin is deleted before they
-- complete the OAuth roundtrip, the nonce just expires naturally.
CREATE TABLE IF NOT EXISTS google_calendar_oauth_states (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  state        VARCHAR(128) NOT NULL
    COMMENT 'Opaque random string (64 hex chars). Sent to Google, returned on callback.',
  admin_id     BIGINT UNSIGNED NOT NULL
    COMMENT 'admins.id of the operator who initiated the flow',
  admin_email  VARCHAR(255) NULL,
  expires_at   DATETIME NOT NULL
    COMMENT 'Typically now() + 10 minutes; callback rejects expired nonces',
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_state (state),
  KEY idx_expires_at (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='T-2026-164: single-use CSRF nonce for the Google OAuth connect/callback round-trip.';

-- ------------------------------------------------------------------
-- 3) crm_status_history.google_event_id  (denormalized convenience)
-- ------------------------------------------------------------------
-- Denormalized copy for FE panels that want the Google event id
-- without joining through crm_calendar_activities. The authoritative
-- value still lives in crm_calendar_activities.google_event_id --
-- the sync worker updates BOTH columns in the same UPDATE when it
-- resolves a PENDING row. ALTER ... ADD COLUMN IF NOT EXISTS is
-- supported natively by MariaDB 10.0.2+; the project's MariaDB
-- 10.4.32 handles it.
ALTER TABLE crm_status_history
  ADD COLUMN IF NOT EXISTS google_event_id VARCHAR(255) NULL
    COMMENT 'T-2026-164: denormalized copy of crm_calendar_activities.google_event_id for the linked follow-up; NULL until sync worker fills it.'
    AFTER calendar_activity_id;
