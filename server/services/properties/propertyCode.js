/**
 * Property code generator — produces production-style identifiers like
 *   NSK-FLT-26-A8K2M7P
 *
 * Structure:
 *   NSK       — city code (Nashik; project is single-city for now)
 *   FLT       — 3-letter property-type abbreviation (see PROPERTY_TYPE_CODES)
 *   26        — 2-digit year (last two digits of the server creation year)
 *   A8K2M7P   — 7-character random alphanumeric, uppercase A-Z + digits 0-9,
 *               guaranteed to contain at least one letter AND one digit.
 *
 * The DB enforces UNIQUE on property_code, so callers must regenerate and
 * retry on the (rare) collision. `assignUniqueCode` does that for you: it
 * generates a candidate, attempts the update, and retries up to N times.
 *
 * IMPORTANT: This module is the sole source of truth for the property code
 * format. Inventory, Enquiry, Website admin, and Seller (public) create
 * flows all funnel through `assignUniqueCode` — the frontend never
 * generates or edits codes.
 */

const crypto = require('crypto');

const CITY_CODE = 'NSK';

// Canonical property-type → 3-letter code map. Keys are the snake_case
// values stored in master_property_types.code. `other` is the catch-all
// used whenever the incoming propertyType doesn't match a known entry.
const PROPERTY_TYPE_CODES = Object.freeze({
  flat:                 'FLT',
  land:                 'LND',
  plot:                 'PLT',
  sez_plot:             'SPT',
  sez_land:             'SLD',
  bungalow:             'BNG',
  shop:                 'SHP',
  hotel:                'HTL',
  hostel:               'HST',
  hospital:             'HSP',
  commercial_space:     'COM',
  industrial_plot:      'IND',
  tdr:                  'TDR',
  bank_auction:         'BKA',
  paying_guest:         'PGS',
  pre_leased_property:  'PLP',
  project_registration: 'PRJ',
  other:                'OTH',
});

// Aliases for values that historically arrived in a different shape
// (legacy bucket keys from the old normalizer, misspellings, labels
// from the UI, etc.). Anything not here or in PROPERTY_TYPE_CODES
// falls through to `other`/OTH.
const PROPERTY_TYPE_ALIASES = Object.freeze({
  // Legacy bucket keys from the old toPropertyTypeKey() normalizer
  bunglow:            'bungalow',
  villa:              'bungalow',
  house:              'bungalow',
  apartment:          'flat',
  commercial:         'commercial_space',
  pre_leased:         'pre_leased_property',
  sez:                'sez_plot',

  // Human-readable label variants (spaces, hyphens, mixed case all
  // normalize to snake_case before lookup, so we only need to alias
  // the residual quirks)
  agricultural:       'land',
});

// 36-char alphabet: uppercase A-Z + digits 0-9. 36^7 ≈ 78 billion
// combinations, so collisions on the 7-char suffix are astronomically
// unlikely for the expected inventory size.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const SUFFIX_LEN = 7;
const MAX_ATTEMPTS = 8;

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

// Normalize an incoming property-type value (any of: DB snake_case code,
// human label with spaces/hyphens, legacy bucket key) to the canonical
// key used by PROPERTY_TYPE_CODES.
function normalizePropertyType(propertyType) {
  const raw = String(propertyType || '').trim().toLowerCase();
  if (!raw) return 'other';
  // Collapse spaces, hyphens, slashes -> underscore so labels like
  // "SEZ Plot" / "Pre-Leased Property" / "Commercial Space" line up
  // with the snake_case master codes.
  const snake = raw.replace(/[\s/-]+/g, '_').replace(/_+/g, '_');
  if (Object.prototype.hasOwnProperty.call(PROPERTY_TYPE_CODES, snake)) return snake;
  if (Object.prototype.hasOwnProperty.call(PROPERTY_TYPE_ALIASES, snake)) {
    return PROPERTY_TYPE_ALIASES[snake];
  }
  return 'other';
}

function propertyTypeCode(propertyType) {
  return PROPERTY_TYPE_CODES[normalizePropertyType(propertyType)];
}

function generatePropertyCode(propertyType, now = new Date()) {
  const yy = String(now.getFullYear() % 100).padStart(2, '0');
  return `${CITY_CODE}-${propertyTypeCode(propertyType)}-${yy}-${randomSuffix()}`;
}

/**
 * Generate a code and call `tryAssign(code)` until it succeeds. `tryAssign`
 * must return true on success or throw / return false on UNIQUE collision.
 * Throws after MAX_ATTEMPTS — collisions are astronomically unlikely so a
 * persistent failure means something else is wrong.
 */
async function assignUniqueCode(propertyType, tryAssign) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const code = generatePropertyCode(propertyType);
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
  CITY_CODE,
  PROPERTY_TYPE_CODES,
  PROPERTY_TYPE_ALIASES,
  normalizePropertyType,
  propertyTypeCode,
  generatePropertyCode,
  assignUniqueCode,
};
