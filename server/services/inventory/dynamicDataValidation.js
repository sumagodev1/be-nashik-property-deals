// Server-side validation for the `details.dynamicData` blob produced by the
// data-driven inventory forms on the frontend (DynamicPropertyForm.jsx).
//
// We DON'T duplicate the full 79-variant form configs here — that would
// double the maintenance surface and drift the moment either side changes.
// Instead we enforce the structural + shape rules that apply across all
// variants:
//
//   * Field types (numbers stay numbers, arrays stay arrays, dualMode shapes
//     look like { specific, any }, unitNumber shapes look like { value, unit }).
//   * Size caps (string lengths, array lengths, numeric ranges) so a bug on
//     the client can't blow up the JSON column.
//   * Cross-field consistency: any `*Min` / `*Max` numeric pair must satisfy
//     Max >= Min (detected by naming convention — the same convention the
//     client-side validator uses so the messages line up).
//   * Contact / key-person shapes (names look like names, phones look like
//     phones, emails look like emails). These match the top-level ownerName /
//     ownerContact rules that already exist for the same payload.
//
// Per-variant "which fields are required" enforcement remains on the client
// for now — the form config is the single source of truth over there, and
// mirroring it on the backend would be a large ongoing sync task. If you need
// server-side required checks later, extend REQUIRED_BY_VARIANT below.

const Joi = require('joi');

// Reused patterns — kept aligned with the top-level property Joi (mobile
// pattern, name pattern).
const PHONE_RE = /^\d{10}$/;
const NAME_RE = /^[A-Za-z\s]+$/;
const MASTER_CODE_RE = /^[a-z0-9][a-z0-9_-]{0,62}[a-z0-9]$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Sane numeric ceilings — big enough for any real property, small enough that
// a typo (extra zero) reads as an error rather than a huge stored value.
const AREA_MAX = 10_00_000;      // 10 lakh sq ft
const DISTANCE_MAX = 10_000;     // 10,000 units
const PERCENT_MAX = 100;
const COUNT_MAX = 1000;
const PRICE_MAX = 1_000_00_00_000; // 1000 crore

const shortText = Joi.string().trim().max(255).allow('', null);
const mediumText = Joi.string().trim().max(500).allow('', null);
const longText = Joi.string().trim().max(2000).allow('', null);
const masterCodeField = Joi.string().trim().lowercase().pattern(MASTER_CODE_RE)
  .messages({ 'string.pattern.base': 'Invalid selection code' })
  .allow('', null);

const nonNegArea = Joi.number().min(0).max(AREA_MAX)
  .messages({
    'number.min': 'Value cannot be negative',
    'number.max': `Value cannot be greater than ${AREA_MAX.toLocaleString('en-IN')}`,
  });
const nonNegDistance = Joi.number().min(0).max(DISTANCE_MAX)
  .messages({
    'number.min': 'Value cannot be negative',
    'number.max': `Value cannot be greater than ${DISTANCE_MAX.toLocaleString('en-IN')}`,
  });
const percent = Joi.number().min(0).max(PERCENT_MAX)
  .messages({
    'number.min': 'Percentage cannot be negative',
    'number.max': 'Percentage cannot be greater than 100',
  });
const count = Joi.number().integer().min(0).max(COUNT_MAX)
  .messages({ 'number.min': 'Count cannot be negative' });
const priceLike = Joi.number().min(0).max(PRICE_MAX);

// dualMode fields carry both a "specific" and an "any" side. Either side can
// be a string (radio / text) or a master code — accept both, cap length.
const dualSide = Joi.alternatives().try(
  Joi.string().trim().max(500).allow('', null),
  Joi.number().allow(null),
);
const dualModeShape = Joi.object({
  specific: dualSide,
  any: dualSide,
}).unknown(false);

// Some form configs render `facing` / `condition` / `age` / `bunglowType` as
// a plain `select` / `radio` / `text`, which sends a bare scalar — but the
// server has always expected the dualMode object shape. Rather than editing
// 79 form configs (and reserializing every previously-saved record), accept
// a scalar too and coerce it into `{ specific: <scalar>, any: '' }`.
const dualModeOrScalar = Joi.alternatives()
  .try(
    dualModeShape,
    Joi.string().trim().max(500).allow('', null),
    Joi.number().allow(null),
  )
  .custom((v) => {
    if (v === null || v === undefined || v === '') return { specific: '', any: '' };
    if (typeof v === 'object' && !Array.isArray(v) && 'specific' in v) return v;
    return { specific: v, any: '' };
  });

// unitNumber fields: numeric value + unit label from a known set.
const unitNumberShape = Joi.object({
  value: Joi.alternatives().try(Joi.number().min(0).max(AREA_MAX), Joi.string().allow('', null)),
  unit: Joi.string().trim().max(20).allow('', null),
}).unknown(false);

// Contact card (Owner Details / Key Persons). All slots optional — the client
// treats the whole section as optional.
const nameField = Joi.string().trim().min(0).max(50).pattern(NAME_RE).allow('', null)
  .messages({ 'string.pattern.base': 'Name can only contain letters and spaces' });
const phoneItem = Joi.string().trim().pattern(PHONE_RE).allow('', null)
  .messages({ 'string.pattern.base': 'Enter a valid 10-digit mobile number' });
const emailItem = Joi.string().trim().email({ tlds: { allow: false } }).max(120).allow('', null)
  .messages({ 'string.email': 'Enter a valid email address' });
const contactShape = Joi.object({
  name: nameField,
  relation: Joi.string().trim().max(50).allow('', null),
  phones: Joi.array().items(phoneItem).max(10).default([]),
  mobiles: Joi.array().items(phoneItem).max(10).default([]),
  emails: Joi.array().items(emailItem).max(10).default([]),
  addresses: Joi.array().items(mediumText).max(10).default([]),
}).unknown(false);

// Array-of-master-code multi-select (e.g. defect lists, amenities lists).
const codeArray = Joi.array().items(masterCodeField).max(200);

// Some form configs render a codeArray key as a plain `select` today
// (e.g. allottedAreaToOwner on TDR/Flat, landReservation on Land purchase
// variants), and `landReservation` is even rendered as `dualMode` on other
// land variants — so the same key can arrive as a scalar, an array, OR a
// `{ specific, any }` object. Accept all three shapes; coerce scalars to
// single-element arrays and leave dualMode objects as-is so downstream code
// can branch on Array.isArray.
const codeArrayOrScalar = Joi.alternatives()
  .try(codeArray, dualModeShape, masterCodeField)
  .custom((v) => {
    if (Array.isArray(v)) return v;
    if (v && typeof v === 'object' && ('specific' in v || 'any' in v)) return v;
    if (v === null || v === undefined || v === '') return [];
    return [v];
  });

// The dynamicData Joi schema. `.unknown(true)` deliberately allows fields we
// haven't explicitly enumerated — the payload is form-config driven and we
// prefer forward-compat over a strict deny-list. Every known field still
// gets its type + range checked.
const dynamicDataSchema = Joi.object({
  // Identity / meta
  propertyCode: shortText,
  registrationDate: Joi.string().pattern(ISO_DATE_RE).allow('', null)
    .messages({ 'string.pattern.base': 'Date must be in YYYY-MM-DD format' }),

  // Free text
  landmark: shortText,
  address: mediumText,
  addressLine1: mediumText,
  addressLine2: mediumText,

  // Common dualMode fields (repeated across variants — Bunglow/Flat/Shop etc.)
  // Use dualModeOrScalar for keys whose form config renders as `select` /
  // `radio` in some variants — the scalar gets coerced to `{ specific, any }`.
  location: Joi.alternatives().try(dualModeShape, shortText),
  bunglowType: dualModeOrScalar,
  size: Joi.alternatives().try(dualModeShape, masterCodeField),
  facing: dualModeOrScalar,
  age: dualModeOrScalar,
  condition: dualModeOrScalar,

  // Radios that are stored as plain strings
  parkingFacility: shortText,

  // Area (repeated Min/Max pairs — cross-checked below)
  builtUpMin: nonNegArea.allow('', null),
  builtUpMax: nonNegArea.allow('', null),
  carpetMin: nonNegArea.allow('', null),
  carpetMax: nonNegArea.allow('', null),
  builtUpArea: nonNegArea.allow('', null),
  carpetArea: nonNegArea.allow('', null),
  plotAreaMin: nonNegArea.allow('', null),
  plotAreaMax: nonNegArea.allow('', null),
  landAreaMin: nonNegArea.allow('', null),
  landAreaMax: nonNegArea.allow('', null),

  // Distances
  distanceBusStandKm: nonNegDistance.allow('', null),
  distanceRailwayKm: nonNegDistance.allow('', null),
  distanceMainRoad: unitNumberShape,

  // Counts / percentages (best-effort names — anything else falls through
  // to unknown(true))
  yearlyHikePercent: masterCodeField, // master-backed pct picker
  developmentRatio: masterCodeField,
  tdrPurchase: masterCodeField,
  bookingAmountPercent: masterCodeField,
  paymentWhitePercent: masterCodeField,
  numberOfEmis: count,

  // Prices (rarely stored raw here — most price fields are master-code
  // budget buckets — but if free-form, we cap them like the top-level price)
  priceLakh: priceLike.allow('', null),
  amount: priceLike.allow('', null),

  // Master-backed selects — the client passes a master code; validate shape.
  bunglowSize: masterCodeField,
  bunglowStatus: masterCodeField,
  flatType: masterCodeField,
  flatSize: masterCodeField,
  flatStatus: masterCodeField,
  flatNature: masterCodeField,
  plotType: masterCodeField,
  plotStatus: masterCodeField,
  plotShape: masterCodeField,
  plotCorner: masterCodeField,
  plotAreaUnit: masterCodeField,
  plotRateUnit: masterCodeField,
  plotLayoutStatus: masterCodeField,
  shopStatus: masterCodeField,
  commercialStatus: masterCodeField,
  landStatus: masterCodeField,
  landZone: masterCodeField,
  landVariety: masterCodeField,
  landType: masterCodeField,
  landAreaUnit: masterCodeField,
  hostelStatus: masterCodeField,
  hostelCategory: masterCodeField,
  hostelRoomsCount: masterCodeField,
  hostelResidence: masterCodeField,
  hostelFacing: masterCodeField,
  hostelCondition: masterCodeField,
  payingGuestSize: masterCodeField,
  payingGuestFloor: masterCodeField,
  payingGuestFacing: masterCodeField,
  payingGuestCondition: masterCodeField,
  payingGuestStatus: masterCodeField,
  hospitalType: masterCodeField,
  industrialShedType: masterCodeField,
  industrialPlotStatus: masterCodeField,
  sezType: masterCodeField,
  tdrZone: masterCodeField,
  tdrFloor: masterCodeField,
  tdrPlotFacing: masterCodeField,
  tdrStatus: masterCodeField,
  bankAuctionProjectType: masterCodeField,
  bankAuctionPendingDues: masterCodeField,
  preLeasedProjectType: masterCodeField,
  projectSaleStatus: masterCodeField,
  projectFacing: masterCodeField,
  projectCondition: masterCodeField,
  leasePeriod: masterCodeField,
  paymentMode: masterCodeField,
  paymentPeriod: masterCodeField,
  bankName: masterCodeField,
  district: masterCodeField,
  taluka: masterCodeField,
  shivar: masterCodeField,
  possessionMonth: masterCodeField,
  possessionYear: masterCodeField,
  tenantPreference: masterCodeField,
  contactRelation: masterCodeField,
  contactType: masterCodeField,
  leadSource: masterCodeField,

  // Budget bucket selects — master-backed
  bunglowLeaseMonthlyBudget: masterCodeField,
  bunglowLeaseYearlyBudget: masterCodeField,
  bunglowDepositBudget: masterCodeField,
  bunglowRentMonthlyBudget: masterCodeField,
  bunglowRentDepositBudget: masterCodeField,
  bunglowBookingAmountFixed: masterCodeField,
  bunglowPossessionAfter: masterCodeField,
  commercialLeaseMonthlyBudget: masterCodeField,
  commercialLeaseYearlyBudget: masterCodeField,
  commercialDepositBudget: masterCodeField,
  commercialRentBudget: masterCodeField,
  commercialBookingAmountFixed: masterCodeField,
  flatLeaseMonthlyBudget: masterCodeField,
  flatLeaseYearlyBudget: masterCodeField,
  flatDepositBudget: masterCodeField,
  flatBookingAmountFixed: masterCodeField,
  flatPossessionAfter: masterCodeField,
  shopLeaseMonthlyBudget: masterCodeField,
  shopLeaseYearlyBudget: masterCodeField,
  shopDepositBudget: masterCodeField,
  shopBookingAmountFixed: masterCodeField,
  landLeaseMonthlyBudget: masterCodeField,
  landLeaseYearlyBudget: masterCodeField,
  landDepositBudget: masterCodeField,
  plotLeaseMonthlyBudget: masterCodeField,
  plotLeaseYearlyBudget: masterCodeField,
  plotDepositBudget: masterCodeField,
  hostelAmountBudget: masterCodeField,

  // Multi-selects. Use codeArrayOrScalar for keys whose form config renders
  // as a plain `select` in some variants (e.g. allottedAreaToOwner on TDR) —
  // the scalar gets coerced to `[code]`.
  defect: codeArray,
  defectWillDo: codeArray,
  defectWillNotDo: codeArray,
  defectWillDoCommunity: codeArray,
  defectWillNotDoCommunity: codeArray,
  amenitiesResidential: codeArray,
  amenitiesCommercial: codeArray,
  amenitiesPlot: codeArray,
  amenitiesHostel: codeArray,
  amenitiesBunglowFurniture: codeArray,
  flatIndoorAmenities: codeArray,
  flatOutdoorAmenities: codeArray,
  plotAmenities: codeArray,
  sezInfrastructuralFacilities: codeArray,
  sezFiscalIncentives: codeArray,
  industrialPermittedIndustry: codeArray,
  allottedAreaToOwner: codeArrayOrScalar,
  landReservation: codeArrayOrScalar,

  // Contacts + reference line
  contacts: Joi.array().items(contactShape).max(3),
  keyPersons: Joi.array().items(contactShape).max(2),
  referenceSourceOfLead: longText,
})
  .unknown(true)
  .max(200);

// Cross-field checks: Any `*Min` / `*Max` numeric pair must satisfy Max >= Min.
// Runs after Joi validation of individual fields — inside a `.custom()` on
// the wrapper below so both feed the same error list.
function crossCheckMinMax(data) {
  if (!data || typeof data !== 'object') return [];
  const errors = [];
  const keys = Object.keys(data);
  const minKeys = keys.filter((k) => k.endsWith('Min'));
  for (const minKey of minKeys) {
    const base = minKey.slice(0, -3);
    const maxKey = `${base}Max`;
    if (!Object.prototype.hasOwnProperty.call(data, maxKey)) continue;
    const minV = data[minKey];
    const maxV = data[maxKey];
    if (typeof minV !== 'number' || typeof maxV !== 'number') continue;
    if (Number.isNaN(minV) || Number.isNaN(maxV)) continue;
    if (maxV < minV) {
      errors.push({
        path: maxKey,
        message: 'Maximum must be greater than or equal to Minimum',
      });
    }
  }
  return errors;
}

/**
 * Validate the `details.dynamicData` blob.
 *
 * @param {any} dynamicData
 * @returns {{ value: any, errors: Array<{ path: string, message: string }> }}
 *          Errors have `path` relative to dynamicData (no `details.dynamicData.` prefix).
 *          The caller (route handler) prefixes them before propagation.
 */
function validateDynamicData(dynamicData) {
  if (dynamicData === null || dynamicData === undefined) {
    return { value: dynamicData, errors: [] };
  }
  const { value, error } = dynamicDataSchema.validate(dynamicData, {
    abortEarly: false,
    stripUnknown: false,
    convert: true,
  });
  const errors = [];
  if (error) {
    for (const d of error.details) {
      errors.push({ path: d.path.join('.'), message: d.message });
    }
  }
  const crossErrors = crossCheckMinMax(value || dynamicData);
  errors.push(...crossErrors);
  return { value: value ?? dynamicData, errors };
}

module.exports = { validateDynamicData };
