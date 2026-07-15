/**
 * DB layer for cross-module Owner Search.
 *
 * Given a short query string, hits inventory_properties, enquiry_properties,
 * and business_associates in parallel with LIKE-based matching and returns
 * the raw rows for the service layer to normalise + de-dupe.
 *
 * Matching strategy per source:
 *   Property tables — LIKE against owner_name, owner_contact, and the
 *                     details JSON blob (contacts[*].name / phones / mobiles /
 *                     emails live inside it). The JSON hit lets us surface
 *                     matches on secondary contact cards the admin filled in.
 *   Business assocs — LIKE against first_name / middle_name / surname (also
 *                     the concatenated full-name so a middle-of-string hit on
 *                     "Keshav Mahale" matches when typing "Mahale"), plus all
 *                     phone / mobile / whatsapp / email / designation slots.
 *
 * Results are capped per source so a broad query (e.g. "a") can't spike
 * the request timeout — the service does the final unification + top-N.
 */

const { pool } = require('../pool');

// Per-source row cap fed to the service; the service unifies + trims to the
// caller-supplied `limit` after de-duplication.
const PER_SOURCE_CAP = 25;

// Property columns projected for the service layer. Slim by design —
// avoids pulling the full `details` blob down the wire twice (the WHERE
// clause already touched it, but SELECT'ing it into the result set for
// every match would balloon the payload).
const PROP_COLUMNS = `
  id, property_code, property_type, transaction_type, transaction_variant,
  location, district, taluka, shivar, owner_name, owner_contact, details
`;

const BIZ_COLUMNS = `
  id, salutation, first_name, middle_name, surname, designation,
  city_code, taluka_code, district_code,
  phone1, phone2, mobile1, mobile2, mobile3, whatsapp,
  email1, email2
`;

async function searchInventory(q) {
  const like = `%${q}%`;
  const [rows] = await pool.query(
    `SELECT ${PROP_COLUMNS}
       FROM inventory_properties
      WHERE deleted_at IS NULL
        AND (
          owner_name    LIKE ?
       OR owner_contact LIKE ?
       OR details       LIKE ?
        )
      ORDER BY created_at DESC, id DESC
      LIMIT ?`,
    [like, like, like, PER_SOURCE_CAP],
  );
  return rows;
}

async function searchEnquiry(q) {
  const like = `%${q}%`;
  const [rows] = await pool.query(
    `SELECT ${PROP_COLUMNS}
       FROM enquiry_properties
      WHERE deleted_at IS NULL
        AND (
          owner_name    LIKE ?
       OR owner_contact LIKE ?
       OR details       LIKE ?
        )
      ORDER BY created_at DESC, id DESC
      LIMIT ?`,
    [like, like, like, PER_SOURCE_CAP],
  );
  return rows;
}

async function searchBusinessAssociates(q) {
  const like = `%${q}%`;
  const [rows] = await pool.query(
    `SELECT ${BIZ_COLUMNS}
       FROM business_associates
      WHERE deleted_at IS NULL
        AND (
          first_name  LIKE ?
       OR middle_name LIKE ?
       OR surname     LIKE ?
       OR CONCAT_WS(' ',
            first_name,
            COALESCE(middle_name, ''),
            COALESCE(surname, '')
          ) LIKE ?
       OR phone1   LIKE ?
       OR phone2   LIKE ?
       OR mobile1  LIKE ?
       OR mobile2  LIKE ?
       OR mobile3  LIKE ?
       OR whatsapp LIKE ?
       OR email1   LIKE ?
       OR email2   LIKE ?
       OR designation LIKE ?
        )
      ORDER BY created_at DESC, id DESC
      LIMIT ?`,
    [
      like, like, like, like,
      like, like, like, like, like, like,
      like, like, like,
      PER_SOURCE_CAP,
    ],
  );
  return rows;
}

module.exports = {
  searchInventory,
  searchEnquiry,
  searchBusinessAssociates,
};
