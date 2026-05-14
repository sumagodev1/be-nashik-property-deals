-- Extend OTP purpose enum to include seller_login.
-- MariaDB / MySQL allow ENUM additions via MODIFY COLUMN. Existing rows preserve their values.

ALTER TABLE otp_codes
  MODIFY COLUMN purpose ENUM('seller_register', 'seller_login', 'buyer_lead') NOT NULL;
