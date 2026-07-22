-- ===========================================================
-- 069 — Phone Book Designation master
-- ===========================================================
-- Seeds the `phone_book_designation` vocabulary in `master_lookups`.
-- Independent from `business_associate_designation` — the Phone Book
-- module is a fully separate module and keeps its own designation
-- vocabulary so admins can curate contact-side designations without
-- affecting the Business Associates list (and vice versa).
--
-- The Admin master surface renders this as "Phone book designatio"
-- (label from services/masters/management.js).
-- ===========================================================

SET NAMES utf8mb4;

INSERT IGNORE INTO master_lookups (master_key, code, label, sort_order, is_active) VALUES
  ('phone_book_designation', 'client',              'Client',              10, 1),
  ('phone_book_designation', 'customer',            'Customer',            20, 1),
  ('phone_book_designation', 'vendor',              'Vendor',              30, 1),
  ('phone_book_designation', 'partner',             'Partner',             40, 1),
  ('phone_book_designation', 'employee',            'Employee',            50, 1),
  ('phone_book_designation', 'consultant',          'Consultant',          60, 1),
  ('phone_book_designation', 'friend',              'Friend',              70, 1),
  ('phone_book_designation', 'family',              'Family',              80, 1),
  ('phone_book_designation', 'personal',            'Personal',            90, 1),
  ('phone_book_designation', 'contractor',          'Contractor',         100, 1),
  ('phone_book_designation', 'service-provider',    'Service Provider',   110, 1),
  ('phone_book_designation', 'supplier',            'Supplier',           120, 1),
  ('phone_book_designation', 'government',          'Government Contact', 130, 1);
