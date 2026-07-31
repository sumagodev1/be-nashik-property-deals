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
  const dc = String(districtCode || 'UNK').toUpperCase().slice(0, 10);
  const tc = String(propertyTypeIdCode || 'UNK').toUpperCase().slice(0, 10);
  return `${dc}-${tc}-${yy}-${randomSuffix()}`;
}

/**
 * Generate a code and call `tryAssign(code)` until it succeeds. `tryAssign`
 * must return true on success or throw / return false on UNIQUE collision.
 * Throws after MAX_ATTEMPTS — collisions are astronomically unlikely so a
 * persistent failure means something else is wrong.
 *
 * @param {string}   districtCode      3-letter district short code.
 * @param {string}   propertyTypeIdCode 2-3 letter property type abbreviation.
 * @param {Function} tryAssign         Async fn(code) → true | false.
 */
async function assignUniqueCode(districtCode, propertyTypeIdCode, tryAssign) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const code = generatePropertyCode(districtCode, propertyTypeIdCode);
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
