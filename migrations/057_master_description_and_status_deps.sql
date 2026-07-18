-- ===========================================================
-- 057 - Master description column + Property Status full CRUD parity
-- ===========================================================
-- T-2026-045: Global / Property Status master becomes fully editable
-- (parity with Property Type / Transaction Type / Property Variety).
-- The backend-side lock (FIXED_MASTERS set) was already cleared in
-- migration 056. Two additive changes finish the job:
--
-- 1. Add an optional `description` column to `master_status_types` so
--    admins can annotate what each status means (e.g. "Reserved -
--    kept aside for a buyer with token amount"). Description is
--    OPTIONAL, VARCHAR(255), NULL by default. Only status_type gets
--    the column; other masters stay lean.
--
-- 2. No seed changes. The four seeded default rows (available / sold
--    / rented / inactive) stay as-is with NULL descriptions.
--
-- Historical rows are unaffected. Backend serializer (toDto) begins
-- surfacing the field once this migration is applied.
-- ===========================================================

ALTER TABLE master_status_types
  ADD COLUMN description VARCHAR(255) NULL AFTER label;
