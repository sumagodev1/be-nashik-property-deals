-- ===========================================================
-- 023 — Why a lead was closed
-- ===========================================================
-- When a lead reaches closed_won we auto-close every other open lead on
-- the same property as closed_lost (see closeSiblingsAsLost). Those auto-
-- closed rows are indistinguishable from leads an admin closed by hand,
-- which is confusing on the Kanban — admins see a "lost" card and wonder
-- why nobody touched it.
--
-- This column stores the reason. NULL means "closed by admin action"
-- (the default and historical behaviour). 'sibling_won' is set by the
-- auto-close cascade. Cheap to extend later for other automated reasons
-- ('property_deleted', 'duplicate_buyer', etc.) without another migration.
-- ===========================================================

ALTER TABLE leads
  ADD COLUMN closed_reason VARCHAR(32) NULL AFTER status;
