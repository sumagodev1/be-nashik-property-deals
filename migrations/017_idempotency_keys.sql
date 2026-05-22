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

CREATE TABLE idempotency_keys (
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
