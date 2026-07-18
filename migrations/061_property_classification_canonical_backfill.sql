-- ===========================================================
-- 061 - Property classification canonical back-fill
--   (Property Type / Transaction Type / Property Variety)
-- ===========================================================
-- T-2026-051: Prior to the frontend fix in InventoryForm.jsx, the
-- SUBMIT payload stored the stripped Registration Form label (for
-- example "SEZ [Land Sale]") in the property_type column. This
-- migration corrects those rows by projecting each bad label onto the
-- three canonical fields:
--   property_type       -> master_property_types.code
--   transaction_type    -> master_transaction_types.code
--   transaction_variant -> master_lookups.code for master_key = 'property_variety'
--
-- Guardrails (verbatim from the T-2026-051 spec):
--   - Only touch rows that are demonstrably wrong.
--   - Never modify already-correct rows.
--   - Never rename columns. Never drop columns.
--   - Idempotent: safe to re-run. Second run finds zero bad rows.
--   - Dry-run reporting: BEFORE the UPDATEs, the migration COUNTs how
--     many rows match each bad pattern so the DBA can log the impact.
--
-- Applies to BOTH inventory_properties AND enquiry_properties.
-- ===========================================================

-- Step 1: DRY-RUN REPORT. Row counts per bad label pattern, both tables.
-- These SELECTs are informational only - they never mutate.

SELECT
  'inventory_properties' AS source_table,
  property_type AS bad_value,
  COUNT(*) AS affected_rows
FROM inventory_properties
WHERE deleted_at IS NULL
  AND property_type IN
  (
    'Bunglow [Resale Lease In]',
    'Bunglow [New Lease In]',
    'Bunglow [Resale Lease Out]',
    'Bunglow [New Lease Out]',
    'Bunglow [Resale Purchase]',
    'Bunglow [New Purchase]',
    'Bunglow [Resale Rent In]',
    'Bunglow [New Rent In]',
    'Bunglow [Resale Rent Out]',
    'Bunglow [New Rent Out]',
    'Bunglow [Re-Sale]',
    'Bunglow [New Sale]',
    'Bunglow [Paying Guest]',
    'Bunglow [Paying Guest Out]',
    'Commercial Space [Lease In Resale Commercial Space]',
    'Commercial Space [Lease In New Commercial Space]',
    'Commercial Space [Lease Out Resale Commercial Space]',
    'Commercial Space [Lease Out New Commercial Space]',
    'Commercial Space [Resale Purchase]',
    'Commercial Space [New Purchase]',
    'Commercial Space [Resale Rent In]',
    'Commercial Space [New Rent In]',
    'Commercial Space [Resale Rent Out]',
    'Commercial Space [New Rent Out]',
    'Commercial Space [Re-Sale]',
    'Commercial Space [New Sale]',
    'Flat [Joint Venture]',
    'Flat [Resale Lease In]',
    'Flat [New Lease In]',
    'Flat [Resale Lease Out]',
    'Flat [New Lease Out]',
    'Flat [Resale Purchase]',
    'Flat [New Purchase]',
    'Flat [Resale Rent In]',
    'Flat [New Rent In]',
    'Flat [Resale Rent Out]',
    'Flat [New Rent Out]',
    'Flat [Re-Sale]',
    'Flat [New Sale]',
    'Flat [Paying Guest]',
    'Flat [Paying Guest Out]',
    'Hospital [Re-Sale]',
    'Hospital [Sell]',
    'Hospital [Rent Out]',
    'Hospital [Rent In]',
    'Hostel[Hostel Let In]',
    'Hostel [Hostel Let In]',
    'Hostel [Hostel Let Out]',
    'Hotel [Sell]',
    'Hotel [Rent Out]',
    'Hotel [Buy]',
    'Hotel [Rent In]',
    'Land [Lease In]',
    'Land [Lease Out]',
    'Land [Purchase]',
    'Land [Rent In]',
    'Land [Rent Out]',
    'Land [Sale]',
    'Plot [Lease In]',
    'Plot [Lease Out]',
    'Plot [Purchase]',
    'Plot [Rent In]',
    'Plot [Rent Out]',
    'Plot [Sale]',
    'Flat Rate Finder',
    'Land Rate Finder',
    'Plot Rate Finder',
    'Shop Rate Finder',
    'SEZ [Plot Purchase]',
    'SEZ [Land Purchase]',
    'SEZ [Plot Sale]',
    'SEZ [Land Sale]',
    'Shop [Resale Lease In]',
    'Shop [New Lease In]',
    'Shop [Resale Lease Out]',
    'Shop [New Lease Out]',
    'Shop [Resale Purchase]',
    'Shop [New Purchase]',
    'Shop [Resale Rent In]',
    'Shop [New Rent In]',
    'Shop [Resale Rent Out]',
    'Shop [New Rent Out]',
    'Shop [Re-Sale]',
    'Shop [New Sale]',
    'TDR[Sale]',
    'TDR [Sale]',
    'TDR [In]',
    'Bank Auction [Re-Sale]',
    'Industrial Plot [Re-Sale]',
    'Pre-Leased Property [Re-Sale]',
    'Project [Re-Sale]'
  )
GROUP BY property_type
UNION ALL
SELECT
  'enquiry_properties' AS source_table,
  property_type AS bad_value,
  COUNT(*) AS affected_rows
FROM enquiry_properties
WHERE deleted_at IS NULL
  AND property_type IN
  (
    'Bunglow [Resale Lease In]',
    'Bunglow [New Lease In]',
    'Bunglow [Resale Lease Out]',
    'Bunglow [New Lease Out]',
    'Bunglow [Resale Purchase]',
    'Bunglow [New Purchase]',
    'Bunglow [Resale Rent In]',
    'Bunglow [New Rent In]',
    'Bunglow [Resale Rent Out]',
    'Bunglow [New Rent Out]',
    'Bunglow [Re-Sale]',
    'Bunglow [New Sale]',
    'Bunglow [Paying Guest]',
    'Bunglow [Paying Guest Out]',
    'Commercial Space [Lease In Resale Commercial Space]',
    'Commercial Space [Lease In New Commercial Space]',
    'Commercial Space [Lease Out Resale Commercial Space]',
    'Commercial Space [Lease Out New Commercial Space]',
    'Commercial Space [Resale Purchase]',
    'Commercial Space [New Purchase]',
    'Commercial Space [Resale Rent In]',
    'Commercial Space [New Rent In]',
    'Commercial Space [Resale Rent Out]',
    'Commercial Space [New Rent Out]',
    'Commercial Space [Re-Sale]',
    'Commercial Space [New Sale]',
    'Flat [Joint Venture]',
    'Flat [Resale Lease In]',
    'Flat [New Lease In]',
    'Flat [Resale Lease Out]',
    'Flat [New Lease Out]',
    'Flat [Resale Purchase]',
    'Flat [New Purchase]',
    'Flat [Resale Rent In]',
    'Flat [New Rent In]',
    'Flat [Resale Rent Out]',
    'Flat [New Rent Out]',
    'Flat [Re-Sale]',
    'Flat [New Sale]',
    'Flat [Paying Guest]',
    'Flat [Paying Guest Out]',
    'Hospital [Re-Sale]',
    'Hospital [Sell]',
    'Hospital [Rent Out]',
    'Hospital [Rent In]',
    'Hostel[Hostel Let In]',
    'Hostel [Hostel Let In]',
    'Hostel [Hostel Let Out]',
    'Hotel [Sell]',
    'Hotel [Rent Out]',
    'Hotel [Buy]',
    'Hotel [Rent In]',
    'Land [Lease In]',
    'Land [Lease Out]',
    'Land [Purchase]',
    'Land [Rent In]',
    'Land [Rent Out]',
    'Land [Sale]',
    'Plot [Lease In]',
    'Plot [Lease Out]',
    'Plot [Purchase]',
    'Plot [Rent In]',
    'Plot [Rent Out]',
    'Plot [Sale]',
    'Flat Rate Finder',
    'Land Rate Finder',
    'Plot Rate Finder',
    'Shop Rate Finder',
    'SEZ [Plot Purchase]',
    'SEZ [Land Purchase]',
    'SEZ [Plot Sale]',
    'SEZ [Land Sale]',
    'Shop [Resale Lease In]',
    'Shop [New Lease In]',
    'Shop [Resale Lease Out]',
    'Shop [New Lease Out]',
    'Shop [Resale Purchase]',
    'Shop [New Purchase]',
    'Shop [Resale Rent In]',
    'Shop [New Rent In]',
    'Shop [Resale Rent Out]',
    'Shop [New Rent Out]',
    'Shop [Re-Sale]',
    'Shop [New Sale]',
    'TDR[Sale]',
    'TDR [Sale]',
    'TDR [In]',
    'Bank Auction [Re-Sale]',
    'Industrial Plot [Re-Sale]',
    'Pre-Leased Property [Re-Sale]',
    'Project [Re-Sale]'
  )
GROUP BY property_type;

-- Step 2: Back-fill each bad label. One UPDATE per label makes the SQL
-- trivially readable AND ensures each row is touched at most once
-- (idempotent on re-run: after Step 2, no row matches the WHERE clause).

-- ---- inventory_properties ------------------------------------
UPDATE inventory_properties SET
  property_type       = 'bungalow',
  transaction_type    = 'lease_in',
  transaction_variant = NULL
WHERE property_type = 'Bunglow [Resale Lease In]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'bungalow',
  transaction_type    = 'lease_in',
  transaction_variant = 'new'
WHERE property_type = 'Bunglow [New Lease In]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'bungalow',
  transaction_type    = 'lease_out',
  transaction_variant = NULL
WHERE property_type = 'Bunglow [Resale Lease Out]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'bungalow',
  transaction_type    = 'lease_out',
  transaction_variant = 'new'
WHERE property_type = 'Bunglow [New Lease Out]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'bungalow',
  transaction_type    = 'purchase',
  transaction_variant = 'resale'
WHERE property_type = 'Bunglow [Resale Purchase]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'bungalow',
  transaction_type    = 'purchase',
  transaction_variant = 'new'
WHERE property_type = 'Bunglow [New Purchase]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'bungalow',
  transaction_type    = 'rent_in',
  transaction_variant = NULL
WHERE property_type = 'Bunglow [Resale Rent In]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'bungalow',
  transaction_type    = 'rent_in',
  transaction_variant = 'new'
WHERE property_type = 'Bunglow [New Rent In]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'bungalow',
  transaction_type    = 'rent_out',
  transaction_variant = NULL
WHERE property_type = 'Bunglow [Resale Rent Out]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'bungalow',
  transaction_type    = 'rent_out',
  transaction_variant = 'new'
WHERE property_type = 'Bunglow [New Rent Out]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'bungalow',
  transaction_type    = 'sale',
  transaction_variant = 'resale'
WHERE property_type = 'Bunglow [Re-Sale]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'bungalow',
  transaction_type    = 'sale',
  transaction_variant = 'new'
WHERE property_type = 'Bunglow [New Sale]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'paying_guest',
  transaction_type    = 'paying_guest',
  transaction_variant = NULL
WHERE property_type = 'Bunglow [Paying Guest]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'paying_guest',
  transaction_type    = 'paying_guest',
  transaction_variant = NULL
WHERE property_type = 'Bunglow [Paying Guest Out]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'commercial_space',
  transaction_type    = 'lease_in',
  transaction_variant = NULL
WHERE property_type = 'Commercial Space [Lease In Resale Commercial Space]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'commercial_space',
  transaction_type    = 'lease_in',
  transaction_variant = 'new'
WHERE property_type = 'Commercial Space [Lease In New Commercial Space]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'commercial_space',
  transaction_type    = 'lease_out',
  transaction_variant = NULL
WHERE property_type = 'Commercial Space [Lease Out Resale Commercial Space]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'commercial_space',
  transaction_type    = 'lease_out',
  transaction_variant = 'new'
WHERE property_type = 'Commercial Space [Lease Out New Commercial Space]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'commercial_space',
  transaction_type    = 'purchase',
  transaction_variant = 'resale'
WHERE property_type = 'Commercial Space [Resale Purchase]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'commercial_space',
  transaction_type    = 'purchase',
  transaction_variant = 'new'
WHERE property_type = 'Commercial Space [New Purchase]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'commercial_space',
  transaction_type    = 'rent_in',
  transaction_variant = NULL
WHERE property_type = 'Commercial Space [Resale Rent In]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'commercial_space',
  transaction_type    = 'rent_in',
  transaction_variant = 'new'
WHERE property_type = 'Commercial Space [New Rent In]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'commercial_space',
  transaction_type    = 'rent_out',
  transaction_variant = NULL
WHERE property_type = 'Commercial Space [Resale Rent Out]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'commercial_space',
  transaction_type    = 'rent_out',
  transaction_variant = 'new'
WHERE property_type = 'Commercial Space [New Rent Out]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'commercial_space',
  transaction_type    = 'sale',
  transaction_variant = 'resale'
WHERE property_type = 'Commercial Space [Re-Sale]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'commercial_space',
  transaction_type    = 'sale',
  transaction_variant = 'new'
WHERE property_type = 'Commercial Space [New Sale]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'flat',
  transaction_type    = 'joint_venture',
  transaction_variant = NULL
WHERE property_type = 'Flat [Joint Venture]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'flat',
  transaction_type    = 'lease_in',
  transaction_variant = NULL
WHERE property_type = 'Flat [Resale Lease In]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'flat',
  transaction_type    = 'lease_in',
  transaction_variant = 'new'
WHERE property_type = 'Flat [New Lease In]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'flat',
  transaction_type    = 'lease_out',
  transaction_variant = NULL
WHERE property_type = 'Flat [Resale Lease Out]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'flat',
  transaction_type    = 'lease_out',
  transaction_variant = 'new'
WHERE property_type = 'Flat [New Lease Out]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'flat',
  transaction_type    = 'purchase',
  transaction_variant = 'resale'
WHERE property_type = 'Flat [Resale Purchase]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'flat',
  transaction_type    = 'purchase',
  transaction_variant = 'new'
WHERE property_type = 'Flat [New Purchase]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'flat',
  transaction_type    = 'rent_in',
  transaction_variant = NULL
WHERE property_type = 'Flat [Resale Rent In]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'flat',
  transaction_type    = 'rent_in',
  transaction_variant = 'new'
WHERE property_type = 'Flat [New Rent In]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'flat',
  transaction_type    = 'rent_out',
  transaction_variant = NULL
WHERE property_type = 'Flat [Resale Rent Out]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'flat',
  transaction_type    = 'rent_out',
  transaction_variant = 'new'
WHERE property_type = 'Flat [New Rent Out]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'flat',
  transaction_type    = 'sale',
  transaction_variant = 'resale'
WHERE property_type = 'Flat [Re-Sale]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'flat',
  transaction_type    = 'sale',
  transaction_variant = 'new'
WHERE property_type = 'Flat [New Sale]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'paying_guest',
  transaction_type    = 'paying_guest',
  transaction_variant = NULL
WHERE property_type = 'Flat [Paying Guest]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'paying_guest',
  transaction_type    = 'paying_guest',
  transaction_variant = NULL
WHERE property_type = 'Flat [Paying Guest Out]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'hospital',
  transaction_type    = 'sale',
  transaction_variant = 'resale'
WHERE property_type = 'Hospital [Re-Sale]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'hospital',
  transaction_type    = 'sale',
  transaction_variant = NULL
WHERE property_type = 'Hospital [Sell]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'hospital',
  transaction_type    = 'rent_out',
  transaction_variant = NULL
WHERE property_type = 'Hospital [Rent Out]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'hospital',
  transaction_type    = 'rent_in',
  transaction_variant = NULL
WHERE property_type = 'Hospital [Rent In]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'hostel',
  transaction_type    = 'hostel_let_in',
  transaction_variant = NULL
WHERE property_type = 'Hostel[Hostel Let In]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'hostel',
  transaction_type    = 'hostel_let_in',
  transaction_variant = NULL
WHERE property_type = 'Hostel [Hostel Let In]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'hostel',
  transaction_type    = 'hostel_let_out',
  transaction_variant = NULL
WHERE property_type = 'Hostel [Hostel Let Out]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'hotel',
  transaction_type    = 'sale',
  transaction_variant = NULL
WHERE property_type = 'Hotel [Sell]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'hotel',
  transaction_type    = 'rent_out',
  transaction_variant = NULL
WHERE property_type = 'Hotel [Rent Out]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'hotel',
  transaction_type    = 'purchase',
  transaction_variant = NULL
WHERE property_type = 'Hotel [Buy]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'hotel',
  transaction_type    = 'rent_in',
  transaction_variant = NULL
WHERE property_type = 'Hotel [Rent In]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'land',
  transaction_type    = 'lease_in',
  transaction_variant = NULL
WHERE property_type = 'Land [Lease In]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'land',
  transaction_type    = 'lease_out',
  transaction_variant = NULL
WHERE property_type = 'Land [Lease Out]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'land',
  transaction_type    = 'purchase',
  transaction_variant = 'resale'
WHERE property_type = 'Land [Purchase]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'land',
  transaction_type    = 'rent_in',
  transaction_variant = NULL
WHERE property_type = 'Land [Rent In]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'land',
  transaction_type    = 'rent_out',
  transaction_variant = NULL
WHERE property_type = 'Land [Rent Out]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'land',
  transaction_type    = 'sale',
  transaction_variant = 'resale'
WHERE property_type = 'Land [Sale]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'plot',
  transaction_type    = 'lease_in',
  transaction_variant = NULL
WHERE property_type = 'Plot [Lease In]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'plot',
  transaction_type    = 'lease_out',
  transaction_variant = NULL
WHERE property_type = 'Plot [Lease Out]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'plot',
  transaction_type    = 'purchase',
  transaction_variant = 'resale'
WHERE property_type = 'Plot [Purchase]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'plot',
  transaction_type    = 'rent_in',
  transaction_variant = NULL
WHERE property_type = 'Plot [Rent In]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'plot',
  transaction_type    = 'rent_out',
  transaction_variant = NULL
WHERE property_type = 'Plot [Rent Out]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'plot',
  transaction_type    = 'sale',
  transaction_variant = 'resale'
WHERE property_type = 'Plot [Sale]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'flat',
  transaction_type    = 'sale',
  transaction_variant = NULL
WHERE property_type = 'Flat Rate Finder'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'land',
  transaction_type    = 'sale',
  transaction_variant = NULL
WHERE property_type = 'Land Rate Finder'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'plot',
  transaction_type    = 'sale',
  transaction_variant = NULL
WHERE property_type = 'Plot Rate Finder'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'shop',
  transaction_type    = 'sale',
  transaction_variant = NULL
WHERE property_type = 'Shop Rate Finder'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'sez_plot',
  transaction_type    = 'purchase',
  transaction_variant = 'resale'
WHERE property_type = 'SEZ [Plot Purchase]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'sez_land',
  transaction_type    = 'purchase',
  transaction_variant = 'resale'
WHERE property_type = 'SEZ [Land Purchase]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'sez_plot',
  transaction_type    = 'sale',
  transaction_variant = 'resale'
WHERE property_type = 'SEZ [Plot Sale]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'sez_land',
  transaction_type    = 'sale',
  transaction_variant = 'resale'
WHERE property_type = 'SEZ [Land Sale]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'shop',
  transaction_type    = 'lease_in',
  transaction_variant = NULL
WHERE property_type = 'Shop [Resale Lease In]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'shop',
  transaction_type    = 'lease_in',
  transaction_variant = 'new'
WHERE property_type = 'Shop [New Lease In]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'shop',
  transaction_type    = 'lease_out',
  transaction_variant = NULL
WHERE property_type = 'Shop [Resale Lease Out]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'shop',
  transaction_type    = 'lease_out',
  transaction_variant = 'new'
WHERE property_type = 'Shop [New Lease Out]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'shop',
  transaction_type    = 'purchase',
  transaction_variant = 'resale'
WHERE property_type = 'Shop [Resale Purchase]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'shop',
  transaction_type    = 'purchase',
  transaction_variant = 'new'
WHERE property_type = 'Shop [New Purchase]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'shop',
  transaction_type    = 'rent_in',
  transaction_variant = NULL
WHERE property_type = 'Shop [Resale Rent In]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'shop',
  transaction_type    = 'rent_in',
  transaction_variant = 'new'
WHERE property_type = 'Shop [New Rent In]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'shop',
  transaction_type    = 'rent_out',
  transaction_variant = NULL
WHERE property_type = 'Shop [Resale Rent Out]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'shop',
  transaction_type    = 'rent_out',
  transaction_variant = 'new'
WHERE property_type = 'Shop [New Rent Out]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'shop',
  transaction_type    = 'sale',
  transaction_variant = 'resale'
WHERE property_type = 'Shop [Re-Sale]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'shop',
  transaction_type    = 'sale',
  transaction_variant = 'new'
WHERE property_type = 'Shop [New Sale]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'tdr',
  transaction_type    = 'sale',
  transaction_variant = 'resale'
WHERE property_type = 'TDR[Sale]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'tdr',
  transaction_type    = 'sale',
  transaction_variant = 'resale'
WHERE property_type = 'TDR [Sale]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'tdr',
  transaction_type    = 'purchase',
  transaction_variant = NULL
WHERE property_type = 'TDR [In]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'bank_auction',
  transaction_type    = 'sale',
  transaction_variant = 'resale'
WHERE property_type = 'Bank Auction [Re-Sale]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'industrial_plot',
  transaction_type    = 'sale',
  transaction_variant = 'resale'
WHERE property_type = 'Industrial Plot [Re-Sale]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'pre_leased_property',
  transaction_type    = 'sale',
  transaction_variant = 'resale'
WHERE property_type = 'Pre-Leased Property [Re-Sale]'
  AND deleted_at IS NULL;
UPDATE inventory_properties SET
  property_type       = 'project_registration',
  transaction_type    = 'sale',
  transaction_variant = 'resale'
WHERE property_type = 'Project [Re-Sale]'
  AND deleted_at IS NULL;

-- ---- enquiry_properties --------------------------------------
UPDATE enquiry_properties SET
  property_type       = 'bungalow',
  transaction_type    = 'lease_in',
  transaction_variant = NULL
WHERE property_type = 'Bunglow [Resale Lease In]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'bungalow',
  transaction_type    = 'lease_in',
  transaction_variant = 'new'
WHERE property_type = 'Bunglow [New Lease In]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'bungalow',
  transaction_type    = 'lease_out',
  transaction_variant = NULL
WHERE property_type = 'Bunglow [Resale Lease Out]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'bungalow',
  transaction_type    = 'lease_out',
  transaction_variant = 'new'
WHERE property_type = 'Bunglow [New Lease Out]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'bungalow',
  transaction_type    = 'purchase',
  transaction_variant = 'resale'
WHERE property_type = 'Bunglow [Resale Purchase]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'bungalow',
  transaction_type    = 'purchase',
  transaction_variant = 'new'
WHERE property_type = 'Bunglow [New Purchase]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'bungalow',
  transaction_type    = 'rent_in',
  transaction_variant = NULL
WHERE property_type = 'Bunglow [Resale Rent In]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'bungalow',
  transaction_type    = 'rent_in',
  transaction_variant = 'new'
WHERE property_type = 'Bunglow [New Rent In]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'bungalow',
  transaction_type    = 'rent_out',
  transaction_variant = NULL
WHERE property_type = 'Bunglow [Resale Rent Out]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'bungalow',
  transaction_type    = 'rent_out',
  transaction_variant = 'new'
WHERE property_type = 'Bunglow [New Rent Out]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'bungalow',
  transaction_type    = 'sale',
  transaction_variant = 'resale'
WHERE property_type = 'Bunglow [Re-Sale]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'bungalow',
  transaction_type    = 'sale',
  transaction_variant = 'new'
WHERE property_type = 'Bunglow [New Sale]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'paying_guest',
  transaction_type    = 'paying_guest',
  transaction_variant = NULL
WHERE property_type = 'Bunglow [Paying Guest]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'paying_guest',
  transaction_type    = 'paying_guest',
  transaction_variant = NULL
WHERE property_type = 'Bunglow [Paying Guest Out]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'commercial_space',
  transaction_type    = 'lease_in',
  transaction_variant = NULL
WHERE property_type = 'Commercial Space [Lease In Resale Commercial Space]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'commercial_space',
  transaction_type    = 'lease_in',
  transaction_variant = 'new'
WHERE property_type = 'Commercial Space [Lease In New Commercial Space]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'commercial_space',
  transaction_type    = 'lease_out',
  transaction_variant = NULL
WHERE property_type = 'Commercial Space [Lease Out Resale Commercial Space]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'commercial_space',
  transaction_type    = 'lease_out',
  transaction_variant = 'new'
WHERE property_type = 'Commercial Space [Lease Out New Commercial Space]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'commercial_space',
  transaction_type    = 'purchase',
  transaction_variant = 'resale'
WHERE property_type = 'Commercial Space [Resale Purchase]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'commercial_space',
  transaction_type    = 'purchase',
  transaction_variant = 'new'
WHERE property_type = 'Commercial Space [New Purchase]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'commercial_space',
  transaction_type    = 'rent_in',
  transaction_variant = NULL
WHERE property_type = 'Commercial Space [Resale Rent In]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'commercial_space',
  transaction_type    = 'rent_in',
  transaction_variant = 'new'
WHERE property_type = 'Commercial Space [New Rent In]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'commercial_space',
  transaction_type    = 'rent_out',
  transaction_variant = NULL
WHERE property_type = 'Commercial Space [Resale Rent Out]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'commercial_space',
  transaction_type    = 'rent_out',
  transaction_variant = 'new'
WHERE property_type = 'Commercial Space [New Rent Out]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'commercial_space',
  transaction_type    = 'sale',
  transaction_variant = 'resale'
WHERE property_type = 'Commercial Space [Re-Sale]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'commercial_space',
  transaction_type    = 'sale',
  transaction_variant = 'new'
WHERE property_type = 'Commercial Space [New Sale]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'flat',
  transaction_type    = 'joint_venture',
  transaction_variant = NULL
WHERE property_type = 'Flat [Joint Venture]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'flat',
  transaction_type    = 'lease_in',
  transaction_variant = NULL
WHERE property_type = 'Flat [Resale Lease In]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'flat',
  transaction_type    = 'lease_in',
  transaction_variant = 'new'
WHERE property_type = 'Flat [New Lease In]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'flat',
  transaction_type    = 'lease_out',
  transaction_variant = NULL
WHERE property_type = 'Flat [Resale Lease Out]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'flat',
  transaction_type    = 'lease_out',
  transaction_variant = 'new'
WHERE property_type = 'Flat [New Lease Out]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'flat',
  transaction_type    = 'purchase',
  transaction_variant = 'resale'
WHERE property_type = 'Flat [Resale Purchase]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'flat',
  transaction_type    = 'purchase',
  transaction_variant = 'new'
WHERE property_type = 'Flat [New Purchase]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'flat',
  transaction_type    = 'rent_in',
  transaction_variant = NULL
WHERE property_type = 'Flat [Resale Rent In]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'flat',
  transaction_type    = 'rent_in',
  transaction_variant = 'new'
WHERE property_type = 'Flat [New Rent In]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'flat',
  transaction_type    = 'rent_out',
  transaction_variant = NULL
WHERE property_type = 'Flat [Resale Rent Out]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'flat',
  transaction_type    = 'rent_out',
  transaction_variant = 'new'
WHERE property_type = 'Flat [New Rent Out]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'flat',
  transaction_type    = 'sale',
  transaction_variant = 'resale'
WHERE property_type = 'Flat [Re-Sale]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'flat',
  transaction_type    = 'sale',
  transaction_variant = 'new'
WHERE property_type = 'Flat [New Sale]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'paying_guest',
  transaction_type    = 'paying_guest',
  transaction_variant = NULL
WHERE property_type = 'Flat [Paying Guest]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'paying_guest',
  transaction_type    = 'paying_guest',
  transaction_variant = NULL
WHERE property_type = 'Flat [Paying Guest Out]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'hospital',
  transaction_type    = 'sale',
  transaction_variant = 'resale'
WHERE property_type = 'Hospital [Re-Sale]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'hospital',
  transaction_type    = 'sale',
  transaction_variant = NULL
WHERE property_type = 'Hospital [Sell]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'hospital',
  transaction_type    = 'rent_out',
  transaction_variant = NULL
WHERE property_type = 'Hospital [Rent Out]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'hospital',
  transaction_type    = 'rent_in',
  transaction_variant = NULL
WHERE property_type = 'Hospital [Rent In]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'hostel',
  transaction_type    = 'hostel_let_in',
  transaction_variant = NULL
WHERE property_type = 'Hostel[Hostel Let In]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'hostel',
  transaction_type    = 'hostel_let_in',
  transaction_variant = NULL
WHERE property_type = 'Hostel [Hostel Let In]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'hostel',
  transaction_type    = 'hostel_let_out',
  transaction_variant = NULL
WHERE property_type = 'Hostel [Hostel Let Out]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'hotel',
  transaction_type    = 'sale',
  transaction_variant = NULL
WHERE property_type = 'Hotel [Sell]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'hotel',
  transaction_type    = 'rent_out',
  transaction_variant = NULL
WHERE property_type = 'Hotel [Rent Out]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'hotel',
  transaction_type    = 'purchase',
  transaction_variant = NULL
WHERE property_type = 'Hotel [Buy]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'hotel',
  transaction_type    = 'rent_in',
  transaction_variant = NULL
WHERE property_type = 'Hotel [Rent In]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'land',
  transaction_type    = 'lease_in',
  transaction_variant = NULL
WHERE property_type = 'Land [Lease In]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'land',
  transaction_type    = 'lease_out',
  transaction_variant = NULL
WHERE property_type = 'Land [Lease Out]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'land',
  transaction_type    = 'purchase',
  transaction_variant = 'resale'
WHERE property_type = 'Land [Purchase]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'land',
  transaction_type    = 'rent_in',
  transaction_variant = NULL
WHERE property_type = 'Land [Rent In]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'land',
  transaction_type    = 'rent_out',
  transaction_variant = NULL
WHERE property_type = 'Land [Rent Out]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'land',
  transaction_type    = 'sale',
  transaction_variant = 'resale'
WHERE property_type = 'Land [Sale]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'plot',
  transaction_type    = 'lease_in',
  transaction_variant = NULL
WHERE property_type = 'Plot [Lease In]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'plot',
  transaction_type    = 'lease_out',
  transaction_variant = NULL
WHERE property_type = 'Plot [Lease Out]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'plot',
  transaction_type    = 'purchase',
  transaction_variant = 'resale'
WHERE property_type = 'Plot [Purchase]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'plot',
  transaction_type    = 'rent_in',
  transaction_variant = NULL
WHERE property_type = 'Plot [Rent In]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'plot',
  transaction_type    = 'rent_out',
  transaction_variant = NULL
WHERE property_type = 'Plot [Rent Out]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'plot',
  transaction_type    = 'sale',
  transaction_variant = 'resale'
WHERE property_type = 'Plot [Sale]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'flat',
  transaction_type    = 'sale',
  transaction_variant = NULL
WHERE property_type = 'Flat Rate Finder'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'land',
  transaction_type    = 'sale',
  transaction_variant = NULL
WHERE property_type = 'Land Rate Finder'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'plot',
  transaction_type    = 'sale',
  transaction_variant = NULL
WHERE property_type = 'Plot Rate Finder'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'shop',
  transaction_type    = 'sale',
  transaction_variant = NULL
WHERE property_type = 'Shop Rate Finder'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'sez_plot',
  transaction_type    = 'purchase',
  transaction_variant = 'resale'
WHERE property_type = 'SEZ [Plot Purchase]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'sez_land',
  transaction_type    = 'purchase',
  transaction_variant = 'resale'
WHERE property_type = 'SEZ [Land Purchase]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'sez_plot',
  transaction_type    = 'sale',
  transaction_variant = 'resale'
WHERE property_type = 'SEZ [Plot Sale]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'sez_land',
  transaction_type    = 'sale',
  transaction_variant = 'resale'
WHERE property_type = 'SEZ [Land Sale]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'shop',
  transaction_type    = 'lease_in',
  transaction_variant = NULL
WHERE property_type = 'Shop [Resale Lease In]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'shop',
  transaction_type    = 'lease_in',
  transaction_variant = 'new'
WHERE property_type = 'Shop [New Lease In]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'shop',
  transaction_type    = 'lease_out',
  transaction_variant = NULL
WHERE property_type = 'Shop [Resale Lease Out]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'shop',
  transaction_type    = 'lease_out',
  transaction_variant = 'new'
WHERE property_type = 'Shop [New Lease Out]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'shop',
  transaction_type    = 'purchase',
  transaction_variant = 'resale'
WHERE property_type = 'Shop [Resale Purchase]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'shop',
  transaction_type    = 'purchase',
  transaction_variant = 'new'
WHERE property_type = 'Shop [New Purchase]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'shop',
  transaction_type    = 'rent_in',
  transaction_variant = NULL
WHERE property_type = 'Shop [Resale Rent In]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'shop',
  transaction_type    = 'rent_in',
  transaction_variant = 'new'
WHERE property_type = 'Shop [New Rent In]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'shop',
  transaction_type    = 'rent_out',
  transaction_variant = NULL
WHERE property_type = 'Shop [Resale Rent Out]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'shop',
  transaction_type    = 'rent_out',
  transaction_variant = 'new'
WHERE property_type = 'Shop [New Rent Out]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'shop',
  transaction_type    = 'sale',
  transaction_variant = 'resale'
WHERE property_type = 'Shop [Re-Sale]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'shop',
  transaction_type    = 'sale',
  transaction_variant = 'new'
WHERE property_type = 'Shop [New Sale]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'tdr',
  transaction_type    = 'sale',
  transaction_variant = 'resale'
WHERE property_type = 'TDR[Sale]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'tdr',
  transaction_type    = 'sale',
  transaction_variant = 'resale'
WHERE property_type = 'TDR [Sale]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'tdr',
  transaction_type    = 'purchase',
  transaction_variant = NULL
WHERE property_type = 'TDR [In]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'bank_auction',
  transaction_type    = 'sale',
  transaction_variant = 'resale'
WHERE property_type = 'Bank Auction [Re-Sale]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'industrial_plot',
  transaction_type    = 'sale',
  transaction_variant = 'resale'
WHERE property_type = 'Industrial Plot [Re-Sale]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'pre_leased_property',
  transaction_type    = 'sale',
  transaction_variant = 'resale'
WHERE property_type = 'Pre-Leased Property [Re-Sale]'
  AND deleted_at IS NULL;
UPDATE enquiry_properties SET
  property_type       = 'project_registration',
  transaction_type    = 'sale',
  transaction_variant = 'resale'
WHERE property_type = 'Project [Re-Sale]'
  AND deleted_at IS NULL;

-- Step 3: verification counts (post-update). Both tables should return
-- zero rows matching any bad label. If a non-zero row appears here on a
-- second run, that indicates a bad label the mapping table does not yet
-- cover.

SELECT
  'inventory_properties (post-fix)' AS source_table,
  property_type AS remaining_bad_value,
  COUNT(*) AS remaining_rows
FROM inventory_properties
WHERE deleted_at IS NULL
  AND (property_type LIKE '%[%' OR property_type LIKE '%]%')
GROUP BY property_type
UNION ALL
SELECT
  'enquiry_properties (post-fix)' AS source_table,
  property_type AS remaining_bad_value,
  COUNT(*) AS remaining_rows
FROM enquiry_properties
WHERE deleted_at IS NULL
  AND (property_type LIKE '%[%' OR property_type LIKE '%]%')
GROUP BY property_type;