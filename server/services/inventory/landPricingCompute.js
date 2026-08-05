// Backend mirror of the FE landPricingCalc.js.
//
// Runs AFTER the dynamicData Joi validator on Create / Update / Draft
// endpoints, so a client that talks to the API directly (bypassing the
// browser UI) still produces the SAME derived values the browser would
// have computed. The frontend and backend must always agree — that's the
// contract the client asked for.
//
// Applies ONLY to Land Sale / Purchase and SEZ Land Sale / Purchase
// property types. Any other property type passes through untouched.
//
// Fields computed (all read-only in the FE form config):
//
//   • `actualCalculatedPropertyPrice`
//       = source_rate × source_area, where `source` is the unit label
//         on `data.lastEditedRateUnit` (`sqm` / `sqft` / `guntha` /
//         `acre` / `hectare` / `yard`). Blank when no rate has been
//         entered yet.
//   • `gstPercentage`
//       = parseGstPercentage(gstId) — extracts the first digit run from
//         the master code. Supports preset codes (`5-pct` → 5) and
//         admin-created "Other" codes (raw slug like `12` → 12).
//   • `stampDuty`           = considerationValue × 5%
//   • `registrationCharges` = considerationValue × 1%
//   • `lbt`                 = considerationValue × 1%
//   • `gstAmount`           = considerationValue × gstPercentage%
//   • `costToCustomer`      = live sum of every line
//                             (considerationValue + stampDuty +
//                              registrationCharges + lbt + gstAmount +
//                              paperNotice + documentTypingCharges +
//                              amountOfStampPaper + undertableFees).
//                             Left blank when the whole Financial
//                             subsection is untouched.

const AREA_KEY_BY_UNIT = Object.freeze({
  sqm:     'areaSqMeter',
  sqft:    'areaSqft',
  guntha:  'areaGuntha',
  acre:    'areaAcre',
  hectare: 'areaHectare',
  yard:    'areaVarYard',
});

const RATE_KEY_BY_UNIT_LAND = Object.freeze({
  sqm:     'rateSqMeter',
  sqft:    'rateSqft',
  guntha:  'rateGuntha',
  acre:    'rateAcre',
  hectare: 'rateHectare',
  yard:    'rateVarYard',
});

const RATE_KEY_BY_UNIT_SEZ = Object.freeze({
  sqm:     'budgetPerSqMeter',
  sqft:    'budgetPerSqft',
  guntha:  'budgetPerGuntha',
  acre:    'budgetPerAcre',
  hectare: 'budgetPerHectare',
  yard:    'budgetPerVarYard',
});

// Government Valuation family (Family D). Shared across Land + SEZ Land;
// same six-unit shape as Actual Pricing.
const GOV_RATE_KEY_BY_UNIT = Object.freeze({
  sqm:     'govRateSqMeter',
  sqft:    'govRateSqft',
  guntha:  'govRateGuntha',
  acre:    'govRateAcre',
  hectare: 'govRateHectare',
  yard:    'govRateVarYard',
});

// Detects the pricing family from the `property_type` value stored on
// inventory_properties.property_type. Front-end sends the human label
// (e.g. "Land Registration Form[Sale]" → stripped to "Land[Sale]") or a
// canonical code (`land-sale`, `land-purchase`, `sez-land-sale`,
// `sez-land-purchase`). This matcher stays generous — case-insensitive,
// whitespace-collapsed — because the storage shape has drifted over
// time (see resolveFormConfig.js in the FE for the same headache).
function detectFamily(propertyType) {
  const s = String(propertyType || '').toLowerCase().replace(/\s+/g, '');
  if (!s) return null;
  // SEZ Land — Sale / Purchase only. SEZ Plot variants are NOT in scope.
  if (s.includes('sez') && s.includes('land')) {
    if (s.includes('sale') || s.includes('purchase')) return 'sez-land';
    return null;
  }
  // Plain Land — Sale / Purchase only. Lease / Rent variants are OUT of
  // scope (they have a different pricing model — monthly rent + deposit
  // + yearly hike — with no rate-per-unit or Financial subsection).
  if (s.startsWith('land') || s.includes('landregistrationform')) {
    if (s.includes('sale') || s.includes('purchase')) return 'land';
    return null;
  }
  return null;
}

function toNumberOrNull(v) {
  if (v === '' || v === null || v === undefined || v === '-') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function formatCurrency(n) {
  if (!Number.isFinite(n)) return '';
  const rounded = Number(n.toFixed(2));
  if (!Number.isFinite(rounded)) return '';
  const s = rounded.toFixed(2);
  return s.replace(/\.?0+$/, '');
}

function parseGstPercentage(gstId) {
  if (gstId === '' || gstId === null || gstId === undefined) return null;
  const s = String(gstId);
  const m = s.match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  if (n < 0 || n > 100) return null;
  return n;
}

/**
 * Recompute every derived Land Pricing field on a dynamicData record.
 * Idempotent — running it twice on the same input produces the same
 * output. Non-Land / SEZ-Land property types return the input unchanged.
 *
 * @param {object} data          — dynamicData JSON blob (Joi-validated).
 * @param {string} propertyType  — top-level property_type from the request.
 * @returns {object}             — data with derived fields overwritten.
 */
function computeLandPricing(data, propertyType) {
  const family = detectFamily(propertyType);
  if (!family || !data || typeof data !== 'object') return data;
  const out = { ...data };
  const rateMap = family === 'land' ? RATE_KEY_BY_UNIT_LAND : RATE_KEY_BY_UNIT_SEZ;

  // Actual Calculated Property Price — SELECTED RATE × CORRESPONDING
  // AREA. Blank when no source unit is stamped or the operand is empty.
  const unit = out.lastEditedRateUnit;
  if (unit && AREA_KEY_BY_UNIT[unit] && rateMap[unit]) {
    const area = toNumberOrNull(out[AREA_KEY_BY_UNIT[unit]]);
    const rate = toNumberOrNull(out[rateMap[unit]]);
    if (area !== null && rate !== null) {
      out.actualCalculatedPropertyPrice = formatCurrency(area * rate);
    } else {
      out.actualCalculatedPropertyPrice = '';
    }
  } else {
    out.actualCalculatedPropertyPrice = '';
  }

  // Government Calculated Property Price — SELECTED GOV RATE ×
  // CORRESPONDING AREA. Same rule as above but reads from Family D
  // (govRate*) and its own source stamp `lastEditedGovRateUnit`. Blank
  // when no gov rate has been entered.
  const govUnit = out.lastEditedGovRateUnit;
  if (govUnit && AREA_KEY_BY_UNIT[govUnit] && GOV_RATE_KEY_BY_UNIT[govUnit]) {
    const area = toNumberOrNull(out[AREA_KEY_BY_UNIT[govUnit]]);
    const rate = toNumberOrNull(out[GOV_RATE_KEY_BY_UNIT[govUnit]]);
    if (area !== null && rate !== null) {
      out.governmentCalculatedPropertyPrice = formatCurrency(area * rate);
    } else {
      out.governmentCalculatedPropertyPrice = '';
    }
  } else {
    out.governmentCalculatedPropertyPrice = '';
  }

  // Financial derivations
  const cv = toNumberOrNull(out.considerationValue);
  const gstPct = parseGstPercentage(out.gstId);
  out.gstPercentage = gstPct === null ? '' : String(gstPct);
  if (cv === null) {
    out.stampDuty = '';
    out.registrationCharges = '';
    out.lbt = '';
    out.gstAmount = '';
  } else {
    out.stampDuty = formatCurrency(cv * 0.05);
    out.registrationCharges = formatCurrency(cv * 0.01);
    out.lbt = formatCurrency(cv * 0.01);
    out.gstAmount = (gstPct === null)
      ? ''
      : formatCurrency(cv * (gstPct / 100));
  }

  // Cost to Customer — live sum. Left blank when the whole Financial
  // subsection is untouched (no CV and no manual line entered).
  const paperNotice           = toNumberOrNull(out.paperNotice);
  const documentTypingCharges = toNumberOrNull(out.documentTypingCharges);
  const amountOfStampPaper    = toNumberOrNull(out.amountOfStampPaper);
  const undertableFees        = toNumberOrNull(out.undertableFees);
  const anyValuePresent = cv !== null
    || paperNotice !== null
    || documentTypingCharges !== null
    || amountOfStampPaper !== null
    || undertableFees !== null;
  if (!anyValuePresent) {
    out.costToCustomer = '';
  } else {
    const sum = (cv ?? 0)
      + (toNumberOrNull(out.stampDuty) ?? 0)
      + (toNumberOrNull(out.registrationCharges) ?? 0)
      + (toNumberOrNull(out.lbt) ?? 0)
      + (toNumberOrNull(out.gstAmount) ?? 0)
      + (paperNotice ?? 0)
      + (documentTypingCharges ?? 0)
      + (amountOfStampPaper ?? 0)
      + (undertableFees ?? 0);
    out.costToCustomer = formatCurrency(sum);
  }

  return out;
}

module.exports = {
  computeLandPricing,
  parseGstPercentage,
  detectFamily,
};
