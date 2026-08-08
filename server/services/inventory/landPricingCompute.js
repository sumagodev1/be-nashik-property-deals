// Backend mirror of the FE landPricingCalc.js.
//
// Runs AFTER the dynamicData Joi validator on Create / Update / Draft
// endpoints, so a client that talks to the API directly (bypassing the
// browser UI) still produces the SAME derived values the browser would
// have computed. The frontend and backend must always agree — that's the
// contract the client asked for.
//
// Applies to:
//   • Land Sale / Purchase and SEZ Land Sale / Purchase
//       (multi-unit family: source rate × source area via
//        lastEditedRateUnit / lastEditedGovRateUnit stamps).
//   • T-2026-119 built-up family: Flat / Bungalow / Rowhouse /
//     Commercial / Shop / Project Sale variants
//       (single-unit family: builtUpArea (Sq. Ft.) × ratePerSqFt for
//        Actual, × governmentRatePerSqFt for Government).
//
// Any other property type passes through untouched.
//
// Fields computed (all read-only in the FE form config):
//
//   • `actualCalculatedPropertyPrice`
//       Land / SEZ-Land: source_rate × source_area, where `source` is
//                         the unit label on `data.lastEditedRateUnit`.
//       Built-up:         builtUpArea × ratePerSqFt.
//       Blank when the required operands are empty.
//   • `governmentCalculatedPropertyPrice`
//       Land / SEZ-Land: source_gov_rate × source_area
//                         (`lastEditedGovRateUnit` stamp).
//       Built-up:         builtUpArea × governmentRatePerSqFt.
//   • `gstPercentage`
//       parseGstPercentage(gstId).
//   • Maharashtra registration rule (T-2026-119) — UNIVERSAL. Applies
//     to Land + SEZ-Land + built-up alike:
//       baseValue           = max(considerationValue,
//                                 governmentCalculatedPropertyPrice)
//       stampDuty           = baseValue × 5%
//       registrationCharges = baseValue × 1%
//       lbt                 = baseValue × 1%
//       gstAmount           = baseValue × gstPercentage%
//       costToCustomer      = baseValue + stampDuty + registrationCharges
//                           + lbt + gstAmount + paperNotice
//                           + documentTypingCharges + amountOfStampPaper
//                           + undertableFees
//     Rationale: Maharashtra registration charges are calculated on the
//     HIGHER of the market/consideration value and the government
//     ready-reckoner valuation. Using the lower amount under-collects
//     duty. Rule 6 of T-2026-119 makes this universal (Land, SEZ-Land,
//     and every built-up Sale form all use the same rule).

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

// T-2026-119: built-up canonical keys — single-unit (Sq. Ft.) family.
const BUILT_UP_AREA_KEY     = 'builtUpArea';
const BUILT_UP_RATE_KEY     = 'ratePerSqFt';
const BUILT_UP_GOV_RATE_KEY = 'governmentRatePerSqFt';

// Detects the pricing family from the `property_type` value stored on
// inventory_properties.property_type. Front-end sends the human label
// (e.g. "Land Registration Form[Sale]" → stripped to "Land[Sale]") or a
// canonical code (`land-sale`, `land-purchase`, `sez-land-sale`,
// `sez-land-purchase`, `flat-resale`, `bunglow-new-sale`, etc.). This
// matcher stays generous — case-insensitive, whitespace-collapsed —
// because the storage shape has drifted over time (see resolveFormConfig.js
// in the FE for the same headache).
//
// Returns:
//   'land' | 'sez-land' | 'built-up' | null
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
  // T-2026-119: built-up Sale family. Any of flat / bunglow / rowhouse /
  // commercial / shop / project property types AND a Sale-ish token.
  // Sale-ish = `sale`, `resale`, `new-sale`, `new_sale`, `newsale`
  // (all variations reduce to a substring containing "sale" after
  // whitespace-strip + lowercase). Purchase / Rent / Lease variants of
  // these property types do NOT match because their property_type
  // strings won't carry "sale".
  const isBuiltUpPropertyType =
       s.startsWith('flat')
    || s.startsWith('bunglow')
    || s.startsWith('rowhouse')
    || s.startsWith('commercial')
    || s.startsWith('shop')
    || s.startsWith('project');
  if (isBuiltUpPropertyType && s.includes('sale')) {
    return 'built-up';
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

// T-2026-119: numeric max that treats null as "not applicable".
// max(null, 10) === 10; max(null, null) === null.
function maxNumberOrNull(a, b) {
  if (a === null && b === null) return null;
  if (a === null) return b;
  if (b === null) return a;
  return a > b ? a : b;
}

/**
 * Recompute every derived Land / SEZ-Land / built-up Pricing field on a
 * dynamicData record. Idempotent — running it twice on the same input
 * produces the same output. Non-matching property types return the input
 * unchanged.
 *
 * IMPORTANT — T-2026-119 no-touch-on-hydrate rule (rule 12): this mirror
 * runs on every save (Create / Update / Draft). It does NOT distinguish
 * "user just typed a value" from "historically-saved value". If the FE
 * sent a payload that already contains a manually-entered actual or gov
 * price inconsistent with area × rate, this mirror will OVERWRITE it.
 * This is the intended contract (FE + BE must always agree on the
 * canonical derived shape); the no-touch-on-hydrate rule lives on the FE
 * side (InventoryForm.jsx / coerceLegacyBuiltUpPricingKeys) where it
 * preserves the historical intent until the user edits an input, at
 * which point the recompute fires and the FE sends the new derived
 * values which the BE mirror then persists.
 *
 * @param {object} data          — dynamicData JSON blob (Joi-validated).
 * @param {string} propertyType  — top-level property_type from the request.
 * @returns {object}             — data with derived fields overwritten.
 */
function computeLandPricing(data, propertyType) {
  const family = detectFamily(propertyType);
  if (!family || !data || typeof data !== 'object') return data;
  const out = { ...data };

  // ─── Actual Calculated Property Price ─────────────────────────────
  if (family === 'built-up') {
    // Single-unit built-up (Sq. Ft.).
    const area = toNumberOrNull(out[BUILT_UP_AREA_KEY]);
    const rate = toNumberOrNull(out[BUILT_UP_RATE_KEY]);
    if (area !== null && rate !== null) {
      out.actualCalculatedPropertyPrice = formatCurrency(area * rate);
    } else {
      out.actualCalculatedPropertyPrice = '';
    }
  } else {
    // Multi-unit Land / SEZ-Land — pick the source pair via the stamp.
    const rateMap = family === 'land' ? RATE_KEY_BY_UNIT_LAND : RATE_KEY_BY_UNIT_SEZ;
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
  }

  // ─── Government Calculated Property Price ──────────────────────────
  if (family === 'built-up') {
    const area = toNumberOrNull(out[BUILT_UP_AREA_KEY]);
    const rate = toNumberOrNull(out[BUILT_UP_GOV_RATE_KEY]);
    if (area !== null && rate !== null) {
      out.governmentCalculatedPropertyPrice = formatCurrency(area * rate);
    } else {
      out.governmentCalculatedPropertyPrice = '';
    }
  } else {
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
  }

  // ─── Financial derivations — Maharashtra rule (T-2026-119) ────────
  // baseValue = max(considerationValue, governmentCalculatedPropertyPrice)
  // Every percentage-of-base charge computed from baseValue (never from
  // the lower of the two). Applies universally to Land + SEZ-Land +
  // built-up.
  const cv  = toNumberOrNull(out.considerationValue);
  const gov = toNumberOrNull(out.governmentCalculatedPropertyPrice);
  const baseValue = maxNumberOrNull(cv, gov);

  const gstPct = parseGstPercentage(out.gstId);
  out.gstPercentage = gstPct === null ? '' : String(gstPct);
  if (baseValue === null) {
    out.stampDuty = '';
    out.registrationCharges = '';
    out.lbt = '';
    out.gstAmount = '';
  } else {
    out.stampDuty = formatCurrency(baseValue * 0.05);
    out.registrationCharges = formatCurrency(baseValue * 0.01);
    out.lbt = formatCurrency(baseValue * 0.01);
    out.gstAmount = (gstPct === null)
      ? ''
      : formatCurrency(baseValue * (gstPct / 100));
  }

  // Cost to Customer — live sum. Left blank when the whole Financial
  // subsection is untouched (no baseValue and no manual line entered).
  const paperNotice           = toNumberOrNull(out.paperNotice);
  const documentTypingCharges = toNumberOrNull(out.documentTypingCharges);
  const amountOfStampPaper    = toNumberOrNull(out.amountOfStampPaper);
  const undertableFees        = toNumberOrNull(out.undertableFees);
  const anyValuePresent = baseValue !== null
    || paperNotice !== null
    || documentTypingCharges !== null
    || amountOfStampPaper !== null
    || undertableFees !== null;
  if (!anyValuePresent) {
    out.costToCustomer = '';
  } else {
    const sum = (baseValue ?? 0)
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
