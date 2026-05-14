-- ===========================================================
-- Migration 005: switch seller register/login OTP to mobile-based,
-- make email optional on seller profile.
-- ===========================================================

-- Email becomes an optional contact field on sellers (mobile remains the
-- unique key). Existing rows that have a value keep it.
ALTER TABLE sellers
  MODIFY COLUMN email VARCHAR(255) NULL;

-- OTP rows can now be keyed on mobile_number alone (seller flows) or on
-- email alone (buyer lead + general-enquiry flows that still use email).
ALTER TABLE otp_codes
  MODIFY COLUMN email VARCHAR(255) NULL;

-- Lookup index for the seller-side flows that now look up by mobile.
CREATE INDEX ix_otp_purpose_mobile ON otp_codes (purpose, mobile_number);
