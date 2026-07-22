-- ===========================================================
-- 063 — Property Form Catalog + Master parent-code cascade
-- ===========================================================
-- T-2026-058: Move the (Property Type, Transaction Type, Property
-- Variety) → form-code dependency graph out of the frontend
-- chooserTree.js and the backend formCodeCatalog.js into the
-- database, so both surfaces read the same data instead of each
-- maintaining a parallel copy.
--
-- Three additive operations, all idempotent:
--
--   1. CREATE TABLE master_property_forms
--      Every registered form is one row. Columns:
--        form_code             — routing key (e.g. bunglow-resale-lease-out)
--        mode                  — 'inventory' | 'enquiry'
--        property_type_code    — matches master_property_types.code
--        transaction_type_code — matches master_transaction_types.code
--        property_variety_code — matches master_lookups.code
--                                (WHERE master_key='property_variety'),
--                                NULL when the form has no variety step
--        label                 — human display for the admin
--        sort_order            — admin-controlled ordering
--        is_active             — soft on/off
--        deleted_at            — soft delete
--
--   2. ADD COLUMNS parent-code cross-links on the transaction/variety
--      masters (guarded on information_schema so re-runs are safe):
--
--        master_transaction_types.parent_property_type_code
--        master_lookups.parent_transaction_type_code
--          (only meaningful for master_key='property_variety')
--
--      These are OPTIONAL — the authoritative cascade is
--      `master_property_forms`. The parent-code columns let the
--      admin Masters UI enforce "you must pick a parent PT/TT
--      when adding a variety" without querying the form catalog
--      on every keystroke.
--
--   3. SEED master_property_forms with the 89 form rows extracted
--      from the current FE chooserTree.js. INSERT IGNORE + ON
--      DUPLICATE KEY UPDATE so re-runs refresh label / sort_order
--      / is_active while preserving id + created_at.
--
-- Backward compatibility notes:
--   * Nothing in inventory_properties / enquiry_properties changes.
--   * The FE hardcoded tree stays in place as a fallback until the
--     new API endpoint is deployed; once /public/property-catalog
--     returns rows the FE hook auto-swaps to the DB tree.
--   * The BE formCodeCatalog.js validator continues to work — the
--     new service `propertyFormCatalog` reads master_property_forms
--     for authoritative validation but falls back to the JS catalog
--     when the table is empty (still-migrating environments).
--
-- Rollback: soft. Dropping the table + the two parent-code columns
-- reverts to the pre-063 architecture — the FE tree and BE JS
-- catalog resume driving everything unaided.
-- ===========================================================

-- ────────────────────────────────────────────────────────────
-- 1. master_property_forms — the authoritative dependency graph
-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS master_property_forms (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  form_code             VARCHAR(80)  NOT NULL,
  mode                  ENUM('inventory','enquiry') NOT NULL,
  property_type_code    VARCHAR(64)  NOT NULL,
  transaction_type_code VARCHAR(64)  NOT NULL,
  property_variety_code VARCHAR(64)  NULL,
  label                 VARCHAR(200) NULL,
  sort_order            INT NOT NULL DEFAULT 100,
  is_active             TINYINT(1) NOT NULL DEFAULT 1,
  created_at            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at            TIMESTAMP NULL DEFAULT NULL,
  UNIQUE KEY uk_form_code_mode (form_code, mode),
  KEY idx_cascade (mode, property_type_code, transaction_type_code, property_variety_code),
  KEY idx_active  (is_active, deleted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ────────────────────────────────────────────────────────────
-- 2. Parent-code columns on the transaction / variety masters
-- ────────────────────────────────────────────────────────────

-- master_transaction_types.parent_property_type_code
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name   = 'master_transaction_types'
    AND column_name  = 'parent_property_type_code'
);
SET @sql := IF(@col_exists = 0,
  'ALTER TABLE master_transaction_types ADD COLUMN parent_property_type_code VARCHAR(64) NULL AFTER code',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- master_lookups.parent_transaction_type_code
--   (parent_code already exists — added by migration 026 for the
--   generic hierarchical vocabularies. This column is the SECOND
--   parent used by property_variety, keyed by the master_key.)
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name   = 'master_lookups'
    AND column_name  = 'parent_transaction_type_code'
);
SET @sql := IF(@col_exists = 0,
  'ALTER TABLE master_lookups ADD COLUMN parent_transaction_type_code VARCHAR(64) NULL AFTER parent_code',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ────────────────────────────────────────────────────────────
-- 3. Seed master_property_forms from the FE chooserTree
--    Rows extracted by tools/exportChooserTree.js. Idempotent:
--    duplicate form_code/mode pairs refresh label + sort_order.
-- ────────────────────────────────────────────────────────────

INSERT INTO master_property_forms
  (form_code, mode, property_type_code, transaction_type_code, property_variety_code, label, sort_order)
VALUES
  ("bunglow-resale-lease-out", "inventory", "bungalow", "lease_out", "resale", "Bungalow [Lease Out Resale]", 10),
  ("bunglow-new-lease-out", "inventory", "bungalow", "lease_out", "new", "Bungalow [Lease Out New]", 20),
  ("bunglow-resale-rent-out", "inventory", "bungalow", "rent_out", "resale", "Bungalow [Rent Out Resale]", 30),
  ("bunglow-new-rent-out", "inventory", "bungalow", "rent_out", "new", "Bungalow [Rent Out New]", 40),
  ("bunglow-resale", "inventory", "bungalow", "sale", "resale", "Bungalow [Sale Resale]", 50),
  ("bunglow-new-sale", "inventory", "bungalow", "sale", "new", "Bungalow [Sale New]", 60),
  ("commercial-lease-out-resale", "inventory", "commercial_space", "lease_out", "resale", "Commercial Space [Lease Out Resale]", 70),
  ("commercial-lease-out-new", "inventory", "commercial_space", "lease_out", "new", "Commercial Space [Lease Out New]", 80),
  ("commercial-resale-rent-out", "inventory", "commercial_space", "rent_out", "resale", "Commercial Space [Rent Out Resale]", 90),
  ("commercial-new-rent-out", "inventory", "commercial_space", "rent_out", "new", "Commercial Space [Rent Out New]", 100),
  ("commercial-resale", "inventory", "commercial_space", "sale", "resale", "Commercial Space [Sale Resale]", 110),
  ("commercial-new-sale", "inventory", "commercial_space", "sale", "new", "Commercial Space [Sale New]", 120),
  ("flat-resale-lease-out", "inventory", "flat", "lease_out", "resale", "Flat [Lease Out Resale]", 130),
  ("flat-new-lease-out", "inventory", "flat", "lease_out", "new", "Flat [Lease Out New]", 140),
  ("flat-resale-rent-out", "inventory", "flat", "rent_out", "resale", "Flat [Rent Out Resale]", 150),
  ("flat-new-rent-out", "inventory", "flat", "rent_out", "new", "Flat [Rent Out New]", 160),
  ("flat-resale", "inventory", "flat", "sale", "resale", "Flat [Sale Resale]", 170),
  ("flat-new-sale", "inventory", "flat", "sale", "new", "Flat [Sale New]", 180),
  ("flat-joint-venture", "inventory", "flat", "joint_venture", NULL, "Flat [Joint Venture]", 190),
  ("hospital-rent-out", "inventory", "hospital", "rent_out", NULL, "Hospital [Rent Out]", 200),
  ("hospital-sell", "inventory", "hospital", "sell", NULL, "Hospital [Sell]", 210),
  ("hostel-let-out", "inventory", "hostel", "let_out", NULL, "Hostel [Let Out]", 220),
  ("hotel-rent-out", "inventory", "hotel", "rent_out", NULL, "Hotel [Rent Out]", 230),
  ("hotel-sell", "inventory", "hotel", "sell", NULL, "Hotel [Sell]", 240),
  ("land-lease-out", "inventory", "land", "lease_out", NULL, "Land [Lease Out]", 250),
  ("land-rent-out", "inventory", "land", "rent_out", NULL, "Land [Rent Out]", 260),
  ("land-sale", "inventory", "land", "sale", NULL, "Land [Sale]", 270),
  ("paying-guest-bunglow-out", "inventory", "paying_guest", "out", "bungalow", "Paying Guest [Out Bungalow]", 280),
  ("paying-guest-flat-out", "inventory", "paying_guest", "out", "flat", "Paying Guest [Out Flat]", 290),
  ("plot-lease-out", "inventory", "plot", "lease_out", NULL, "Plot [Lease Out]", 300),
  ("plot-rent-out", "inventory", "plot", "rent_out", NULL, "Plot [Rent Out]", 310),
  ("plot-sale", "inventory", "plot", "sale", NULL, "Plot [Sale]", 320),
  ("sez-land-sale", "inventory", "sez_land", "sale", NULL, "SEZ Land [Sale]", 330),
  ("sez-plot-sale", "inventory", "sez_plot", "sale", NULL, "SEZ Plot [Sale]", 340),
  ("shop-resale-lease-out", "inventory", "shop", "lease_out", "resale", "Shop [Lease Out Resale]", 350),
  ("shop-new-lease-out", "inventory", "shop", "lease_out", "new", "Shop [Lease Out New]", 360),
  ("shop-resale-rent-out", "inventory", "shop", "rent_out", "resale", "Shop [Rent Out Resale]", 370),
  ("shop-new-rent-out", "inventory", "shop", "rent_out", "new", "Shop [Rent Out New]", 380),
  ("shop-resale", "inventory", "shop", "sale", "resale", "Shop [Sale Resale]", 390),
  ("shop-new-sale", "inventory", "shop", "sale", "new", "Shop [Sale New]", 400),
  ("tdr-sale", "inventory", "tdr", "out", NULL, "TDR [Out]", 410),
  ("bank-auction-resale", "enquiry", "bank_auction", "purchase", "resale", "Bank Auction [Purchase Resale]", 10),
  ("bunglow-resale-lease-in", "enquiry", "bungalow", "lease_in", "resale", "Bungalow [Lease In Resale]", 20),
  ("bunglow-new-lease-in", "enquiry", "bungalow", "lease_in", "new", "Bungalow [Lease In New]", 30),
  ("bunglow-resale-purchase", "enquiry", "bungalow", "purchase", "resale", "Bungalow [Purchase Resale]", 40),
  ("bunglow-new-purchase", "enquiry", "bungalow", "purchase", "new", "Bungalow [Purchase New]", 50),
  ("bunglow-resale-rent-in", "enquiry", "bungalow", "rent_in", "resale", "Bungalow [Rent In Resale]", 60),
  ("bunglow-new-rent-in", "enquiry", "bungalow", "rent_in", "new", "Bungalow [Rent In New]", 70),
  ("paying-guest-bunglow", "enquiry", "bungalow", "paying_guest", NULL, "Bungalow [Paying Guest]", 80),
  ("commercial-lease-in-resale", "enquiry", "commercial_space", "lease_in", "resale", "Commercial Space [Lease In Resale]", 90),
  ("commercial-lease-in-new", "enquiry", "commercial_space", "lease_in", "new", "Commercial Space [Lease In New]", 100),
  ("commercial-resale-purchase", "enquiry", "commercial_space", "purchase", "resale", "Commercial Space [Purchase Resale]", 110),
  ("commercial-new-purchase", "enquiry", "commercial_space", "purchase", "new", "Commercial Space [Purchase New]", 120),
  ("commercial-resale-rent-in", "enquiry", "commercial_space", "rent_in", "resale", "Commercial Space [Rent In Resale]", 130),
  ("commercial-new-rent-in", "enquiry", "commercial_space", "rent_in", "new", "Commercial Space [Rent In New]", 140),
  ("flat-resale-lease-in", "enquiry", "flat", "lease_in", "resale", "Flat [Lease In Resale]", 150),
  ("flat-new-lease-in", "enquiry", "flat", "lease_in", "new", "Flat [Lease In New]", 160),
  ("flat-resale-purchase", "enquiry", "flat", "purchase", "resale", "Flat [Purchase Resale]", 170),
  ("flat-new-purchase", "enquiry", "flat", "purchase", "new", "Flat [Purchase New]", 180),
  ("flat-resale-rent-in", "enquiry", "flat", "rent_in", "resale", "Flat [Rent In Resale]", 190),
  ("flat-new-rent-in", "enquiry", "flat", "rent_in", "new", "Flat [Rent In New]", 200),
  ("paying-guest-flat", "enquiry", "flat", "paying_guest", NULL, "Flat [Paying Guest]", 210),
  ("flat-rate-finder", "enquiry", "flat", "rate_finder", NULL, "Flat [Rate Finder]", 220),
  ("hospital-resale", "enquiry", "hospital", "buy", NULL, "Hospital [Buy]", 230),
  ("hospital-rent-in", "enquiry", "hospital", "rent_in", NULL, "Hospital [Rent In]", 240),
  ("hostel-let-in", "enquiry", "hostel", "let_in", NULL, "Hostel [Let In]", 250),
  ("hotel-buy", "enquiry", "hotel", "buy", NULL, "Hotel [Buy]", 260),
  ("hotel-rent-in", "enquiry", "hotel", "rent_in", NULL, "Hotel [Rent In]", 270),
  ("industrial-plot-resale", "enquiry", "industrial_plot", "purchase", "resale", "Industrial Plot [Purchase Resale]", 280),
  ("land-lease-in", "enquiry", "land", "lease_in", NULL, "Land [Lease In]", 290),
  ("land-purchase", "enquiry", "land", "purchase", NULL, "Land [Purchase]", 300),
  ("land-rent-in", "enquiry", "land", "rent_in", NULL, "Land [Rent In]", 310),
  ("land-rate-finder", "enquiry", "land", "rate_finder", NULL, "Land [Rate Finder]", 320),
  ("plot-lease-in", "enquiry", "plot", "lease_in", NULL, "Plot [Lease In]", 330),
  ("plot-purchase", "enquiry", "plot", "purchase", NULL, "Plot [Purchase]", 340),
  ("plot-rent-in", "enquiry", "plot", "rent_in", NULL, "Plot [Rent In]", 350),
  ("plot-rate-finder", "enquiry", "plot", "rate_finder", NULL, "Plot [Rate Finder]", 360),
  ("pre-leased-resale", "enquiry", "pre_leased_property", "purchase", "resale", "Pre-Leased Property [Purchase Resale]", 370),
  ("project-resale", "enquiry", "project_registration", "registration", "resale", "Project Registration [Registration Resale]", 380),
  ("sez-land-purchase", "enquiry", "sez_land", "purchase", NULL, "SEZ Land [Purchase]", 390),
  ("sez-plot-purchase", "enquiry", "sez_plot", "purchase", NULL, "SEZ Plot [Purchase]", 400),
  ("shop-resale-lease-in", "enquiry", "shop", "lease_in", "resale", "Shop [Lease In Resale]", 410),
  ("shop-new-lease-in", "enquiry", "shop", "lease_in", "new", "Shop [Lease In New]", 420),
  ("shop-resale-purchase", "enquiry", "shop", "purchase", "resale", "Shop [Purchase Resale]", 430),
  ("shop-new-purchase", "enquiry", "shop", "purchase", "new", "Shop [Purchase New]", 440),
  ("shop-resale-rent-in", "enquiry", "shop", "rent_in", "resale", "Shop [Rent In Resale]", 450),
  ("shop-new-rent-in", "enquiry", "shop", "rent_in", "new", "Shop [Rent In New]", 460),
  ("shop-rate-finder", "enquiry", "shop", "rate_finder", NULL, "Shop [Rate Finder]", 470),
  ("tdr-in", "enquiry", "tdr", "in", NULL, "TDR [In]", 480)
ON DUPLICATE KEY UPDATE
  property_type_code    = VALUES(property_type_code),
  transaction_type_code = VALUES(transaction_type_code),
  property_variety_code = VALUES(property_variety_code),
  label                 = VALUES(label),
  sort_order            = VALUES(sort_order),
  is_active             = 1,
  deleted_at            = NULL;
