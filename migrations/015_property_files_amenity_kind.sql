-- Migration 015: allow 'amenity' as a file_kind on property_files.
--
-- Sellers now attach a thumbnail image to each amenity they list
-- ("Parking", "Lift", "Modular Kitchen", etc.). Those images live in the
-- same uploads directory as property gallery images but need to be
-- distinguishable from cover/gallery photos so:
--   - the listing detail page doesn't render them in the main gallery,
--   - the storage quota still accounts for them,
--   - delete-property still cascades them.
--
-- The amenity's typed *label* is stored in `original_name` (a free-text
-- column that already holds the user-supplied filename — repurposing it for
-- the amenity label keeps the schema change to a one-line ENUM extension).

ALTER TABLE property_files
  MODIFY COLUMN file_kind ENUM('image', 'document', 'amenity') NOT NULL;
