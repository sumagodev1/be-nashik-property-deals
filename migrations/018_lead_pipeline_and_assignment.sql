-- ===========================================================
-- 018 — Lead pipeline (more granular statuses) + lead assignment
-- ===========================================================
-- 1. Extends `leads.status` from ('new', 'contacted') to a full sales
--    pipeline: new → contacted → site_visit → closed_won / closed_lost.
--    Old rows keep their value (both 'new' and 'contacted' remain valid).
-- 2. Adds `assigned_sub_admin_id` — nullable FK into sub_admins. The head
--    admin sees all leads by default and doesn't need to be "assigned";
--    assignment is the mechanism for routing leads to specific sub-admins.
--    NULL means "unassigned, head admin handles it".
-- 3. Adds index on (status, assigned_sub_admin_id) so the Kanban board can
--    pull "my open leads in column X" without a table scan.
-- ===========================================================

ALTER TABLE leads
  MODIFY COLUMN status ENUM('new', 'contacted', 'site_visit', 'closed_won', 'closed_lost')
    NOT NULL DEFAULT 'new';

ALTER TABLE leads
  ADD COLUMN assigned_sub_admin_id BIGINT UNSIGNED NULL AFTER status,
  ADD CONSTRAINT fk_leads_assigned_sub_admin
    FOREIGN KEY (assigned_sub_admin_id) REFERENCES sub_admins(id) ON DELETE SET NULL,
  ADD KEY ix_leads_status_assigned (status, assigned_sub_admin_id);
