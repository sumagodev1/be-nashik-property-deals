-- ===========================================================
-- 027 — Inventory: registration date, hierarchical location,
--                   coordinates, pincode, transaction variant
-- ===========================================================
-- The reference registration forms (see .claude-analysis/inventory-fields-
-- reference.md) capture several fields that are valuable enough to query
-- against to deserve real columns rather than living inside `details JSON`:
--
--   - `registration_date`  the date the admin recorded on the form
--                          (distinct from system created_at)
--   - `transaction_variant` Resale vs New Sale, Joint Venture, Hostel Let
--                          In/Out, Paying Guest — sits *under* the broader
--                          transaction_type (sale/rent/lease), and drives
--                          which form sub-sections show
--   - `district / taluka / shivar`  hierarchical location used by every land
--                                    / plot / SEZ / TDR / Pre-Leased / Bank
--                                    Auction form
--   - `latitude / longitude / pincode`  promoted from details so the list
--                                       endpoint can sort / filter / search
--                                       on them
--
-- All are nullable so existing rows continue to work. Promoting `details.lat`
-- → column is a data move handled by the application layer next time those
-- rows are saved; no backfill migration here.

ALTER TABLE inventory_properties
  ADD COLUMN registration_date    DATE         NULL AFTER property_code,
  ADD COLUMN transaction_variant  VARCHAR(64)  NULL AFTER transaction_type,
  ADD COLUMN district             VARCHAR(64)  NULL AFTER location,
  ADD COLUMN taluka                VARCHAR(64)  NULL AFTER district,
  ADD COLUMN shivar                VARCHAR(64)  NULL AFTER taluka,
  ADD COLUMN latitude             DECIMAL(10,7) NULL AFTER shivar,
  ADD COLUMN longitude            DECIMAL(10,7) NULL AFTER latitude,
  ADD COLUMN pincode              VARCHAR(10)  NULL AFTER longitude;

-- Indices for filtering / list queries.
ALTER TABLE inventory_properties
  ADD KEY ix_inventory_district_taluka (district, taluka),
  ADD KEY ix_inventory_transaction_variant (transaction_variant),
  ADD KEY ix_inventory_pincode (pincode);
