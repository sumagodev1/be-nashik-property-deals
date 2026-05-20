-- Migration 014: status-change note + audit on inventory_properties.
--
-- When an admin moves a property's status (e.g. "Available" → "Booked",
-- "Hold" → "Sold"), the listing UI now prompts for a free-text note so the
-- team can capture the *why*: which buyer placed the hold, what fell through,
-- expected re-listing date, etc.
--
-- We store only the LATEST note on the row (status_note) plus a small audit
-- pair (when + which admin). Full history is not a current requirement and
-- would need its own table — keeping this single-row for now per the project's
-- "don't design for hypothetical future requirements" rule.

ALTER TABLE inventory_properties
  ADD COLUMN status_note        TEXT             NULL AFTER status,
  ADD COLUMN status_changed_at  DATETIME         NULL AFTER status_note,
  ADD COLUMN status_changed_by  BIGINT UNSIGNED  NULL AFTER status_changed_at;
