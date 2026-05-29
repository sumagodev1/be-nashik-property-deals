-- ===========================================================
-- 020 — Admin audit log
-- ===========================================================
-- Records who did what to which resource. Lightweight append-only table —
-- writes are fire-and-forget from the service layer (a failure here MUST
-- never block the actual mutation).
--
-- Schema:
--   actor_type      'admin' | 'sub_admin'      (matches the JWT role)
--   actor_id        the head admin id or sub-admin id
--   actor_name      cached at write time so the log still reads cleanly
--                   even if the user is later renamed or soft-deleted
--   action          short verb, e.g. 'lead.status.changed',
--                   'property.approved', 'sub_admin.created'
--   entity_type     the resource kind, e.g. 'lead', 'website_property',
--                   'inventory_property', 'sub_admin', 'cms.banner'
--   entity_id       PK of the affected row (BIGINT)
--   summary         human-readable one-liner for the UI list
--   metadata        JSON bag of structured before/after diffs etc.
--   created_at      DATETIME, append-only
-- ===========================================================

CREATE TABLE IF NOT EXISTS audit_log (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  actor_type ENUM('admin', 'sub_admin') NOT NULL,
  actor_id BIGINT UNSIGNED NOT NULL,
  actor_name VARCHAR(255) NULL,
  action VARCHAR(64) NOT NULL,
  entity_type VARCHAR(64) NOT NULL,
  entity_id BIGINT UNSIGNED NULL,
  summary VARCHAR(500) NULL,
  metadata JSON NULL,
  ip_address VARCHAR(45) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_audit_log_created_at (created_at),
  KEY ix_audit_log_entity (entity_type, entity_id),
  KEY ix_audit_log_actor (actor_type, actor_id),
  KEY ix_audit_log_action (action)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
