-- ===========================================================
-- 056 — Website properties: hierarchical location columns
-- ===========================================================
-- The Website Properties admin surface needs to filter by the same
-- District → Taluka → Village (shivar) cascade the Inventory list uses.
-- Until now, `website_properties` stored only a single free-text
-- `location` string produced by the public seller form's map picker,
-- so a code-level location filter was impossible.
--
-- Mirror migration 027's shape for `inventory_properties`: nullable
-- master-code columns + a composite (district, taluka) index and a
-- pincode index. Existing rows keep NULL until re-edited; the new
-- district/taluka/village cascade added to the public AddPropertyPage
-- captures these values on new submissions.

ALTER TABLE website_properties
  ADD COLUMN district VARCHAR(64) NULL AFTER location,
  ADD COLUMN taluka   VARCHAR(64) NULL AFTER district,
  ADD COLUMN shivar   VARCHAR(64) NULL AFTER taluka,
  ADD COLUMN pincode  VARCHAR(10) NULL AFTER shivar;

ALTER TABLE website_properties
  ADD KEY ix_website_district_taluka (district, taluka),
  ADD KEY ix_website_shivar          (shivar),
  ADD KEY ix_website_pincode         (pincode);
