-- ===========================================================
-- 053 — Make business_associates.salutation nullable
-- ===========================================================
-- Allows bulk-uploaded records where no salutation prefix is
-- present in the name column, and manual records where the
-- operator chooses not to set a salutation.
-- ===========================================================

ALTER TABLE business_associates MODIFY COLUMN salutation ENUM('mr','mrs','miss','smt') NULL;
