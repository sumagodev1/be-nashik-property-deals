-- ===========================================================
-- 022 — Per-user targeted notifications
-- ===========================================================
-- The original notifications table was broadcast-by-module only: every
-- sub-admin with the matching module sees every notification under that
-- module. Lead assignment needs the opposite — notify ONE specific
-- sub-admin that they were just handed a lead.
--
-- Adds two columns:
--   target_actor_type ENUM('admin', 'sub_admin') NULL
--   target_actor_id   BIGINT UNSIGNED            NULL
-- When both are set, the notification is private to that actor — list /
-- unreadCount queries scope accordingly. When both NULL, behaviour is the
-- legacy broadcast-by-module flow (no change to existing rows).
-- ===========================================================

ALTER TABLE notifications
  ADD COLUMN target_actor_type ENUM('admin', 'sub_admin') NULL AFTER module_key,
  ADD COLUMN target_actor_id   BIGINT UNSIGNED            NULL AFTER target_actor_type,
  ADD KEY ix_notifications_target (target_actor_type, target_actor_id);
