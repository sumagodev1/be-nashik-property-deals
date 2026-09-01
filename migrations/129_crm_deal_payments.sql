-- ============================================================================
-- 129_crm_deal_payments.sql
--
-- Deal / Payment Details for a CRM lead that has reached the "Converted to
-- Deal" stage: an advance amount plus up to ten installments, each with its
-- own date and remarks.
--
-- WHICH STAGE IS "DEAL"
--   master_lookups crm_lead_stage code 'converted_to_deal', label
--   "Converted to Deal" — the last of the seven seeded stages and the only one
--   that means a deal was struck. The client's list (New, Follow-up,
--   Discussion, Site Visit Requested/Scheduled/Completed, Deal) maps onto those
--   seven exactly. No new stage is invented; the stage master stays untouched.
--
-- WHY TWO TABLES AND NOT A JSON BLOB
--   The installments are queryable business records — amounts, dates and
--   remarks that will be reported on and reconciled — not opaque form state.
--   One row per installment keeps them summable in SQL and individually
--   editable, which a JSON column on the lead would not.
--
-- WHAT IS DELIBERATELY *NOT* STORED: THE TOTAL CUSTOMER COST
--   Cost to Customer lives on the inventory property
--   (inventory_properties.details -> $.dynamicData.costToCustomer) and must
--   stay dynamically linked, so copying it here would freeze a stale number the
--   moment the property is re-priced. The deal stores the property_code it is
--   for, and the cost is resolved live on every read. Total Amount Paid and
--   Total Amount Pending are likewise derived, never stored — a stored total is
--   just a second source of truth waiting to disagree with the rows above it.
--
-- WHY property_code AND NOT "the lead's allocated property"
--   A lead's allocation (crm_enquiries.interested_property_ids) is a JSON ARRAY
--   of property codes and really can hold several — one lead in this database
--   currently has three. "The allocated Inventory Property" is therefore not
--   always a single thing, so the deal records WHICH property it is for. With
--   exactly one inventory allocation the client preselects it and the operator
--   never sees a choice; with several they must pick.
--
-- SURVIVING A STAGE CHANGE
--   Moving a lead off the Deal stage hides the section but must not destroy the
--   payment history, so nothing here cascades on stage change. The rows stay
--   and are shown again if the lead returns to Deal.
--
-- NO FOREIGN KEY CONSTRAINTS, consistent with the rest of this schema (see
-- migration 128's note): the app soft-deletes and enforces referential
-- integrity in the service layer. Columns are indexed instead.
--
-- Additive only. Re-run safe.
-- ============================================================================

SET NAMES utf8mb4;

-- ------------------------------------------------------------------
-- (1) One deal per lead
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm_deal_payments (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  enquiry_id     BIGINT UNSIGNED NOT NULL
    COMMENT 'crm_enquiries.id — the lead this deal belongs to',
  property_code  VARCHAR(64) NOT NULL
    COMMENT 'inventory_properties.property_code the deal is for. The Total Customer Cost is read live from that row, never copied here.',
  advance_amount DECIMAL(14,2) NOT NULL DEFAULT 0.00
    COMMENT 'Paid up front, before any installment. Counts toward Total Amount Paid.',
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at     TIMESTAMP NULL DEFAULT NULL,
  -- One deal per lead: the Edit Lead modal edits a single Deal section, so a
  -- second row for the same lead could only ever be a bug. Enforced here so a
  -- concurrent double-submit cannot create one.
  UNIQUE KEY uk_crm_deal_payments_enquiry (enquiry_id),
  KEY ix_crm_deal_payments_property (property_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------
-- (2) Up to ten installments per deal
-- ------------------------------------------------------------------
-- `seq` is the installment's position as the operator sees it (Installment 1,
-- 2, ...). It is part of a UNIQUE key so the ten slots cannot collide, and the
-- 1..10 ceiling is enforced by a CHECK as well as in the service — the client
-- hides the Add button at ten, but a direct API call must not get past it
-- either.
CREATE TABLE IF NOT EXISTS crm_deal_installments (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  deal_id      BIGINT UNSIGNED NOT NULL
    COMMENT 'crm_deal_payments.id',
  seq          TINYINT UNSIGNED NOT NULL
    COMMENT 'Installment number as displayed, 1..10',
  amount       DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  payment_date DATE NULL
    COMMENT 'Each installment has its OWN date; there is no shared deal-level payment date.',
  remarks      VARCHAR(500) NULL
    COMMENT 'Free text recorded against this installment alone.',
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_crm_deal_installment_seq (deal_id, seq),
  KEY ix_crm_deal_installments_deal (deal_id),
  CONSTRAINT ck_crm_deal_installment_seq CHECK (seq BETWEEN 1 AND 10),
  CONSTRAINT ck_crm_deal_installment_amount CHECK (amount >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
