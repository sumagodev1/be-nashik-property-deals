-- Migration 126: give Website Properties its own canonical Posting Date.
--
-- Inventory and Enquiry already have posting_date. The original Website
-- schema never created registration_date, so reports must not use that
-- missing column or substitute created_at/available_from_date. Historical
-- Website rows remain NULL until their real posting date is known; new
-- submissions are stamped by the insert query with the submission date.

ALTER TABLE website_properties
  ADD COLUMN posting_date DATE NULL DEFAULT NULL
    COMMENT 'Posting Date (seller/admin supplied; historical rows may be NULL)'
  AFTER property_code;

ALTER TABLE website_properties
  ADD KEY ix_website_posting_date (posting_date);
