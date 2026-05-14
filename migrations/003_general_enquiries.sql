-- Make leads support general (non-property) enquiries from the Contact page.
-- 1. website_property_id becomes nullable.
-- 2. action_type enum gets a third value.
-- 3. FK switches to ON DELETE SET NULL so admin hard-deletes don't destroy
--    the buyer's enquiry record — we want it preserved for audit.

ALTER TABLE leads DROP FOREIGN KEY fk_leads_property;
ALTER TABLE leads MODIFY website_property_id BIGINT UNSIGNED NULL;
ALTER TABLE leads
  MODIFY action_type ENUM('contact_seller', 'view_location', 'general_enquiry') NOT NULL;
ALTER TABLE leads
  ADD CONSTRAINT fk_leads_property
  FOREIGN KEY (website_property_id) REFERENCES website_properties (id)
  ON DELETE SET NULL;
