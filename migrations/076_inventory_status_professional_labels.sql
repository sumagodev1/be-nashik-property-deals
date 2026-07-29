-- ===========================================================
-- 076 — Inventory Property Status: professional labels + descriptions
-- ===========================================================
-- T-2026-082: The Inventory Property Status master (status_type,
-- backed by master_status_types) is being polished:
--
--   * Master DISPLAY LABEL: 'Status Type' → 'Inventory / Property
--     Status'. This lives in server/services/masters/management.js
--     (MASTER_LABELS) and was already renamed in T-2026-080; no DB
--     row change is required for that rename.
--
--   * Per-row labels + descriptions get their client-approved
--     professional wording. Existing IDs preserved — we UPDATE by
--     canonical `code`, never DELETE/INSERT — so every historical
--     inventory_properties.status FK-shaped reference keeps
--     resolving.
--
--   * Two additional codes ('sold_by_me' / 'sold_by_npd') that the
--     client tracks separately from the generic 'sold' state are
--     seeded via INSERT IGNORE so:
--       (a) if they already exist (added earlier by an admin from
--           the master UI) their label + description get refreshed
--           via the UPDATE branch below, and
--       (b) if they don't exist yet, they're created with active=1
--           and a sane sort_order.
--
-- Guardrails:
--   * Additive + idempotent. Second run is a no-op (UPDATE by code
--     is deterministic; INSERT IGNORE deduplicates on the code UK).
--   * NEVER changes the `code` of an existing row — inventory_properties
--     .status stores the code, so a rename would orphan every historical
--     row.
--   * NEVER deletes a row — even if the client later wants to retire
--     a status, they should use the Deactivate button (is_active=0)
--     which the admin UI already exposes.
-- ===========================================================

-- Step 1: update labels + descriptions on the four seeded rows.
UPDATE master_status_types
   SET label = 'Available for Transaction',
       description = 'Property is currently active and available for Sale, Purchase, Rent, Lease or other property transactions.'
 WHERE code = 'available' AND deleted_at IS NULL;

UPDATE master_status_types
   SET label = 'Transaction Completed',
       description = 'The property transaction has been completed and the property is no longer available.'
 WHERE code = 'sold' AND deleted_at IS NULL;

UPDATE master_status_types
   SET label = 'Rented Out',
       description = 'Property has been rented/leased and is currently occupied.'
 WHERE code = 'rented' AND deleted_at IS NULL;

UPDATE master_status_types
   SET label = 'Inactive',
       description = 'Property listing is temporarily inactive and not available for transactions.'
 WHERE code = 'inactive' AND deleted_at IS NULL;

-- Step 2: ensure the two owner/agency-attribution codes exist. Codes are
-- underscored ASCII to match how the master admin's codeFromLabel derives
-- codes (see server/services/masters/management.js codeFromLabel: lowercase,
-- non-alphanum → '-', prefix/suffix '-' stripped). Historical admin-created
-- rows would carry the same code; INSERT IGNORE hits the (code) UK on those
-- and skips. Sort orders slot in after the existing four (10/20/30/40) so
-- the dropdown reads: Available → Transaction Completed → Sold by Owner →
-- Sold by NPD → Rented Out → Inactive.
INSERT IGNORE INTO master_status_types (code, label, description, sort_order, is_active) VALUES
  ('sold_by_me',  'Sold by Owner',                'Property has been sold directly by the owner without Nashik Property Deals handling the transaction.', 25, 1),
  ('sold_by_npd', 'Sold by Nashik Property Deals', 'Property transaction has been successfully completed through Nashik Property Deals.',                 26, 1);

-- Step 3: refresh label + description for the two codes above in case an
-- older admin-created row already exists with an outdated label. Runs
-- after INSERT IGNORE so both freshly-inserted and pre-existing rows
-- converge on the client-approved wording.
UPDATE master_status_types
   SET label = 'Sold by Owner',
       description = 'Property has been sold directly by the owner without Nashik Property Deals handling the transaction.',
       sort_order = 25
 WHERE code = 'sold_by_me' AND deleted_at IS NULL;

UPDATE master_status_types
   SET label = 'Sold by Nashik Property Deals',
       description = 'Property transaction has been successfully completed through Nashik Property Deals.',
       sort_order = 26
 WHERE code = 'sold_by_npd' AND deleted_at IS NULL;
