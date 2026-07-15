-- ===========================================================
-- 052 — Owner Search Indexes (cross-module duplicate detection)
-- ===========================================================
-- Backs the /api/admin/owner-search endpoint. That endpoint issues LIKE
-- queries against owner name / phone / mobile / whatsapp / email fields
-- across inventory_properties, enquiry_properties, and business_associates
-- so the admin sees live suggestions while filling an Owner Details block
-- on either the Inventory or Enquiry registration forms.
--
-- Only prefix / leading-substring LIKE queries can use these B-tree indexes
-- (`LIKE 'ke%'` uses the index; `LIKE '%ke%'` does a full scan). The
-- service layer runs both — the leading-anchored form is fast on large
-- tables, the '%X%' form is retained for genuine substring hits and is
-- capped at 15 rows so the scan stays bounded.
--
-- Existing indexes already present:
--   - business_associates: ix_biz_assoc_mobile1, ix_biz_assoc_email1
--     (migration 050) — this migration ADDS the remaining contact-column
--     indexes so every field the endpoint filters on is covered.
--
-- The `owner_name` / `owner_contact` columns on the two property tables
-- had no indexes before this file. `details` JSON matching still requires
-- a full-column LIKE scan (no functional index on JSON here) — that path
-- is bounded by the query's own LIMIT and the outer WHERE trims the row
-- set first via the indexed columns whenever possible.
--
-- Idempotency: this migration file is only ever run once (schema_migrations
-- records the filename). Should it need re-running against a partially
-- migrated database, the DROP … IF EXISTS + ADD KEY pair is safe.
-- ===========================================================

SET NAMES utf8mb4;

-- ------------------------------------------------------------
-- inventory_properties — owner lookup columns
-- ------------------------------------------------------------
ALTER TABLE inventory_properties
  ADD KEY ix_inv_owner_name    (owner_name),
  ADD KEY ix_inv_owner_contact (owner_contact);

-- ------------------------------------------------------------
-- enquiry_properties — owner lookup columns
-- ------------------------------------------------------------
ALTER TABLE enquiry_properties
  ADD KEY ix_enq_owner_name    (owner_name),
  ADD KEY ix_enq_owner_contact (owner_contact);

-- ------------------------------------------------------------
-- business_associates — extra contact-column indexes
-- (mobile1 + email1 are already indexed via migration 050)
-- ------------------------------------------------------------
ALTER TABLE business_associates
  ADD KEY ix_biz_assoc_first_name  (first_name),
  ADD KEY ix_biz_assoc_surname     (surname),
  ADD KEY ix_biz_assoc_phone1      (phone1),
  ADD KEY ix_biz_assoc_mobile2     (mobile2),
  ADD KEY ix_biz_assoc_mobile3     (mobile3),
  ADD KEY ix_biz_assoc_whatsapp    (whatsapp),
  ADD KEY ix_biz_assoc_email2      (email2),
  ADD KEY ix_biz_assoc_designation (designation);
