-- Migration 017: idempotency key cache.
--
-- When a state-mutating endpoint receives a request with an
-- `Idempotency-Key` header, the middleware stores the full response under
-- that key. A duplicate request (same key) replays the cached response
-- instead of running the handler again — preventing duplicate leads,
-- duplicate property creates, duplicate approvals, etc. from rapid
-- double-clicks, browser-back-resubmits, or flaky-network retries.
--
-- The key is scoped by route (method + path) AND by the caller (auth
-- subject when present, IP when public) so two different users can't
-- accidentally collide on the same client-generated UUID.
--
-- Rows older than the TTL are purged by a cron-driven endpoint — see
-- Deployment notes in CLAUDE.md (no setInterval / setTimeout in the app).

-- T-2026-110: added `IF NOT EXISTS` so the migration is idempotent at the
-- SQL level as well as at the runner level (scripts/migrate.js already
-- gates on schema_migrations). Re-running this file on a DB where the
-- table exists is now a no-op instead of an error. Additive-only edit,
-- backwards-compatible.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  idempotency_key VARCHAR(128)  NOT NULL,
  scope         VARCHAR(255)    NOT NULL,            -- method + path + actor
  status_code   SMALLINT UNSIGNED NOT NULL,
  response_body MEDIUMTEXT      NULL,                -- JSON body
  created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_idempotency_key_scope (idempotency_key, scope),
  KEY ix_idempotency_created_at (created_at)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;
