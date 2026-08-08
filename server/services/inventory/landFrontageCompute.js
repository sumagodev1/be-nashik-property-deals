// Backend mirror of the FE landFrontageConversion.js.
//
// Runs AFTER the dynamicData Joi validator on Create / Update / Draft
// endpoints, so a client that talks to the API directly (bypassing the
// browser UI) still produces the SAME derived value the browser would
// have computed. The frontend and backend must always agree — that's the
// contract the client asked for.
//
// Applies WHENEVER the payload carries `frontageFoot` and/or
// `frontageDistance` — currently only land forms declare those keys,
// but the calculator is schema-agnostic and idempotent so wiring it
// unconditionally is safe.
//
// Rule (mirrors FE):
//   frontageDistance.value := frontageFoot × factor(unit)
//     where factor('Meters') = 0.3048, factor('Kms') = 0.0003048.
//   frontageFoot itself is NEVER modified — Foot is the source of truth.
//   frontageDistance.unit is preserved (defaults to 'Meters' if missing).
//   Empty Foot -> Distance value blank (unit still preserved).

const FRONTAGE_FOOT_KEY = 'frontageFoot';
const FRONTAGE_DISTANCE_KEY = 'frontageDistance';
const FRONTAGE_UNIT_METERS = 'Meters';
const FRONTAGE_UNIT_KMS = 'Kms';

const METER_ALIASES = new Set(['meters', 'meter', 'm', 'mtr']);
const KM_ALIASES    = new Set(['kms', 'km', 'kilometers', 'kilometer']);

const METERS_PER_FOOT = 0.3048;
const KM_PER_FOOT     = 0.0003048;

function parseFeet(raw) {
  if (raw === '' || raw === null || raw === undefined || raw === '-') return null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
}

function normalizeUnit(unit) {
  if (unit === null || unit === undefined) return '';
  const s = String(unit).trim().toLowerCase();
  if (!s) return '';
  if (METER_ALIASES.has(s)) return FRONTAGE_UNIT_METERS;
  if (KM_ALIASES.has(s))    return FRONTAGE_UNIT_KMS;
  return unit;
}

function formatDistance(num) {
  if (!Number.isFinite(num)) return '';
  const rounded = Number(num.toFixed(6));
  if (!Number.isFinite(rounded)) return '';
  const s = rounded.toFixed(6);
  return s.replace(/\.?0+$/, '');
}

function feetToDistance(feetRaw, unitRaw) {
  const feet = parseFeet(feetRaw);
  if (feet === null) return '';
  const canonical = normalizeUnit(unitRaw);
  if (canonical === FRONTAGE_UNIT_METERS) return formatDistance(feet * METERS_PER_FOOT);
  if (canonical === FRONTAGE_UNIT_KMS)    return formatDistance(feet * KM_PER_FOOT);
  return '';
}

/**
 * Recompute `frontageDistance.value` from `frontageFoot` + the current unit.
 * Idempotent. Never mutates the input. Returns a shallow copy with the
 * derived-field overwritten. If the payload doesn't carry frontageFoot AND
 * doesn't carry frontageDistance, returns the input unchanged.
 *
 * The unit label on the output is preserved verbatim from the input
 * (defaults to 'Meters' when absent). The numeric value is fully derived
 * from Foot — any Distance value the client sent is overwritten.
 *
 * @param {object} data — dynamicData JSON blob (Joi-validated)
 * @returns {object}
 */
function computeLandFrontage(data) {
  if (!data || typeof data !== 'object') return data;
  const hasFoot = Object.prototype.hasOwnProperty.call(data, FRONTAGE_FOOT_KEY);
  const hasDistance = Object.prototype.hasOwnProperty.call(data, FRONTAGE_DISTANCE_KEY);
  if (!hasFoot && !hasDistance) return data;

  const existingDistance = data[FRONTAGE_DISTANCE_KEY];
  const currentUnit = (existingDistance && typeof existingDistance === 'object' && existingDistance.unit)
    ? existingDistance.unit
    : FRONTAGE_UNIT_METERS;

  const derived = feetToDistance(data[FRONTAGE_FOOT_KEY], currentUnit);

  const out = { ...data };
  out[FRONTAGE_DISTANCE_KEY] = {
    value: derived,
    unit: currentUnit,
  };
  // Foot is never touched.
  return out;
}

module.exports = {
  computeLandFrontage,
  feetToDistance,
  FRONTAGE_FOOT_KEY,
  FRONTAGE_DISTANCE_KEY,
  METERS_PER_FOOT,
  KM_PER_FOOT,
};
