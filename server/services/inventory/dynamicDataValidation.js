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

// Reused patterns — kept aligned with the top-level property Joi (mobile and
// phone patterns, name pattern).
const MOBILE_RE = /^[6-9]\d{9}$/;
const PHONE_RE = /^\d{8,15}$/;
const MOBILE_ERROR = 'Enter a valid 10-digit mobile number starting with 6-9';
const PHONE_ERROR = 'Enter a valid phone number with 8-15 digits';
const GUT_SURVEY_MAX_LENGTH = 10;
const GUT_SURVEY_ERROR = 'Gut No. / Survey No. must not exceed 10 characters.';
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
  // ENQUIRY multi-select: a dualMode paints exactly one atom — the side that
  // carries the dropdown — and on the Enquiry surface that atom is a checkbox
  // multi-select, so this side arrives as an ARRAY of master codes/labels
  // ("East","West"). Either side can be the dropdown depending on how the
  // config was authored, so both accept the list. Inventory keeps sending a
  // scalar and is matched by the string/number branches above, unchanged.
  Joi.array().items(
    Joi.string().trim().max(500).allow('', null),
    Joi.number(),
  ).max(200),
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
const phoneItem = Joi.string().pattern(PHONE_RE).allow('', null)
  .messages({ 'string.base': PHONE_ERROR, 'string.pattern.base': PHONE_ERROR });
const mobileItem = Joi.string().pattern(MOBILE_RE).allow('', null)
  .messages({ 'string.base': MOBILE_ERROR, 'string.pattern.base': MOBILE_ERROR });
// Gut / Survey identifiers are text references. Only their total length is
// constrained; letters, numbers, slashes, hyphens, and other existingly
// accepted characters are intentionally not filtered here.
const gutSurveyField = Joi.string().max(GUT_SURVEY_MAX_LENGTH).allow('', null)
  .messages({
    'string.base': GUT_SURVEY_ERROR,
    'string.max': GUT_SURVEY_ERROR,
  });
const emailItem = Joi.string().trim().email({ tlds: { allow: false } }).max(120).allow('', null)
  .messages({ 'string.email': 'Enter a valid email address' });
const contactShape = Joi.object({
  name: nameField,
  // `relation` holds either:
  //   • an enquiry relation label (max 100 chars — the enquiry surface stores
  //     the master LABEL via TextMasterSelect), OR
  //   • a business_associate_designation master CODE (up to 64 chars — the
  //     inventory surface now stores a Designation code via
  //     DesignationMasterSelect), OR
  //   • a legacy free-text relation string from records saved before the
  //     designation migration.
  // The 100-char cap covers all three shapes without further branching.
  relation: Joi.string().trim().max(100).allow('', null),
  phones: Joi.array().items(phoneItem).max(10).default([]),
  mobiles: Joi.array().items(mobileItem).max(10).default([]),
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

// ENQUIRY multi-select: on the Enquiry surface a dropdown that captures a
// customer REQUIREMENT accepts several master codes at once ("2BHK or 3BHK",
// "East or West"), so the same dynamicData key can arrive as an ARRAY there
// while Inventory keeps sending the scalar (or dualMode object) it always has.
// See the frontend's enquiryMultiSelectPolicy.js for which keys are eligible.
//
// Wrapping a key with this helper only ADDS the array shape — `base` is tried
// unchanged for every non-array value, so Inventory payloads validate and
// coerce exactly as before (dualModeOrScalar still turns a bare scalar into
// { specific, any }; masterCodeField still lowercases and pattern-checks).
// Arrays short-circuit to codeArray and are stored as-is; a scalar is NEVER
// auto-wrapped into an array here, which is what keeps Inventory untouched.
//
// The array items accept a code OR a plain label, not just `masterCodeField`:
// eight vocabularies (location/Area, project_name, hospital_type,
// hostel_category, sez_type, bank_auction_project_type,
// pre_leased_project_type, bunglow_tenant_preference) are rendered by the
// frontend's TextMasterSelect and persist the master LABEL — "Adgaon", not
// "adgaon" — plus operator-typed "Other" values. Restricting items to the
// lowercase code pattern would reject every one of those. Length and item
// caps still apply, so the JSON column stays bounded.
const codeOrLabelArray = Joi.array()
  .items(Joi.string().trim().max(255).allow('', null), Joi.number())
  .max(200);
const orCodeArray = (base) => Joi.alternatives().try(codeOrLabelArray, base);

// The dynamicData Joi schema. `.unknown(true)` deliberately allows fields we
// haven't explicitly enumerated — the payload is form-config driven and we
// prefer forward-compat over a strict deny-list. Every known field still
// gets its type + range checked.
const dynamicDataSchema = Joi.object({
  // Identity / meta
  propertyCode: shortText,
  // Posting Date (renamed from `registrationDate` — the top-level
  // `posting_date` column is authoritative on save; the FE also mirrors
  // the value into dynamicData for form rendering, so we validate both
  // shapes here. `registrationDate` is kept as a legacy alias for
  // in-flight forms rehydrated from older payloads.
  postingDate: Joi.string().pattern(ISO_DATE_RE).allow('', null)
    .messages({ 'string.pattern.base': 'Date must be in YYYY-MM-DD format' }),
  registrationDate: Joi.string().pattern(ISO_DATE_RE).allow('', null)
    .messages({ 'string.pattern.base': 'Date must be in YYYY-MM-DD format' }),
  availableFromDate: Joi.string().pattern(ISO_DATE_RE).allow('', null)
    .messages({ 'string.pattern.base': 'Date must be in YYYY-MM-DD format' }),

  // Free text
  landmark: shortText,
  address: mediumText,
  addressLine1: mediumText,
  addressLine2: mediumText,
  gutOldNo: gutSurveyField,
  gutNewNo: gutSurveyField,
  gutSpecificOldNo: gutSurveyField,
  gutSpecificNewNo: gutSurveyField,
  gutAnyOldNo: gutSurveyField,
  gutAnyNewNo: gutSurveyField,
  gutNoOld: gutSurveyField,
  gutNoNew: gutSurveyField,
  gutNumber: gutSurveyField,
  plotNoCtsNoSurveyNo: gutSurveyField,
  surveyNo: gutSurveyField,
  surveyNumber: gutSurveyField,
  mobile: mobileItem,
  mobileNo: mobileItem,
  mobileNumber: mobileItem,
  primaryMobileNumber: mobileItem,
  whatsapp: mobileItem,
  whatsappNo: mobileItem,
  whatsappNumber: mobileItem,
  contactNumber: mobileItem,
  primaryContactNumber: mobileItem,
  contactPersonNumber: mobileItem,
  contactPersonNo: mobileItem,
  bankAuctionContactPersonNumber: mobileItem,
  contactNo: phoneItem,
  phone: phoneItem,
  phoneNo: phoneItem,
  phoneNumber: phoneItem,
  primaryPhoneNumber: phoneItem,
  telephone: phoneItem,
  telephoneNumber: phoneItem,
  landline: phoneItem,
  landlineNumber: phoneItem,

  // Common dualMode fields (repeated across variants — Bunglow/Flat/Shop etc.)
  // Use dualModeOrScalar for keys whose form config renders as `select` /
  // `radio` in some variants — the scalar gets coerced to `{ specific, any }`.
  location: orCodeArray(Joi.alternatives().try(dualModeShape, shortText)),
  bunglowType: dualModeOrScalar,
  size: orCodeArray(Joi.alternatives().try(dualModeShape, masterCodeField)),
  facing: orCodeArray(dualModeOrScalar),
  age: dualModeOrScalar,
  condition: orCodeArray(dualModeOrScalar),

  // Radios that are stored as plain strings
  parkingFacility: shortText,

  // T-2026-121: Parking Type is dependent on Parking Facility (mirrors
  // T-2026-120 EMI pattern).
  //   • parkingFacility control values seen in the wild:
  //       - 'Available' / 'Not Available'   (owner-side New/Purchase)
  //       - 'Essential' / 'Not Essential'   (enquiry-side Rent/Lease)
  //       - 'Required'  / 'Not Required'    (hostel)
  //       - 'Allotted'  / 'Common'          (flat JV MD-verbatim outlier)
  //     Any AFFIRMATIVE value (Available / Essential / Required) keeps
  //     parkingType. Anything else strips it.
  //   • parkingType is a bounded scalar string (max 64) in the `then`
  //     branch. We DO NOT enforce Joi.valid('Allotted','Common') at the
  //     validator layer — the FE dropdown constrains new saves to the
  //     two canonical values, and legacy rows with non-canonical values
  //     (Open, Covered, Basement, Stilt) must not be rejected on
  //     re-save. This mirrors T-2026-120 EMI's `then: masterCodeField`
  //     shape (no explicit enum) and stays additive-only.
  //   • parent schema is `.unknown(true)` so the strip is safe.
  //   • Shared by inventory + enquiry routes (single validator).
  parkingType: Joi.when('parkingFacility', {
    // Note: `is:` sibling must be `.required()` in this branch —
    // without `.required()`, Joi treats missing/undefined values as
    // matching the schema (because absence is legal for any un-required
    // schema), which would route through `then` instead of `otherwise`
    // and leak parkingType past the strip. Making the branch required
    // forces `undefined`/missing parkingFacility to flow through
    // `otherwise` and get stripped, matching FE sanitizer semantics.
    is: Joi.string().valid('Available', 'Essential', 'Required').required(),
    // `then` also accepts an ARRAY of codes: Parking Type is one of the
    // Enquiry-surface checkbox multi-selects (a requirement may be "Allotted
    // or Common"). The `otherwise` strip is untouched, so a parkingType sent
    // without an affirmative parkingFacility is still dropped exactly as
    // before, array or not.
    then: orCodeArray(Joi.string().trim().max(64).allow('', null)),
    otherwise: Joi.any().strip(),
  }),

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

  // T-2026-116: Standardized Size & Configurations. Every Inventory/Enquiry
  // form that carries plot-area or plot-dimension concepts (Plot / Flat's
  // Bunglow Row / SEZ Plot / TDR / Industrial Plot) now uses these 11
  // canonical keys, wired to bidirectional auto-conversion (2dp rounding,
  // loop-guarded) via the FE plotAreaSizeConversion.js utility invoked from
  // DynamicPropertyForm.patchField. Numbers arrive as strings from the FE
  // interceptor — Joi's default `convert` coerces back to numbers.
  //
  // Legacy keys (areaSqYard/areaSqMt/areaSqFt on Plot; plotAreaSqm/
  // plotAreaSqyd on Flat/TDR; areaSqMeter on SEZ Plot; plotAreaSqMtr on
  // Industrial Plot) continue to flow through `.unknown(true)` on the
  // parent schema — historical rows read verbatim. FE hydration
  // (coerceLegacyPlotAreaKeys / coerceLegacyPlotSizeKeys) promotes legacy
  // values to the canonical keys on Edit / Draft-Restore without dropping
  // the legacy ones.
  plotAreaSqYard:     nonNegArea.allow('', null),
  plotAreaSqMt:       nonNegArea.allow('', null),
  plotAreaSqFt:       nonNegArea.allow('', null),
  sizeFrontMtr:       nonNegDistance.allow('', null),
  sizeFrontFt:        nonNegDistance.allow('', null),
  sizeBackMtr:        nonNegDistance.allow('', null),
  sizeBackFt:         nonNegDistance.allow('', null),
  sizeDepthLeftMtr:   nonNegDistance.allow('', null),
  sizeDepthLeftFt:    nonNegDistance.allow('', null),
  sizeDepthRightMtr:  nonNegDistance.allow('', null),
  sizeDepthRightFt:   nonNegDistance.allow('', null),

  // Distances
  distanceBusStandKm: nonNegDistance.allow('', null),
  distanceRailwayKm: nonNegDistance.allow('', null),
  distanceMainRoad: unitNumberShape,

  // Counts / percentages (best-effort names — anything else falls through
  // to unknown(true))
  yearlyHikePercent: orCodeArray(masterCodeField), // master-backed pct picker
  developmentRatio: orCodeArray(masterCodeField),
  tdrPurchase: orCodeArray(masterCodeField),
  bookingAmountPercent: orCodeArray(masterCodeField),
  paymentWhitePercent: masterCodeField,
  // T-2026-120: EMI trio (Plot forms today; opt-in-per-config elsewhere).
  //   • `emiOption` is the control. Values are stored as human labels
  //     ('Available' / 'Not Available') for backward-compat with the
  //     FE radio field. Empty / null (draft) allowed. Legacy Yes/No
  //     ('yes'/'no') from older payloads accepted verbatim via the same
  //     alternatives — never rejected.
  //   • `emiCount` (No. of EMIs — a master-code select on the FE) and
  //     `emiAmount` (rupees) are STRIPPED from the payload whenever
  //     `emiOption` is anything other than 'Available'. This mirrors the
  //     FE sanitizer (T-2026-120 clearOnHide flag) and closes the loop
  //     for older FE bundles / direct API scripts / stale drafts. The
  //     parent schema is `.unknown(true)` so the strip is safe (no
  //     rejection on the whole payload) and the persisted JSON blob
  //     stays clean.
  //
  // Legacy `numberOfEmis` (previous stale entry with no FE consumer) has
  // been removed — it never matched any FE key. Any historical payload
  // still carrying it rides through `.unknown(true)` unchanged.
  emiOption: Joi.string().trim().max(64).allow('', null),
  emiCount: Joi.when('emiOption', {
    is: 'Available',
    then: masterCodeField,
    otherwise: Joi.any().strip(),
  }),
  emiAmount: Joi.when('emiOption', {
    is: 'Available',
    then: priceLike.allow('', null),
    otherwise: Joi.any().strip(),
  }),

  // T-2026-125: Monthly Maintenance (Rs. / month) is gated by
  // `stageOfConstruction`. Rule:
  //   • stageOfConstruction === 'Under Construction' -> strip
  //     `maintenanceMonthly` from the payload entirely (never validated,
  //     never persisted). Mirrors FE sanitizer (clearOnHide flag on
  //     flat / shop / commercial / bungalow / rowhouse configs).
  //   • stageOfConstruction === 'Ready Possession' OR absent (Resale /
  //     Rent / Lease variants that don't carry the field) -> validate
  //     as a bounded price (accepts blank / null for drafts). This
  //     preserves the historical always-accepted behaviour on every
  //     variant without stageOfConstruction.
  //   • `maintenanceYearly` is INTENTIONALLY un-gated per task rule
  //     (only the /month variant is stage-dependent; /year is preserved
  //     across construction stages). No explicit entry needed — it
  //     rides through parent .unknown(true).
  //   • `oneTimeMaintenance` is also un-gated per task rule ("keep
  //     One-Time Maintenance if the form already has them").
  //   • T-2026-130: The '/Sq. Ft.' variant of Monthly Maintenance
  //     (rate-per-area) on flat / bungalow / rowhouse / commercial
  //     newSale ALSO gates on stage now. The Joi.when block keys off the
  //     field name (`maintenanceMonthly`), which is polymorphic across
  //     both unit variants — so no code change is needed here; the strip
  //     covers the /Sq. Ft. variant automatically. Prior T-2026-125
  //     comment ("never emitted alongside stageOfConstruction") is now
  //     factually stale and superseded.
  //   • .required() on `is:` is CRITICAL — without it, missing/undefined
  //     stageOfConstruction spuriously matches the `is` branch and
  //     leaks maintenanceMonthly past the strip. Documented in the
  //     T-2026-121 parkingType block above.
  //   • Belt-and-suspenders with FE sanitizer: legacy callers, older
  //     FE bundles, direct API scripts, and stale drafts are all
  //     cleaned at the BE boundary.
  maintenanceMonthly: Joi.when('stageOfConstruction', {
    is: Joi.string().valid('Under Construction').required(),
    then: Joi.any().strip(),
    otherwise: priceLike.allow('', null),
  }),

  // Prices (rarely stored raw here — most price fields are master-code
  // budget buckets — but if free-form, we cap them like the top-level price)
  priceLakh: priceLike.allow('', null),
  amount: priceLike.allow('', null),

  // Master-backed selects — the client passes a master code; validate shape.
  bunglowSize: orCodeArray(masterCodeField),
  // bunglowStatus: masterCodeField, — DISABLED (T-2026-081): per-property Status master retired. `.unknown(true)` on the parent schema lets any legacy value from historical records pass through untouched.
  // flatType is `select` in some flat variants, `dualMode` in others.
  flatType: dualModeOrScalar,
  flatSize: orCodeArray(masterCodeField),
  // flatStatus: masterCodeField, — DISABLED (T-2026-081)
  flatNature: masterCodeField,

  // T-2026-122: Canonical Property Specifications block for every FLAT
  // variant (see FE src/admin/pages/Inventory/dynamic/flatSpecificationsSection.js).
  // Every Flat variant (Sale New/Resale, Purchase Resale/New, Rent Out
  // Resale/New, Rent In Resale/New, Lease Out Resale/New, Lease In Resale/
  // New — 12 non-JV variants + Enquiry surface) emits these 9 fields in
  // exact order with exact labels.
  //
  //   flatSize            — already declared above (masterCodeField).
  //   facing              — already declared at L178 (dualModeOrScalar);
  //                         reused verbatim by the canonical helper.
  //   wing                — dualModeOrScalar: plain `select` on the short-
  //                         spec Sale / Rent Out / Lease Out family;
  //                         `dualMode` on the long-spec Purchase / Rent In /
  //                         Lease In family. JSON key `wing` unchanged from
  //                         its pre-T-2026-122 storage (some variants stored
  //                         it inside the `location` group; only the visual
  //                         section moved — payload wire is byte-identical).
  //   floor               — dualModeOrScalar: same polymorphism as facing/wing.
  //   outOfFloor          — masterCodeField (`floor_level` master; always a
  //                         plain select on every Flat variant).
  //   totalFlatsOnFloor   — nonNegDistance (0..10_000; accepts blank/null).
  //   totalFlatsInWing    — nonNegDistance (was on short-spec variants pre-
  //                         T-2026-122; becomes universal via the canonical
  //                         helper. `.unknown(true)` on parent meant the key
  //                         already flowed through today — this tightens the
  //                         shape without changing behaviour).
  //   totalFlatsInPhase   — nonNegDistance (new key; blank on legacy records).
  //   totalFlatsInProject — nonNegDistance (was on short-spec variants pre-
  //                         T-2026-122; becomes universal).
  //
  // Parent schema is `.unknown(true)` — legacy records that never carried
  // any of these keys pass through unchanged (fields render blank on hydrate).
  wing:                dualModeOrScalar,
  floor: orCodeArray(dualModeOrScalar),
  outOfFloor: orCodeArray(masterCodeField),
  totalFlatsOnFloor:   nonNegDistance.allow('', null),
  totalFlatsInWing:    nonNegDistance.allow('', null),
  totalFlatsInPhase:   nonNegDistance.allow('', null),
  totalFlatsInProject: nonNegDistance.allow('', null),
  // plotType / plotShape are `select` in single-mode plot variants and
  // `dualMode` in dual-mode purchase / rent-in / lease-in variants.
  plotType: dualModeOrScalar,
  // plotStatus: masterCodeField, — DISABLED (T-2026-081)
  plotShape: orCodeArray(dualModeOrScalar),
  plotCorner: masterCodeField,

  // T-2026-118: Plot Corner + dynamic Plot Facing / Road Approach pairs.
  // Corner drives how many Plot Facing + Road Approach input pairs the
  // Plot Registration form surfaces (N ∈ {1..4} corresponding to Corner
  // codes 1_road..4_road). Single-mode variants (leaseIn / leaseOut /
  // rentIn / rentOut / sale) render `corner` as a scalar master code;
  // the Purchase variant renders it as a dualMode `{ specific, any }`.
  // Same polymorphism applies to every plotFacing / roadApproach slot.
  // dualModeOrScalar accepts both shapes and coerces scalars to the
  // dualMode object form for storage — matches the pattern already used
  // by plotType / plotShape / landType etc.
  //
  // Pair-1 slots use the legacy unsuffixed keys (`plotFacing` /
  // `roadApproach`) so records saved before T-2026-118 stay byte-identical
  // in storage. Pair-2..4 slots use suffixed keys. The FE renderer honours
  // the visibility gate (only pairs 1..N are surfaced) but hidden pair
  // values may still ride through the payload — Joi accepts all 4 slots
  // and the server stores whatever the client sends. Cleaning is a client
  // responsibility (rule 5: in-memory recovery when N shrinks and grows).
  corner:         dualModeOrScalar,
  plotFacing: orCodeArray(dualModeOrScalar),
  plotFacing2: orCodeArray(dualModeOrScalar),
  plotFacing3: orCodeArray(dualModeOrScalar),
  plotFacing4: orCodeArray(dualModeOrScalar),
  roadApproach: orCodeArray(dualModeOrScalar),
  roadApproach2: orCodeArray(dualModeOrScalar),
  roadApproach3: orCodeArray(dualModeOrScalar),
  roadApproach4: orCodeArray(dualModeOrScalar),
  plotAreaUnit: masterCodeField,
  plotRateUnit: masterCodeField,
  plotLayoutStatus: masterCodeField,
  // shopStatus: masterCodeField, — DISABLED (T-2026-081)
  // commercialStatus: masterCodeField, — DISABLED (T-2026-081)
  // landStatus: masterCodeField, — DISABLED (T-2026-081)
  // Land keys are polymorphic across variants — sometimes `select` (scalar),
  // sometimes `dualMode` (`{specific, any}`). Use dualModeOrScalar so both
  // shapes pass and get coerced to the object form for storage.
  landZone: dualModeOrScalar,
  landVariety: dualModeOrScalar,
  landType: dualModeOrScalar,
  landAreaUnit: masterCodeField,

  // ─── Advanced Land Pricing & Government Valuation module ────────────
  // Land + SEZ Land Sale / Purchase forms only. Every field below is
  // computed or entered client-side by the DynamicPropertyForm's
  // patchField interceptor (see landPricingCalc.js) and rides through
  // the dynamicData JSON blob. Numbers arrive as strings (the FE
  // interceptor writes 2-dp trimmed strings) — Joi's default `convert`
  // coerces them back to numbers.

  // Source-unit stamp — set by the DynamicPropertyForm patchField
  // interceptor whenever the user edits a rate field (Family A rate* on
  // Land, Family B budgetPer* on SEZ Land). One of six canonical unit
  // labels (`sqm`, `sqft`, `guntha`, `acre`, `hectare`, `yard`) or empty
  // when no rate has been entered yet. Backend + FE agree on this key
  // so `actualCalculatedPropertyPrice` = source_rate × source_area
  // computes to identical values in both places.
  lastEditedRateUnit: Joi.string().trim().valid('', 'sqm', 'sqft', 'guntha', 'acre', 'hectare', 'yard').allow(null),
  // Source-unit stamp for the Government Valuation subsection — same
  // six-unit vocabulary. Independent from the Actual Pricing source
  // (`lastEditedRateUnit`) so the user can pick differently for each.
  lastEditedGovRateUnit: Joi.string().trim().valid('', 'sqm', 'sqft', 'guntha', 'acre', 'hectare', 'yard').allow(null),

  // Area — 6 canonical land-unit fields. `areaSqft`, `areaGuntha`,
  // `areaAcre`, `areaHectare` are legacy keys (pre-module records used
  // them) and stay verbatim. `areaSqMeter` + `areaVarYard` are new.
  areaSqMeter: nonNegArea.allow('', null),
  areaSqft:    nonNegArea.allow('', null),
  areaGuntha:  nonNegArea.allow('', null),
  areaAcre:    nonNegArea.allow('', null),
  areaHectare: nonNegArea.allow('', null),
  areaVarYard: nonNegArea.allow('', null),

  // Actual Pricing rate fields (Family A — Land forms). 6 canonical
  // units + the auto-computed actualCalculatedPropertyPrice (Row 4
  // read-only) + Lumpsum (Row 4 manual entry).
  rateSqMeter:                  priceLike.allow('', null),
  rateSqft:                     priceLike.allow('', null),
  rateGuntha:                   priceLike.allow('', null),
  rateAcre:                     priceLike.allow('', null),
  rateHectare:                  priceLike.allow('', null),
  rateVarYard:                  priceLike.allow('', null),
  actualCalculatedPropertyPrice: priceLike.allow('', null),
  lumpsum:                      priceLike.allow('', null),

  // Actual Pricing rate fields (Family B — SEZ Land forms). Same 6 units
  // as Family A but under the historic `budgetPer*` naming.
  budgetPerSqMeter: priceLike.allow('', null),
  budgetPerSqft:    priceLike.allow('', null),
  budgetPerGuntha:  priceLike.allow('', null),
  budgetPerAcre:    priceLike.allow('', null),
  budgetPerHectare: priceLike.allow('', null),
  budgetPerVarYard: priceLike.allow('', null),

  // Government Valuation rate fields (Family D). Independent from
  // Actual Pricing families A/B/C. Same 6-unit shape.
  govRateSqMeter: priceLike.allow('', null),
  govRateSqft:    priceLike.allow('', null),
  govRateGuntha:  priceLike.allow('', null),
  govRateAcre:    priceLike.allow('', null),
  govRateHectare: priceLike.allow('', null),
  govRateVarYard: priceLike.allow('', null),
  // Row 4 of Government Valuation — mirrors actualCalculatedPropertyPrice.
  // Auto-computed as `source_gov_rate × source_area` where the source
  // unit lives on `lastEditedGovRateUnit`.
  governmentCalculatedPropertyPrice: priceLike.allow('', null),

  // T-2026-119 — Automatic Property Price Calculation for the built-up
  // Sale family (Flat / Bungalow / Rowhouse Sale variants). Two NEW
  // canonical rate keys drive the calc:
  //   • ratePerSqFt           — Actual rate (user editable)
  //   • governmentRatePerSqFt — Government rate (user editable)
  // Both are typed as priceLike (0..1000 crore). The calculator
  // (landPricingCalc.js) reads these × `builtUpArea` (already validated
  // above as nonNegArea) to produce actualCalculatedPropertyPrice /
  // governmentCalculatedPropertyPrice (both already validated above).
  // Financial derivations (stampDuty / registrationCharges / lbt /
  // gstAmount / costToCustomer) follow the Maharashtra registration
  // rule (baseValue = max(considerationValue,
  // governmentCalculatedPropertyPrice)) — the numeric keys themselves
  // already exist above; only the FE math changes.
  ratePerSqFt:           priceLike.allow('', null),
  governmentRatePerSqFt: priceLike.allow('', null),

  // Financial subsection. Consideration Value + auto-derived Government
  // charges (stampDuty 5% / registrationCharges 1% / lbt 1% / gstAmount
  // via master-backed gstId → gstPercentage lookup) + manual entry
  // lines + live-sum costToCustomer read-only total.
  considerationValue:     priceLike.allow('', null),
  stampDuty:              priceLike.allow('', null),
  registrationCharges:    priceLike.allow('', null),
  lbt:                    priceLike.allow('', null),
  gstId: orCodeArray(masterCodeField),
  gstPercentage:          percent.allow('', null),
  gstAmount:              priceLike.allow('', null),
  paperNotice:            priceLike.allow('', null),
  documentTypingCharges:  priceLike.allow('', null),
  amountOfStampPaper:     priceLike.allow('', null),
  undertableFees:         priceLike.allow('', null),
  costToCustomer:         priceLike.allow('', null),
  // hostelStatus: masterCodeField, — DISABLED (T-2026-081)
  hostelCategory: orCodeArray(masterCodeField),
  hostelRoomsCount: masterCodeField,
  hostelResidence: masterCodeField,
  hostelFacing: masterCodeField,
  hostelCondition: masterCodeField,
  payingGuestSize: masterCodeField,
  payingGuestFloor: masterCodeField,
  payingGuestFacing: masterCodeField,
  payingGuestCondition: masterCodeField,
  // payingGuestStatus: masterCodeField, — DISABLED (T-2026-081)
  hospitalType: orCodeArray(masterCodeField),
  industrialShedType: masterCodeField,
  industrialPlotStatus: masterCodeField,
  sezType: orCodeArray(masterCodeField),
  tdrZone: masterCodeField,
  tdrFloor: masterCodeField,
  tdrPlotFacing: masterCodeField,
  // tdrStatus: masterCodeField, — DISABLED (T-2026-081)
  bankAuctionProjectType: masterCodeField,
  bankAuctionPendingDues: masterCodeField,
  preLeasedProjectType: masterCodeField,
  // projectSaleStatus: masterCodeField, — DISABLED (T-2026-081)
  projectFacing: masterCodeField,
  projectCondition: masterCodeField,
  // leasePeriod is `select` (master code) in most forms but `text`
  // (free-form like "11 months") in some — accept either.
  leasePeriod: orCodeArray(shortText),
  paymentMode: masterCodeField,
  paymentPeriod: masterCodeField,
  // bankName is `select` (master code) in flat / bungalow / commercial /
  // shop configs, but `text` (free-form name) in project / bank_auction
  // configs. Accept either — a master code fits inside shortText's cap and
  // a free-text bank name is stored as-is.
  bankName: orCodeArray(shortText),
  district: masterCodeField,
  taluka: masterCodeField,
  // shivar is `dualMode` in land dual variants, `text` in single variants —
  // accept both shapes; coerce to `{specific, any}`.
  shivar: dualModeOrScalar,
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
  // Rowhouse — parallel to Bungalow. `rowhousePropertyPosition` replaces
  // the "Bunglow Type" field (Left Corner / Middle / Right Corner) and is
  // a master-code select. All other rowhouse* fields mirror the Bungalow
  // shape.
  rowhousePropertyPosition: orCodeArray(masterCodeField),
  rowhouseSize: orCodeArray(masterCodeField),
  rowhouseLeaseMonthlyBudget: masterCodeField,
  rowhouseLeaseYearlyBudget: masterCodeField,
  rowhouseDepositBudget: masterCodeField,
  rowhouseRentMonthlyBudget: masterCodeField,
  rowhouseRentDepositBudget: masterCodeField,
  rowhouseBookingAmountFixed: masterCodeField,
  rowhousePossessionAfter: masterCodeField,
  rowhouseAgeRange: masterCodeField,
  amenitiesRowhouseFurniture: codeArray,
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
  // Hospital's full section tree (clinical, emergency, ICU, OT, diagnostic,
  // support, equipments, utilities, IT, HR, assets, licenses, safety) pushes
  // a single record's key count close to 150. Cap at 300 to leave headroom
  // for future variants without letting a client bug flood the JSON column.
  .max(300);

// `details` is intentionally a forward-compatible JSON bag, so the schema
// above cannot be a closed list of every future form key. Number-like keys
// therefore get a second, key-aware pass. This covers both known aliases and
// older/alternate keys nested under details.contacts or another form section
// without imposing a schema on unrelated property fields.
function normaliseCommunicationKey(key) {
  // Labels occasionally arrive as JSON keys (for example `Phone No.` or
  // `WhatsApp Contact Number`), so remove punctuation as well as separators.
  return String(key || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function communicationRuleForKey(key) {
  const normalized = normaliseCommunicationKey(key);
  if (!normalized) return null;

  // Plural keys are the arrays used by the contact-card payload.
  if (normalized === 'mobiles') return { kind: 'mobile', array: true, message: MOBILE_ERROR };
  if (normalized === 'phones') return { kind: 'phone', array: true, message: PHONE_ERROR };

  // Mobile / WhatsApp / contact-person fields are mobile-number fields.
  if (/^(?:primary|owner|seller|buyer|purchaser|agent|bankauction)?mobile(?:number|no)?\d*$/.test(normalized)
      || /^whatsapp(?:number|no|contactnumber|contactno)?$/.test(normalized)
      || /^(?:primary|owner|seller|buyer|purchaser|agent|bankauction)?contactperson(?:mobile(?:number|no)?|number|no)$/.test(normalized)
      || /^(?:primary|owner|seller|buyer|purchaser|agent)?contactnumber$/.test(normalized)) {
    return { kind: 'mobile', array: false, message: MOBILE_ERROR };
  }

  // Explicit Phone / Telephone / Landline / Contact No. fields accept either
  // a landline with STD code or a mobile, but remain digits-only.
  if (/^(?:primary|owner|seller|buyer|purchaser|agent|bankauction)?phone(?:number|no)?\d*$/.test(normalized)
      || /^(?:telephone|landline)(?:number|no)?\d*$/.test(normalized)
      || /^(?:primary|owner|seller|buyer|purchaser|agent|bankauction)?contactno\d*$/.test(normalized)
      || /^(?:primary|owner|seller|buyer|purchaser|agent|bankauction)?contactpersonphone(?:number|no)?$/.test(normalized)) {
    return { kind: 'phone', array: false, message: PHONE_ERROR };
  }

  return null;
}

const GUT_SURVEY_KEYS = new Set([
  'gutoldno',
  'gutnewno',
  'gutspecificoldno',
  'gutspecificnewno',
  'gutanyoldno',
  'gutanynewno',
  'gutnoold',
  'gutnonew',
  'gutnumber',
  'plotnoctsnosurveyno',
  'surveyno',
  'surveynumber',
]);

function isGutSurveyKey(key) {
  const normalized = normaliseCommunicationKey(key);
  if (!normalized) return false;

  // Covers current camelCase keys as well as snake_case / label-like keys
  // after punctuation and separators are removed.
  if (GUT_SURVEY_KEYS.has(normalized)) return true;

  // Keep unrelated fields such as "Survey Date" outside this rule.
  return (normalized.includes('gut') || normalized.includes('survey'))
    && (normalized.includes('no')
      || normalized.includes('number')
      || normalized.includes('sr')
      || normalized.includes('cts'));
}

function validateGutSurveyNumbers(value, pathPrefix = '') {
  const prefix = Array.isArray(pathPrefix)
    ? pathPrefix.map((part) => String(part))
    : (pathPrefix ? String(pathPrefix).split('.').filter(Boolean) : []);
  const errors = [];
  const addError = (path) => errors.push({ path: path.join('.'), message: GUT_SURVEY_ERROR });

  const validateScalar = (candidate, path) => {
    if (candidate === undefined || candidate === null || candidate === '') return;
    if (typeof candidate !== 'string' || candidate.length > GUT_SURVEY_MAX_LENGTH) {
      addError(path);
    }
  };

  const walk = (current, path) => {
    if (Array.isArray(current)) {
      current.forEach((item, index) => walk(item, path.concat(index)));
      return;
    }
    if (!current || typeof current !== 'object') return;

    Object.entries(current).forEach(([key, child]) => {
      const childPath = path.concat(key);
      if (isGutSurveyKey(key)) {
        validateScalar(child, childPath);
      } else {
        walk(child, childPath);
      }
    });
  };

  walk(value, prefix);
  return errors;
}

function validateCommunicationNumbers(value, pathPrefix = '') {
  const prefix = Array.isArray(pathPrefix)
    ? pathPrefix.map((part) => String(part))
    : (pathPrefix ? String(pathPrefix).split('.').filter(Boolean) : []);
  const errors = [];

  const addError = (path, message) => {
    errors.push({ path: path.join('.'), message });
  };

  const validateScalar = (candidate, path, rule) => {
    // Missing keys and genuinely empty optional slots are allowed. Whitespace
    // is deliberately NOT trimmed: spaces are invalid input for both rules.
    if (candidate === undefined || candidate === null || candidate === '') return;
    if (typeof candidate !== 'string') {
      addError(path, rule.message);
      return;
    }
    const pattern = rule.kind === 'mobile' ? MOBILE_RE : PHONE_RE;
    if (!pattern.test(candidate)) addError(path, rule.message);
  };

  const walk = (current, path) => {
    if (Array.isArray(current)) {
      current.forEach((item, index) => walk(item, path.concat(index)));
      return;
    }
    if (!current || typeof current !== 'object') return;

    Object.entries(current).forEach(([key, child]) => {
      const childPath = path.concat(key);
      const rule = communicationRuleForKey(key);
      if (!rule) {
        walk(child, childPath);
        return;
      }
      if (rule.array) {
        if (!Array.isArray(child)) {
          addError(childPath, rule.message);
          return;
        }
        child.forEach((item, index) => validateScalar(item, childPath.concat(index), rule));
        return;
      }
      validateScalar(child, childPath, rule);
    });
  };

  walk(value, prefix);
  return errors;
}

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
  // Run the schema for its side-effects (dualModeOrScalar coercion, trim,
  // default arrays) but never surface errors — every property field is
  // optional and the API accepts any partial payload. If Joi rejects, fall
  // back to the raw input so nothing is lost.
  const { value, error } = dynamicDataSchema.validate(dynamicData, {
    abortEarly: false,
    stripUnknown: false,
    convert: true,
  });
  // The dynamic schema intentionally remains permissive for unrelated
  // category fields, but number fields must never be bypassable through the
  // JSON blob. The recursive pass also catches number-like keys that were
  // added after this schema was authored, including legacy details.contacts.
  const errors = [];
  const seen = new Set();
  const addError = (entry) => {
    const key = `${entry.path}\u0000${entry.message}`;
    if (seen.has(key)) return;
    seen.add(key);
    errors.push(entry);
  };
  validateCommunicationNumbers(dynamicData).forEach(addError);
  validateGutSurveyNumbers(dynamicData).forEach(addError);

  // Keep Joi's type/shape failures for known number fields as a backstop. The
  // recursive validator normally reports the same path, so deduplication
  // keeps the API response stable and easy for the frontend to route.
  (error?.details || [])
    .filter((detail) => detail.path
      .some((part) => communicationRuleForKey(part) || isGutSurveyKey(part)))
    .forEach((detail) => addError({
      path: detail.path.join('.'),
      message: detail.message,
    }));
  return { value: value ?? dynamicData, errors };
}

module.exports = {
  validateDynamicData,
  validateCommunicationNumbers,
  validateGutSurveyNumbers,
};
