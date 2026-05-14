-- ===========================================================
-- Migration 006: switch buyer lead + general-enquiry OTP to
-- mobile-only. Email becomes optional on leads.
-- ===========================================================

ALTER TABLE leads
  MODIFY COLUMN buyer_email VARCHAR(255) NULL;
