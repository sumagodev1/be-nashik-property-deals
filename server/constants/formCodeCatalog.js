// T-2026-057 (Fix D): canonical (Property Type, Transaction Type, Property Variety)
// → form-code catalog. Mirrors src/admin/pages/Inventory/dynamic/formCodeCanonicalMap.js
// on the frontend so both sides use the same 80-value form-code universe.
//
// Two consumers on the backend:
//
//   1. `deriveFormCode(pt, tt, pv)` — deterministic mapping used to
//       resolve an incoming payload's classification triple to a form
//       code. Returns '' when the combination isn't in the catalog.
//
//   2. `isValidCombination(pt, tt, pv)` — thin wrapper that returns
//       true iff deriveFormCode returns a non-empty code. Used by the
//       inventory + enquiry save handlers to log invalid combinations
//       (permissive) or reject them (strict). See validateCombination
//       for the calling contract.
//
// NAMING NOTE: this file uses SNAKE_CASE codes (property_type codes
// like `commercial_space`, `industrial_plot`, `pre_leased_property`)
// because that's what the backend `master_property_types` seed stores.
// The catalog normalises inputs via `_normalise` so a kebab-case
// input from the FE (`commercial-space`) matches the snake_case seed.
//
// This file is data + pure functions. No DB, no I/O.

'use strict';

const PROPERTY_TYPE_TO_PREFIX = Object.freeze({
  sez_land:              'sez-land',
  sez_plot:              'sez-plot',
  industrial_plot:       'industrial-plot',
  pre_leased_property:   'pre-leased',
  project_registration:  'project',
  bank_auction:          'bank-auction',
  paying_guest:          'paying-guest',
  commercial_space:      'commercial',
  // Both spellings register — the master seed uses `bungalow` but every
  // form-config family key + DB `property_type` label uses the historical
  // `bunglow` (no 'a'). Accept either so an incoming payload from either
  // side hits the same prefix.
  bungalow:              'bunglow',
  bunglow:               'bunglow',
  hospital:              'hospital',
  hostel:                'hostel',
  hotel:                 'hotel',
  flat:                  'flat',
  land:                  'land',
  plot:                  'plot',
  shop:                  'shop',
  tdr:                   'tdr',
});

const TRANSACTION_TYPE_TO_SUFFIX_TOKEN = Object.freeze({
  sale:          'sale',
  purchase:      'purchase',
  rent_in:       'rent-in',
  rent_out:      'rent-out',
  lease_in:      'lease-in',
  lease_out:     'lease-out',
  joint_venture: 'joint-venture',
  // Rate Finder is a variety-less enquiry-side flow (Flat, Land, Plot,
  // Shop). Registered form codes carry `-rate-finder` verbatim.
  rate_finder:   'rate-finder',
});

// Verbatim mirror of REGISTERED_FORM_CODES in the FE canonical map —
// 80 form codes. Kept as a SET here for O(1) validation.
const REGISTERED_FORM_CODES = Object.freeze([
  'bunglow-resale-lease-in', 'bunglow-new-lease-in',
  'bunglow-resale-lease-out', 'bunglow-new-lease-out',
  'bunglow-resale-purchase', 'bunglow-new-purchase',
  'bunglow-resale-rent-in', 'bunglow-new-rent-in',
  'bunglow-resale-rent-out', 'bunglow-new-rent-out',
  'bunglow-resale', 'bunglow-new-sale',
  'commercial-lease-in-resale', 'commercial-lease-in-new',
  'commercial-lease-out-resale', 'commercial-lease-out-new',
  'commercial-resale-purchase', 'commercial-new-purchase',
  'commercial-resale-rent-in', 'commercial-new-rent-in',
  'commercial-resale-rent-out', 'commercial-new-rent-out',
  'commercial-resale', 'commercial-new-sale',
  'flat-joint-venture',
  'flat-resale-lease-in', 'flat-new-lease-in',
  'flat-resale-lease-out', 'flat-new-lease-out',
  'flat-resale-purchase', 'flat-new-purchase',
  'flat-resale-rent-in', 'flat-new-rent-in',
  'flat-resale-rent-out', 'flat-new-rent-out',
  'flat-resale', 'flat-new-sale',
  'hostel-let-in', 'hostel-let-out',
  'land-lease-in', 'land-purchase', 'land-rent-in',
  'land-lease-out', 'land-rent-out', 'land-sale',
  'plot-lease-in', 'plot-purchase', 'plot-rent-in',
  'plot-lease-out', 'plot-rent-out', 'plot-sale',
  'shop-resale-lease-in', 'shop-new-lease-in',
  'shop-resale-lease-out', 'shop-new-lease-out',
  'shop-resale-purchase', 'shop-new-purchase',
  'shop-resale-rent-in', 'shop-new-rent-in',
  'shop-resale-rent-out', 'shop-new-rent-out',
  'shop-resale', 'shop-new-sale',
  'sez-plot-sale', 'sez-plot-purchase',
  'sez-land-sale', 'sez-land-purchase',
  'tdr-sale', 'tdr-in',
  'hospital-sell', 'hospital-rent-out',
  'hospital-resale', 'hospital-rent-in',
  'hotel-sell', 'hotel-rent-out',
  'hotel-buy', 'hotel-rent-in',
  'paying-guest-bunglow', 'paying-guest-flat',
  'paying-guest-bunglow-out', 'paying-guest-flat-out',
  'bank-auction-resale',
  'industrial-plot-resale',
  'pre-leased-resale',
  'project-resale',
  'flat-rate-finder', 'land-rate-finder',
  'plot-rate-finder', 'shop-rate-finder',
]);
const REGISTERED_FORM_CODES_SET = new Set(REGISTERED_FORM_CODES);

// Normalise any incoming FE code — kebab OR snake OR mixed case —
// to the snake_case form the catalog uses. Handles three payload
// shapes we see in practice:
//   1. master CODE     → "commercial_space"          (backend seed)
//   2. master LABEL    → "Commercial Space"          (FE snapshot)
//   3. stored DB label → "Bunglow [Resale Lease Out]" (pre-T-2026-055
//                       rows and the current label written at
//                       resolvePropertyTypeLabel-time)
// Bracket suffixes and anything after them are stripped so shape #3
// still resolves to the master code prefix.
function _normalise(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/\s*\[.*$/, '')     // "bunglow [resale lease out]" → "bunglow"
    .replace(/[-\s]+/g, '_');
}

// Normalise property_variety separately: the FE ships kebab-case
// slugs (e.g. `resale`, `new`, `under-construction`) that map onto
// the underscore-less lower-case tokens the catalog uses.
function _normaliseVariety(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[-_\s]+/g, '_');
}

// Rewrite kebab TT tokens (`rent-in`, `lease-out`) into the snake
// form the suffix table indexes by.
function _canonTt(text) {
  const t = _normalise(text);
  // Some FE payloads still ship the historical spelling — coerce
  // them to the master's canonical vocabulary. All other values
  // pass through unchanged.
  if (t === 'buy') return 'purchase';   // hotel-buy is a form-code alias; keep the payload's txn as `purchase`.
  if (t === 'sell') return 'sale';      // hospital-sell / hotel-sell aliases.
  if (t === 'let_in') return 'lease_in';
  if (t === 'let_out') return 'lease_out';
  return t;
}

// Verbatim mirror of the FE `deriveFormCodeFromCanonical` logic. Kept
// character-for-character identical so the two sides never disagree.
function deriveFormCode(propertyType, transactionType, propertyVariety) {
  const pt  = _normalise(propertyType);
  const tx  = _canonTt(transactionType);
  const pv  = _normaliseVariety(propertyVariety);
  const prefix = PROPERTY_TYPE_TO_PREFIX[pt];
  if (!prefix) return '';
  const txToken = TRANSACTION_TYPE_TO_SUFFIX_TOKEN[tx];
  const candidates = [];
  if (pt === 'hospital') {
    if (tx === 'sale' && pv !== 'resale') candidates.push('hospital-sell');
    if (tx === 'sale' && pv === 'resale') candidates.push('hospital-resale', 'hospital-sell');
    if (tx === 'purchase') candidates.push('hospital-resale');
    if (tx === 'rent_in')  candidates.push('hospital-rent-in');
    if (tx === 'rent_out') candidates.push('hospital-rent-out');
  }
  if (pt === 'hotel') {
    if (tx === 'sale')     candidates.push('hotel-sell');
    if (tx === 'purchase') candidates.push('hotel-buy');
    if (tx === 'rent_in')  candidates.push('hotel-rent-in');
    if (tx === 'rent_out') candidates.push('hotel-rent-out');
  }
  if (pt === 'hostel') {
    if (tx === 'lease_in')  candidates.push('hostel-let-in');
    if (tx === 'lease_out') candidates.push('hostel-let-out');
  }
  if (pt === 'tdr') {
    if (tx === 'sale')     candidates.push('tdr-sale');
    if (tx === 'purchase') candidates.push('tdr-in');
  }
  if (pt === 'bank_auction')         candidates.push('bank-auction-resale');
  if (pt === 'industrial_plot')      candidates.push('industrial-plot-resale');
  if (pt === 'pre_leased_property')  candidates.push('pre-leased-resale');
  if (pt === 'project_registration') candidates.push('project-resale');
  if (tx === 'joint_venture')        candidates.push(prefix + '-joint-venture');
  if (tx === 'sale' && pv === 'resale') candidates.push(prefix + '-resale');
  if (tx === 'sale' && pv === 'new')    candidates.push(prefix + '-new-sale');
  if (pt === 'commercial_space' && (tx === 'lease_in' || tx === 'lease_out') && pv) {
    candidates.push(prefix + '-' + (tx === 'lease_in' ? 'lease-in' : 'lease-out') + '-' + pv);
  }
  if (pv && txToken) candidates.push(prefix + '-' + pv.replace(/_/g, '-') + '-' + txToken);
  if (txToken)       candidates.push(prefix + '-' + txToken);
  if (pv)            candidates.push(prefix + '-' + pv.replace(/_/g, '-'));
  // Paying Guest has a bespoke shape: the tree stores PT="Paying Guest",
  // TT="Out" (Inventory) or "Paying Guest" (Enquiry alias), and the
  // "variety" is actually the sub-property-type (Bungalow / Flat).
  // Registered codes: paying-guest-bunglow / paying-guest-flat
  // (enquiry) and paying-guest-bunglow-out / paying-guest-flat-out
  // (inventory).
  if (pt === 'paying_guest') {
    const subPT = pv === 'bungalow' || pv === 'bunglow' ? 'bunglow'
                : pv === 'flat' ? 'flat'
                : '';
    if (subPT) {
      // Inventory rows have TT="Out"; enquiry rows have TT="Paying Guest".
      const inventoryCode = 'paying-guest-' + subPT + '-out';
      const enquiryCode   = 'paying-guest-' + subPT;
      if (tx === 'out' && REGISTERED_FORM_CODES_SET.has(inventoryCode)) return inventoryCode;
      if (REGISTERED_FORM_CODES_SET.has(enquiryCode)) return enquiryCode;
    }
    return '';
  }
  for (const c of candidates) {
    if (REGISTERED_FORM_CODES_SET.has(c)) return c;
  }
  return '';
}

function isRegisteredFormCode(code) {
  return REGISTERED_FORM_CODES_SET.has(_normalise(code).replace(/_/g, '-'));
}

function isValidCombination(propertyType, transactionType, propertyVariety) {
  return deriveFormCode(propertyType, transactionType, propertyVariety) !== '';
}

// Log-only wrapper used by inventory + enquiry save handlers.
//
// Contract:
//   * Only log (never throw) when there IS a property_type + transaction_type
//     pair but the combo doesn't resolve to a registered form code.
//   * Skip the check entirely when property_type is empty — legacy rows and
//     partial drafts have historically been accepted this way and the
//     "no unnecessary validation should block submission" rule applies.
//   * The optional `label` is prepended to the log line so backend logs
//     distinguish inventory / enquiry hits.
function validateCombination({ propertyType, transactionType, propertyVariety, label = 'save' } = {}) {
  if (!propertyType || !transactionType) return; // insufficient data — skip.
  if (isValidCombination(propertyType, transactionType, propertyVariety)) return;
  // eslint-disable-next-line no-console
  console.warn(
    `[${label}] classification combination did not resolve to a registered form code: ` +
    `property_type=${propertyType} transaction_type=${transactionType} ` +
    `property_variety=${propertyVariety || '<empty>'} — this record will still save. ` +
    'Investigate if the FE chooser tree and this catalog have drifted.',
  );
}

module.exports = {
  PROPERTY_TYPE_TO_PREFIX,
  TRANSACTION_TYPE_TO_SUFFIX_TOKEN,
  REGISTERED_FORM_CODES,
  REGISTERED_FORM_CODES_SET,
  deriveFormCode,
  isRegisteredFormCode,
  isValidCombination,
  validateCombination,
};
