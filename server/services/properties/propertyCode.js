/**
 * Property code generator — produces identifiers like
 *   NSK-FLT-26-A8K2M7P
 *
 * Structure:
 *   NSK    — 3-letter district short code (from master_lookups.short_code
 *             for the selected district row)
 *   FLT    — 2-3 letter property type code (from master_property_types.id_code;
 *             falls back to PROPERTY_TYPE_ID_CODES map when the DB column is NULL)
 *   26     — 2-digit year (last two digits of the server creation year)
 *   A8K2M7P — 7-character random alphanumeric, uppercase A–Z + digits 0–9,
 *              guaranteed to contain at least one letter AND one digit.
 *
 * The DB enforces UNIQUE on property_code, so callers must regenerate and
 * retry on the (rare) collision. `assignUniqueCode` does that for you.
 *
 * IMPORTANT: This module is the sole source of truth for the property code
 * format. Inventory, Enquiry, Website admin, and Seller (public) create
 * flows all funnel through `assignUniqueCode` — the frontend never
 * generates or edits codes.
 *
 * Existing property IDs (pre-migration 079) remain unchanged; this module
 * only affects NEW registrations.
 */

const crypto = require('crypto');
const { getPropertyTypeIdCode } = require('../../db/queries/masters');

// 36-char alphabet: uppercase A-Z + digits 0-9. 36^7 ≈ 78 billion
// combinations, so collisions on the 7-char suffix are astronomically
// unlikely for the expected inventory size.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const SUFFIX_LEN = 7;

// Narrowest property_code column in the schema. Migration 121 widens
// website_properties to VARCHAR(64) to match inventory_properties and
// enquiry_properties, but a generated code is clamped to this regardless so
// a database that has not run 121 yet cannot fail an insert with
// ER_DATA_TOO_LONG - which is exactly what a seller's submit hit.
//
// The old worst case was 10 + 1 + 10 + 1 + 2 + 1 + 7 = 32: equal to the
// declared width, so there was no room for SUFFIX_LEN or either slice to
// grow. Enforcing the bound here keeps that a code concern rather than
// something that only surfaces as a database error at insert time.
const MAX_CODE_LEN = 32;
const MAX_ATTEMPTS = 8;

// Fallback map used when master_property_types.id_code is NULL (e.g. a newly
// added property type that has not been seeded yet, or running before
// migration 079). This ensures code generation never fails even without a
// DB round-trip returning a value.
const PROPERTY_TYPE_ID_CODES = {
  bank_auction:         'BAU',
  bungalow:             'BNG',
  commercial_space:     'CMS',
  flat:                 'FLT',
  hospital:             'HSP',
  hostel:               'HST',
  hotel:                'HOT',
  industrial_plot:      'IPL',
  land:                 'LND',
  paying_guest:         'PG',
  plot:                 'PLT',
  pre_leased_property:  'PLP',
  project_registration: 'PRJ',
  rowhouse:             'RWH',
  // Website-owned Property Type codes (master_key 'website_property_type',
  // migration 055). The Website deliberately runs its own vocabulary, and it
  // spells two types differently from the Global masters — 'flat_apartment'
  // vs 'flat', 'row_house' vs 'rowhouse'. Without these aliases a seller
  // listing resolved to 'UNK' and was issued a code like NSK-UNK-26-XXXXXXX.
  // Mapped to the same abbreviations as their Global twins so a Flat is FLT
  // no matter which surface registered it.
  flat_apartment:       'FLT',
  row_house:            'RWH',
  sez_land:             'SZL',
  sez_plot:             'SZP',
  shop:                 'SHP',
  tdr:                  'TDR',
};

// crypto.randomInt is unbiased over [0, 36); using `% ALPHABET.length`
// on raw bytes would bias slightly since 256 % 36 !== 0. The bias is
// tiny but this is a UNIQUE-constrained identifier, so use the
// unbiased path.
function pickChar() {
  return ALPHABET[crypto.randomInt(0, ALPHABET.length)];
}

function hasDigit(s)  { return /[0-9]/.test(s); }
function hasLetter(s) { return /[A-Z]/.test(s); }

// Generate a 7-char suffix that contains at least one letter AND one
// digit. Statistically the first draw satisfies this ~87% of the time,
// so retries are rare; the cap is defensive.
function randomSuffix() {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    let out = '';
    for (let i = 0; i < SUFFIX_LEN; i += 1) out += pickChar();
    if (hasDigit(out) && hasLetter(out)) return out;
  }
  // Extremely unlikely fallback: force the mix.
  let out = '';
  for (let i = 0; i < SUFFIX_LEN - 2; i += 1) out += pickChar();
  const letter = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[crypto.randomInt(0, 26)];
  const digit  = '0123456789'[crypto.randomInt(0, 10)];
  return out + letter + digit;
}

/**
 * Resolve the 2-3 letter property type abbreviation for the given canonical
 * property type code (e.g. 'flat' → 'FLT').
 *
 * Resolution order:
 *   1. DB lookup: master_property_types.id_code (configurable via Masters UI)
 *   2. Hardcoded fallback map (PROPERTY_TYPE_ID_CODES above)
 *   3. 'UNK' sentinel so ID generation never throws
 *
 * @param {string} propertyTypeCode  Canonical master code, e.g. 'flat', 'plot'.
 * @returns {Promise<string>}        Uppercase abbreviation, e.g. 'FLT'.
 */
async function resolvePropertyTypeIdCode(propertyTypeCode) {
  if (propertyTypeCode) {
    const dbCode = await getPropertyTypeIdCode(propertyTypeCode);
    if (dbCode) return String(dbCode).toUpperCase();
    const fallback = PROPERTY_TYPE_ID_CODES[propertyTypeCode];
    if (fallback) return fallback;
  }
  return 'UNK';
}

/**
 * Generate a property code for the given district and property type.
 *
 * @param {string} districtCode      3-letter uppercase district abbreviation
 *                                   (e.g. 'NSK', 'PUN', 'NGP').
 * @param {string} propertyTypeIdCode 2-3 letter property type abbreviation
 *                                   (e.g. 'FLT', 'PLT'). Use
 *                                   resolvePropertyTypeIdCode() to obtain this.
 * @param {Date}   [now]             Server timestamp used for the YY segment.
 * @returns {string}                 e.g. 'NSK-FLT-26-A8K2M7P'
 */
function generatePropertyCode(districtCode, propertyTypeIdCode, now = new Date()) {
  const yy = String(now.getFullYear() % 100).padStart(2, '0');
  const suffix = randomSuffix();
  let dc = String(districtCode || 'UNK').toUpperCase().slice(0, 10);
  let tc = String(propertyTypeIdCode || 'UNK').toUpperCase().slice(0, 10);

  // The year and the random suffix carry the uniqueness, so they are never
  // trimmed - shortening the suffix would raise the collision rate. Only the
  // two human-readable segments give ground, district first, so the type
  // abbreviation an operator reads stays intact. For every real input
  // (3-letter district, 2-3 letter type) this is a no-op.
  const budget = MAX_CODE_LEN - (yy.length + suffix.length + 3);
  if (dc.length + tc.length > budget) {
    dc = dc.slice(0, Math.max(1, budget - tc.length));
    if (dc.length + tc.length > budget) tc = tc.slice(0, Math.max(1, budget - dc.length));
  }

  return `${dc}-${tc}-${yy}-${suffix}`;
}

/**
 * Generate a code and call `tryAssign(code)` until it succeeds. `tryAssign`
 * must return true on success or throw / return false on UNIQUE collision.
 * Throws after MAX_ATTEMPTS — collisions are astronomically unlikely so a
 * persistent failure means something else is wrong.
 *
 * CROSS-TABLE UNIQUENESS
 * ----------------------
 * Every candidate is first checked against EVERY property table
 * (inventory_properties, enquiry_properties, website_properties — see
 * db/queries/property_codes.js) before it is offered to `tryAssign`.
 *
 * This is not redundant with the UNIQUE indexes. A UNIQUE index is
 * per-table, and each caller's `tryAssign` writes to only its own table, so
 * ER_DUP_ENTRY could only ever detect a collision WITHIN that table.
 * Nothing prevented inventory and enquiry from minting the same code. The
 * codes are used as cross-system business identifiers — an operator reading
 * AKL-BNG-26-0XCQYR5 must get exactly one property — so the namespace has to
 * be global. Row ids emphatically are NOT global (inventory #19 and enquiry
 * #19 are unrelated properties), which is precisely why the code is the
 * identifier worth trusting.
 *
 * The pre-check plus the per-table UNIQUE index is not a distributed lock:
 * two creates racing into DIFFERENT tables could in principle both pass the
 * check and then both insert. That needs a collision on the 7-char suffix
 * (36^7 ≈ 78 billion) AND overlapping requests, so it is not a practical
 * risk; same-table races are still caught outright by the UNIQUE index.
 *
 * @param {string}   districtCode      3-letter district short code.
 * @param {string}   propertyTypeIdCode 2-3 letter property type abbreviation.
 * @param {Function} tryAssign         Async fn(code) → true | false.
 */
async function assignUniqueCode(districtCode, propertyTypeIdCode, tryAssign) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const code = generatePropertyCode(districtCode, propertyTypeIdCode);

    // Reject a candidate already taken in ANY property table before the
    // caller writes it. Fail-open on a lookup error: the per-table UNIQUE
    // index still guards the common case, and a transient DB blip must not
    // block property creation outright.
    try {
      // eslint-disable-next-line global-require
      const propertyCodes = require('../../db/queries/property_codes');
      // eslint-disable-next-line no-await-in-loop
      if (await propertyCodes.codeExistsAnywhere(code)) continue;
    } catch (_e) { /* fall through to the per-table UNIQUE index */ }

    let ok = false;
    try {
      ok = await tryAssign(code);
    } catch (err) {
      if (err && err.code === 'ER_DUP_ENTRY') {
        ok = false;
      } else {
        throw err;
      }
    }
    if (ok) return code;
  }
  throw new Error('Failed to assign a unique property code after multiple attempts');
}

module.exports = {
  PROPERTY_TYPE_ID_CODES,
  resolvePropertyTypeIdCode,
  generatePropertyCode,
  assignUniqueCode,
};
