/**
 * Property code generator — produces production-style identifiers like
 *   NSK-APT-26-8F3K92
 *
 * Structure:
 *   NSK       — city code (Nashik; project is single-city for now)
 *   APT       — 3-letter property-type abbreviation
 *   26        — 2-digit year (last two digits of the creation year)
 *   8F3K92    — 6-character random alphanumeric, uppercase, with visually
 *               ambiguous characters (0, O, 1, I, L) excluded.
 *
 * The DB enforces UNIQUE on property_code, so callers must regenerate and
 * retry on the (rare) collision. `assignUniqueCode` does that for you: it
 * generates a candidate, attempts the update, and retries up to N times.
 */

const crypto = require('crypto');

const CITY_CODE = 'NSK';

const PROPERTY_TYPE_CODES = Object.freeze({
  flat: 'APT',
  house: 'HSE',
  villa: 'VIL',
  plot: 'PLT',
  commercial: 'COM',
  agricultural: 'AGR',
  other: 'OTH',
});

// 32-char alphabet, no 0/O/1/I/L. 32^6 ≈ 1.07 billion combinations.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const SUFFIX_LEN = 6;
const MAX_ATTEMPTS = 8;

function randomSuffix() {
  const bytes = crypto.randomBytes(SUFFIX_LEN);
  let out = '';
  for (let i = 0; i < SUFFIX_LEN; i += 1) {
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out;
}

function propertyTypeCode(propertyType) {
  return PROPERTY_TYPE_CODES[propertyType] || PROPERTY_TYPE_CODES.other;
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
  generatePropertyCode,
  assignUniqueCode,
};
