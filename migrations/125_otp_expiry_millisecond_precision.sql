-- Preserve the exact OTP expiry instant instead of truncating it to whole
-- seconds. Existing rows remain valid; their zero millisecond component is
-- retained and only newly issued rows use the added precision.
ALTER TABLE otp_codes
  MODIFY COLUMN expires_at DATETIME(3) NOT NULL;
