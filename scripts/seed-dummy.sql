-- Dummy data for local development. Safe to re-run: uses INSERT IGNORE on
-- the natural unique keys (mobile_number for sellers, property_code for
-- properties). Idempotent.

USE nashik_property_deals;

-- ============================ SELLERS ===================================
INSERT IGNORE INTO sellers
  (user_type, full_name, mobile_number, email, area, is_active, is_verified)
VALUES
  ('owner', 'Rajesh Patil',     '9822001001', 'rajesh.patil@example.com',     'Gangapur Road',  1, 1),
  ('owner', 'Priya Deshmukh',   '9822001002', 'priya.deshmukh@example.com',   'College Road',   1, 1),
  ('agent', 'Sandeep Kulkarni', '9822001003', 'sandeep.k@nashikrealty.test',  'Indira Nagar',   1, 1),
  ('agent', 'Anjali Joshi',     '9822001004', 'anjali.j@maharashtraprop.test','Panchavati',     1, 1),
  ('owner', 'Vikram Shinde',    '9822001005', 'vikram.shinde@example.com',    'Adgaon',         1, 1);

-- Add agency details for the agents
UPDATE sellers SET agency_name='Nashik Realty Advisors',  business_address='Shop 4, Sharanpur Road, Nashik' WHERE mobile_number='9822001003';
UPDATE sellers SET agency_name='Maharashtra Properties',  business_address='Office 12, College Road, Nashik' WHERE mobile_number='9822001004';

-- ======================== WEBSITE PROPERTIES ============================
-- Approval is the public-visibility gate; the homepage shows only approved + active.
INSERT IGNORE INTO website_properties
  (property_code, seller_id, title, description, property_type, transaction_type,
   location, latitude, longitude, area_value, area_unit, bhk, price,
   approval_status, is_active, is_featured, approved_at)
VALUES
  ('WP-1001', (SELECT id FROM sellers WHERE mobile_number='9822001001'),
   '2 BHK Spacious Flat near Gangapur Road',
   'Well-ventilated 2BHK with covered parking, gym and 24x7 security. Walking distance to schools and bus stop.',
   'flat', 'sale',
   'Gangapur Road, Nashik', 19.9975, 73.7898, 950, 'sqft', '2BHK', 6500000.00,
   'approved', 1, 1, NOW()),

  ('WP-1002', (SELECT id FROM sellers WHERE mobile_number='9822001002'),
   '3 BHK Premium Flat at College Road',
   'High-floor 3BHK with city view, modular kitchen, two-tier security and clubhouse access.',
   'flat', 'sale',
   'College Road, Nashik', 20.0017, 73.7720, 1450, 'sqft', '3BHK', 9500000.00,
   'approved', 1, 1, NOW()),

  ('WP-1003', (SELECT id FROM sellers WHERE mobile_number='9822001003'),
   'Independent House in Indira Nagar',
   '4BHK independent house with private garden, terrace and dedicated car porch.',
   'house', 'sale',
   'Indira Nagar, Nashik', 19.9700, 73.7558, 2100, 'sqft', '4BHK', 15000000.00,
   'approved', 1, 0, NOW()),

  ('WP-1004', (SELECT id FROM sellers WHERE mobile_number='9822001004'),
   'Luxury Villa in Panchavati',
   'Gated-community villa with private pool, landscaped lawn, and home automation.',
   'villa', 'sale',
   'Panchavati, Nashik', 20.0186, 73.7956, 3200, 'sqft', '4BHK', 27500000.00,
   'approved', 1, 1, NOW()),

  ('WP-1005', (SELECT id FROM sellers WHERE mobile_number='9822001005'),
   'Residential Plot at Adgaon',
   'Open NA plot, clear title, road-facing, ready for construction. East-facing with corner location.',
   'plot', 'sale',
   'Adgaon, Nashik', 20.0414, 73.8378, 2400, 'sqft', NULL, 3500000.00,
   'approved', 1, 0, NOW()),

  ('WP-1006', (SELECT id FROM sellers WHERE mobile_number='9822001003'),
   'Commercial Shop on Satpur MIDC',
   'Ground-floor commercial shop on the main road, ideal for retail or showroom.',
   'commercial', 'sale',
   'Satpur, Nashik', 19.9994, 73.7300, 650, 'sqft', NULL, 8000000.00,
   'approved', 1, 0, NOW()),

  ('WP-1007', (SELECT id FROM sellers WHERE mobile_number='9822001005'),
   'Agricultural Land near Mhasrul',
   'Fertile 1-acre agricultural land with bore-well and shed. Suitable for grape / vegetable cultivation.',
   'agricultural', 'sale',
   'Mhasrul, Nashik', 20.0489, 73.7872, 43560, 'sqft', NULL, 1800000.00,
   'approved', 1, 0, NOW()),

  ('WP-1008', (SELECT id FROM sellers WHERE mobile_number='9822001002'),
   '1 BHK Flat for Rent at Pathardi Phata',
   'Semi-furnished 1BHK, includes wardrobe and kitchen cabinets. Two-wheeler parking included.',
   'flat', 'rent',
   'Pathardi Phata, Nashik', 19.9333, 73.8333, 550, 'sqft', '1BHK', 12000.00,
   'approved', 1, 0, NOW());

-- ======================== INVENTORY PROPERTIES ==========================
-- Internal-only (Admin Panel). NOT visible to website visitors.
INSERT IGNORE INTO inventory_properties
  (property_code, title, description, property_type, transaction_type,
   location, area_value, area_unit, bhk, price,
   status, owner_name, owner_contact, created_by_admin_id)
VALUES
  ('INV-2001', '2 BHK Flat in Tidke Colony',
   'Resale 2BHK on the 3rd floor, ready to move in.', 'flat', 'sale',
   'Tidke Colony, Nashik', 1050, 'sqft', '2BHK', 5800000.00,
   'available', 'Mr. Joshi', '9011223301', 1),

  ('INV-2002', 'Open Plot at Govind Nagar',
   'Corner NA plot, 30x40, east-facing.', 'plot', 'sale',
   'Govind Nagar, Nashik', 1200, 'sqft', NULL, 2400000.00,
   'available', 'Mrs. Bhonsle', '9011223302', 1),

  ('INV-2003', 'Commercial Office on Untwadi Road',
   '1st floor office space with two cabins, pantry and washroom.', 'commercial', 'lease',
   'Untwadi Road, Nashik', 800, 'sqft', NULL, 35000.00,
   'available', 'Mr. Bagul', '9011223303', 1),

  ('INV-2004', 'Bunglow in Cidco',
   'East-facing 3BHK bunglow with car porch and small garden.', 'bunglow', 'sale',
   'Cidco, Nashik', 2400, 'sqft', '3BHK', 12500000.00,
   'available', 'Mr. Pawar', '9011223304', 1);

-- ============================== SUMMARY =================================
SELECT '--- counts after seed ---' AS '';
SELECT (SELECT COUNT(*) FROM admins)              AS admins,
       (SELECT COUNT(*) FROM sellers)             AS sellers,
       (SELECT COUNT(*) FROM website_properties)  AS website_properties,
       (SELECT COUNT(*) FROM inventory_properties) AS inventory_properties;
