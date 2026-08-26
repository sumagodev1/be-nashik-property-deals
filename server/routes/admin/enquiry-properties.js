const express = require('express');
const Joi = require('joi');

const { validate, summarizeDetails: summarizeDetailMessages } = require('../../middleware/validate');
const { requireAuth, requireModule, requireModuleWriteOnMutation } = require('../../middleware/auth');
const { imageUploadMiddleware, documentUploadMiddleware } = require('../../middleware/imageMulter');
const idempotency = require('../../middleware/idempotency');
const management = require('../../services/enquiry/management');
const { shareProperty } = require('../../services/properties/shareProperty');
// dynamicData validation is table-agnostic — reused from the inventory
// service to keep the shape rules (contact/phone/email/dualMode/etc.)
// authored in one place. Enquiry rows use the same DynamicPropertyForm
// engine on the frontend, so the payload shape is identical.
const {
  validateDynamicData,
  validateCommunicationNumbers,
  validateGutSurveyNumbers,
} = require('../../services/inventory/dynamicDataValidation');
const { computeLandPricing } = require('../../services/inventory/landPricingCompute');
const { computeLandFrontage } = require('../../services/inventory/landFrontageCompute');
const {
  AREA_UNITS,
} = require('../../constants/property');

const masterCodeField = Joi.string().trim().lowercase().pattern(/^[a-z0-9][a-z0-9_-]{0,62}[a-z0-9]$/);

const { MODULES } = require('../../constants/modules');
const { HttpError } = require('../../middleware/errors');

const router = express.Router();

// T-2026-174: this router now gates on the discrete ENQUIRY_PROPERTIES
// key (formerly bundled under INVENTORY_MANAGEMENT). Backward-compat is
// preserved by (a) migration 111 fanning out every pre-T-174 sub_admin
// grant on INVENTORY_MANAGEMENT into 5 discrete rows (including
// ENQUIRY_PROPERTIES), and (b) middleware/auth.js#hasGrant treating a
// legacy 'inventory_management' entry (in JWT payload OR pre-migration
// SQL row) as an implicit grant on any of the 5 new keys via
// LEGACY_UMBRELLA_ALIASES. Admin bypasses via requireModule's
// role==='admin' short-circuit.
router.use(requireAuth, requireModule(MODULES.ENQUIRY_PROPERTIES));
// Sub-admins with only Read access on ENQUIRY_PROPERTIES get 403 on
// POST/PUT/PATCH/DELETE while GET/HEAD/OPTIONS pass through.
router.use(requireModuleWriteOnMutation(MODULES.ENQUIRY_PROPERTIES));

const idParam = Joi.object({ id: Joi.number().integer().positive().required() });
const subIdParam = Joi.object({
  id: Joi.number().integer().positive().required(),
  fileId: Joi.number().integer().positive().required(),
});

// Most property/enquiry fields are optional at the API layer. Only structural
// caps (max lengths, non-negative bounds) remain — no min lengths, no format
// patterns (one exception: `title`, below), no `.required()` on property
// fields.
//
// The 7 product-mandatory fields (Property Description, Owner Contact Name,
// Owner Contact Number, District, Taluka, Village, Address) ARE enforced —
// via `requiredWhenNotDraft` below — matching the Inventory route so an
// Enquiry submit that omits any of them is rejected with a 400
// VALIDATION_ERROR. Drafts stay lenient. Website Self Registration uses a
// separate route surface and is NOT affected.
// Title stays OPTIONAL: .allow() short-circuits every other rule, so blank
// and omitted titles pass untouched. Only a non-empty, letter-free title is
// rejected. Unanchored, so "3 BHK Flat - Gangapur Rd." still passes.
// Mirrors titleRules() on the FE, message included, and applies on the draft
// path too (one schema serves both), which is where QA hit it.
const titleField = Joi.string().trim().max(255).allow('', null)
  .pattern(/[A-Za-z]/)
  .messages({ 'string.pattern.base': 'Title must contain at least one letter' });
const descField = Joi.string().trim().max(2000).allow('', null);
const locField = Joi.string().trim().max(255).allow('', null);
const propertyTypeField = Joi.string().trim().max(255).allow('', null);
const mobileField = Joi.string().pattern(/^[6-9]\d{9}$/).allow('', null)
  .messages({
    'string.base': 'Enter a valid 10-digit mobile number starting with 6-9',
    'string.pattern.base': 'Enter a valid 10-digit mobile number starting with 6-9',
  });
const personField = Joi.string().trim().max(255).allow('', null);

// Mirror of the helper in inventory-properties.js — see the comment there
// for the full contract. Kept as a local copy so the two route files stay
// independently editable (structural mirrors by design).
function requiredWhenNotDraft(baseSchema, msg) {
  return Joi.when('isDraft', {
    is: true,
    then: baseSchema,
    otherwise: baseSchema
      .required()
      .disallow('', null)
      .messages({
        'any.required':  msg,
        'any.invalid':   msg,
        'string.empty':  msg,
      }),
  });
}

const listQuery = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(100).default(10),
  search: Joi.string().trim().max(255).allow('').optional(),
  propertyType: Joi.string().trim().max(255).allow('').optional(),
  transactionType: Joi.string().trim().max(255).allow('').optional(),
  // Owner Search filter (T-2026-032, additive). Mirror of the inventory
  // route field. Owner-only LIKE — see routes/admin/inventory-properties.js
  // for the full contract.
  ownerSearch: Joi.string().trim().max(255).allow('').optional(),
  // Cascading filter additions (2026-07-14) — mirror of the inventory
  // route. See routes/admin/inventory-properties.js listQuery for the
  // full contract; these two schemas are structural mirrors by design.
  district: masterCodeField.allow('').optional(),
  taluka: masterCodeField.allow('').optional(),
  shivar: masterCodeField.allow('').optional(),
  propertyTypeIn: Joi.string().max(8192).allow('').optional(),
  // Cascading Transaction Type + Property Variety filters — additive
  // (2026-08-03). Mirror of the inventory route field set. See
  // routes/admin/inventory-properties.js for the full contract.
  transactionTypeCode:  Joi.string().trim().max(255).allow('').optional(),
  transactionTypeLabel: Joi.string().trim().max(255).allow('').optional(),
  propertyVarietyCode:  Joi.string().trim().max(255).allow('').optional(),
  propertyVarietyLabel: Joi.string().trim().max(255).allow('').optional(),
  status: masterCodeField.optional(),
  location: Joi.string().trim().max(255).optional(),
  // Curated Area filter. ONE param name for both surfaces; each query maps
  // it to its own storage - Inventory to the new area_name column, Enquiry
  // to its existing location column where its Area dropdown already lands.
  area: Joi.string().trim().max(255).optional(),
  priceMin: Joi.number().min(0).optional(),
  priceMax: Joi.number().min(0).optional(),
  // T-2026-109: Budget Range filter (Min / Max Rs.). Mirror of the sibling
  // block in routes/admin/inventory-properties.js — see there for full
  // contract. FE ↔ BE param name parity: minBudget / maxBudget.
  minBudget: Joi.number().min(0).optional(),
  maxBudget: Joi.number().min(0).optional(),
  dateFrom: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
  // T-2026-117: Draft Status list filter. Mirror of the identically-named
  // block in routes/admin/inventory-properties.js — the two lists share a
  // single query-string key (`draftStatus`) so FE and BE stay symmetric
  // across surfaces. Two documented values plus absence — anything else
  // returns 400 VALIDATION_ERROR (no silent coercion). Normalised into
  // the internal `isDraft` boolean by applyDraftStatusFilter() below
  // before the service call. Composes cleanly with every other filter.
  draftStatus: Joi.string().valid('all', 'draft').optional().messages({
    'any.only': 'draftStatus must be either "all" or "draft".',
  }),
  sort: Joi.string()
    .pattern(/^(created_at|property_code|price|location|property_type|title):(asc|desc)$/)
    .default('title:asc'),
});

// T-2026-117: Normalise the public `draftStatus` list-filter param into
// the internal `isDraft` boolean that db/queries/enquiry_properties.js
// already understands. Mirror of the identically-named helper in
// routes/admin/inventory-properties.js — the two files stay independently
// editable (structural mirrors by design).
function applyDraftStatusFilter(query) {
  const { draftStatus, ...rest } = query || {};
  if (draftStatus === 'draft') return { ...rest, isDraft: true };
  return rest;
}

const PRICE_MAX = 1_000_00_00_000;
const AREA_MAX = 10_00_000;

// Every property field is optional. Accepts partial payloads.
const propertyBody = Joi.object({
  title: titleField,
  // Property Description — MANDATORY on every Enquiry submit. Promoted on
  // the FE from `details.dynamicData.propertyDescription`.
  description: requiredWhenNotDraft(descField, 'Property Description is required.'),
  // Posting Date — OPTIONAL per product policy (only the 7 fields listed at
  // the top of this file are mandatory). Renamed from `registrationDate`
  // alongside migration 081. If the client omits it, the route body handler
  // backfills today's date so the NOT NULL DB column still lands a value.
  postingDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional().allow('', null),
  // Available From Date — optional.
  availableFromDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional().allow('', null),
  // T-2026-112: Agreement Tracking & Reminder System — see the
  // matching block in server/routes/admin/inventory-properties.js
  // for the full rationale. Both optional at the API layer; the
  // middleware below enforces end >= start when both are provided.
  agreementStartDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional().allow('', null),
  agreementEndDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional().allow('', null),
  propertyType: propertyTypeField,
  transactionType: Joi.string().trim().max(255).allow('', null).optional(),
  transactionVariant: masterCodeField.optional().allow('', null),
  // T-2026-055: Property Type / Transaction Type / Property Variety
  // {id, name} pair fields captured verbatim from the pre-form chooser
  // (PropertyTypeChooser.jsx). Additive/optional. See
  // migration 062 for column definitions.
  propertyTypeId:       Joi.number().integer().min(1).optional().allow(null, ''),
  propertyTypeName:     Joi.string().trim().max(255).allow('', null).optional(),
  transactionTypeId:    Joi.number().integer().min(1).optional().allow(null, ''),
  transactionTypeName:  Joi.string().trim().max(255).allow('', null).optional(),
  propertyVarietyId:    Joi.number().integer().min(1).optional().allow(null, ''),
  propertyVarietyName:  Joi.string().trim().max(255).allow('', null).optional(),
  // "Location with Landmark" — MANDATORY. Free-text captured alongside the
  // District/Taluka/Village cascade.
  // Enquiry labels this field "Area" (Inventory still calls it "Location"),
  // and the FE mirrors the server wording verbatim, so the two must agree.
  location: requiredWhenNotDraft(locField, 'Area is required.'),
  district: requiredWhenNotDraft(masterCodeField, 'District is required.'),
  taluka: requiredWhenNotDraft(masterCodeField, 'Taluka is required.'),
  shivar: requiredWhenNotDraft(masterCodeField, 'Village is required.'),
  latitude: Joi.number().min(-90).max(90).optional().allow(null, ''),
  longitude: Joi.number().min(-180).max(180).optional().allow(null, ''),
  // T-2026-048: reverse-geocoded human-readable address paired with lat/lng.
  formattedAddress: Joi.string().trim().max(300).allow('', null).optional(),
  pincode: Joi.string().trim().max(20).allow('', null).optional(),
  areaValue: Joi.number().min(0).max(AREA_MAX).optional().allow(null, ''),
  areaUnit: Joi.string().max(50).optional().allow('', null),
  bhk: masterCodeField.optional().allow('', null),
  price: Joi.number().min(0).max(PRICE_MAX).optional().allow(null, ''),
  // T-2026-086: default MUST be an ACTIVE code in the `enquiry_status`
  // master (T-2026-080 split from status_type). 'available' was the legacy
  // default here — since the split it lives in enquiry_status as an
  // INACTIVE fallback row, so a Joi-injected 'available' would trip
  // assertActiveCode('enquiry_status', ...) at the service layer. Any
  // enquiry create that omits `status` (typical: forms without an in-form
  // Status field, e.g. Hospital Enquiry) now lands on the canonical
  // starting state 'new_enquiry' instead.
  status: masterCodeField.default('new_enquiry'),
  isDraft: Joi.boolean().default(false),
  // T-2026-040: Owner-duplicate confirmation bypass flag. Frontend sets
  // this to true after the operator confirms the "Duplicate Owner Found"
  // dialog so any (optional) backend duplicate check can be skipped on the
  // retry submit. Currently no backend duplicate check exists on this
  // route, but the flag is accepted here so any future check can honour
  // the confirmation without a schema change. The service layer uses a
  // column-listed INSERT so this key is naturally stripped before the DB.
  skipDuplicateOwnerValidation: Joi.boolean().optional(),
  // Owner Contact Name + Number — MANDATORY on every Enquiry submit.
  // Promoted from the first contact card in `details.dynamicData.contacts[0]`
  // by the FE before submit so the DB flat columns match the FE input.
  ownerName: requiredWhenNotDraft(personField, 'Owner Contact Name is required.'),
  ownerContact: requiredWhenNotDraft(mobileField, 'Owner Contact Number is required.'),
  agentName: personField.optional(),
  agentContact: mobileField.optional(),
  details: Joi.object().unknown(true).max(200).optional().allow(null),
}).unknown(true);

const statusBody = Joi.object({
  status: masterCodeField.required(),
  note: Joi.string().trim().max(500).allow('', null).optional(),
});

const suggestQuery = Joi.object({
  q: Joi.string().trim().max(255).allow('').optional(),
  limit: Joi.number().integer().min(1).max(20).default(8),
  includeDrafts: Joi.boolean().default(false),
});

const exportQuery = listQuery.fork(['page', 'pageSize'], (s) => s.optional());

// ENQUIRY-ONLY: the "Nature" field (dynamicData.nature) is a MULTI-select on
// the Enquiry surface, so it is stored/returned as an array of master codes.
// Coerce whatever the client sends into a clean, de-duped array:
//   - legacy scalar  'apartment'            -> ['apartment']   (backward compat)
//   - array          ['apartment','society'] -> as-is (trimmed, de-duped)
//   - '' / null / undefined                  -> [] (or left absent)
// This lives here (route-local) so the shared dynamic-data validator and the
// Inventory route stay byte-for-byte unchanged — Inventory keeps its single
// scalar Nature.
function cleanCodeList(list) {
  const seen = new Set();
  const out = [];
  for (const v of list) {
    if (v === null || v === undefined) continue;
    // Numbers stay numbers — only strings are trimmed. De-dupe is
    // case-insensitive on the string form so 'East' and 'east' collapse.
    const value = typeof v === 'string' ? v.trim() : v;
    if (value === '') continue;
    const k = String(value).toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(value);
  }
  return out;
}

// ENQUIRY-ONLY: dropdowns on this surface are checkbox MULTI-selects (the
// record is a customer requirement — "2BHK or 3BHK", "East or West", "Nashik
// or Pune"), so their dynamicData values arrive as arrays of master codes.
// See the frontend's enquiryMultiSelectPolicy.js for which keys are eligible.
//
// Rather than mirroring that key list here — it would drift the moment a form
// gains a dropdown — this normalises by SHAPE: any array of primitives is
// trimmed, blank-stripped and de-duped. That covers the multi-select
// dropdowns and the multiSelect amenity/defect checkboxes alike, and is a
// no-op for values that are already clean.
//
// Arrays of OBJECTS (contacts, keyPersons) are skipped untouched — they are
// validated by their own contactShape schema and must keep their structure.
//
// `nature` additionally keeps its legacy scalar -> array promotion: it has
// been a multi-select on this surface since before the general rollout, so a
// record saved as 'apartment' must still read back as ['apartment'].
function normalizeEnquiryMultiSelects(dyn) {
  if (!dyn || typeof dyn !== 'object') return;

  if (Object.prototype.hasOwnProperty.call(dyn, 'nature')) {
    const raw = dyn.nature;
    dyn.nature = cleanCodeList(Array.isArray(raw)
      ? raw
      : (raw === '' || raw === null || raw === undefined ? [] : [raw]));
  }

  for (const key of Object.keys(dyn)) {
    if (key === 'nature') continue;               // handled above
    const raw = dyn[key];
    if (!Array.isArray(raw)) continue;            // scalars are left alone
    // Contact / key-person lists (and any other structured array) keep their
    // shape — only flat code lists are cleaned.
    if (raw.some((v) => v !== null && typeof v === 'object')) continue;
    dyn[key] = cleanCodeList(raw);
  }
}

function validateDynamicDataMiddleware(req, res, next) {
  try {
    const body = req.body || {};
    // `details` is an open JSON bag for backward-compatible form variants.
    // Validate every existing mobile/phone-shaped key here as well as inside
    // dynamicData, so legacy details.contacts and older hardcoded sections
    // cannot bypass the number rules on create, update, or draft save.
    const detailNumberErrors = [
      ...validateCommunicationNumbers(body.details, 'details'),
      ...validateGutSurveyNumbers(body.details, 'details'),
    ];
    // Enquiry-only Nature array coercion runs for drafts too so the stored
    // shape stays consistent whether or not the record is a draft.
    if (body.details && body.details.dynamicData) {
      normalizeEnquiryMultiSelects(body.details.dynamicData);
    }
    // T-2026-112: Cross-field agreement dates check — end must be
    // >= start when BOTH are provided. Same logic as the inventory
    // route, applied uniformly to drafts + non-drafts.
    const agrStart = typeof body.agreementStartDate === 'string' ? body.agreementStartDate.trim() : '';
    const agrEnd = typeof body.agreementEndDate === 'string' ? body.agreementEndDate.trim() : '';
    if (agrStart && agrEnd && agrEnd < agrStart) {
      return next(new HttpError(400, 'VALIDATION_ERROR', 'Agreement End Date cannot be earlier than Agreement Start Date.', [{
        path: 'agreementEndDate',
        message: 'Agreement End Date cannot be earlier than Agreement Start Date.',
      }]));
    }
    const dyn = body.details && body.details.dynamicData;
    // Product-mandatory dynamic-form field: Address lives on
    // `details.dynamicData.address` (no top-level column). Enforce it here
    // so the FE gets a routable per-field VALIDATION_ERROR when the admin
    // submits without it. Every other product-mandatory field is enforced
    // by the top-level Joi `propertyBody`.
    const mandatoryDynErrors = [];
    const addressVal = dyn && typeof dyn.address === 'string' ? dyn.address.trim() : '';
    if (!addressVal) {
      mandatoryDynErrors.push({
        path: 'details.dynamicData.address',
        message: 'Address is required.',
      });
    }
    if (!dyn) {
      const details = [
        ...detailNumberErrors,
        ...(body.isDraft ? [] : mandatoryDynErrors),
      ];
      if (details.length > 0) {
        return next(new HttpError(400, 'VALIDATION_ERROR', summarizeDetailMessages(details), details));
      }
      return next();
    }
    const { value, errors } = validateDynamicData(dyn);
    const dynamicNumberErrors = errors.map((e) => ({
      path: `details.dynamicData.${e.path}`,
      message: e.message,
    }));
    const numberAndShapeErrors = [...detailNumberErrors, ...dynamicNumberErrors]
      .filter((entry, index, all) => all.findIndex((candidate) =>
        candidate.path === entry.path && candidate.message === entry.message) === index);
    if (numberAndShapeErrors.length > 0 || (!body.isDraft && mandatoryDynErrors.length > 0)) {
      const details = [
        ...(body.isDraft ? [] : mandatoryDynErrors),
        ...numberAndShapeErrors,
      ];
      return next(new HttpError(400, 'VALIDATION_ERROR', summarizeDetailMessages(details), details));
    }
    if (body.isDraft) {
      req.body.details.dynamicData = value;
      return next();
    }
    // Advanced Land Pricing recompute (2026-08-05): recompute the
    // derived-value fields on Land Sale / Purchase and SEZ Land Sale /
    // Purchase records so the DB row matches what the FE calculator
    // would produce. Idempotent on any input; no-op for other property
    // types. Enquiry forms share the same dynamicData layout as
    // Inventory forms, so the same helper applies unchanged.
    const propertyType = req.body.propertyType || req.body.property_type;
    // T-2026-107: Land Frontage Foot -> Distance auto-derivation runs
    // FIRST so the pricing recompute (and any downstream analytics) see
    // the corrected Distance value. Idempotent; no-op when neither field
    // is present.
    let dynAfterFrontage = computeLandFrontage(value);
    req.body.details.dynamicData = computeLandPricing(dynAfterFrontage, propertyType);
    // The shared validator preserves unknown keys (stripUnknown:false) and
    // never touches `nature`, but re-assert the array shape defensively in
    // case any coercion pass reshaped it.
    normalizeEnquiryMultiSelects(req.body.details.dynamicData);
    return next();
  } catch (err) {
    return next(err);
  }
}

router.get('/', validate(listQuery, 'query'), async (req, res, next) => {
  try {
    res.json(await management.listProperties(applyDraftStatusFilter(req.query)));
  } catch (err) {
    next(err);
  }
});

router.get('/suggest', validate(suggestQuery, 'query'), async (req, res, next) => {
  try {
    res.json({ data: await management.suggest(req.query) });
  } catch (err) {
    next(err);
  }
});

// T-2026-072: pass req.auth through so the branded PDF header renders
// "Generated By". Standardised filenames.
router.get('/export.csv', validate(exportQuery, 'query'), async (req, res, next) => {
  try {
    const csv = await management.exportCsv(applyDraftStatusFilter(req.query), { auth: req.auth });
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="Enquiry_Properties_${stamp}.csv"`);
    res.send(csv);
  } catch (err) {
    next(err);
  }
});

router.get('/export.xlsx', validate(exportQuery, 'query'), async (req, res, next) => {
  try {
    const buffer = await management.exportXlsx(applyDraftStatusFilter(req.query), { auth: req.auth });
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Enquiry_Properties_${stamp}.xlsx"`);
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

router.get('/export.pdf', validate(exportQuery, 'query'), async (req, res, next) => {
  try {
    const buffer = await management.exportPdf(applyDraftStatusFilter(req.query), { auth: req.auth });
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Enquiry_Properties_${stamp}.pdf"`);
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', validate(idParam, 'params'), async (req, res, next) => {
  try {
    res.json(await management.getProperty(req.params.id));
  } catch (err) {
    next(err);
  }
});

router.post('/', idempotency(), validate(propertyBody), validateDynamicDataMiddleware, async (req, res, next) => {
  try {
    const created = await management.createProperty({
      ...req.body,
      price: req.body.price ?? 0,
      // Posting Date is user-supplied. DB column is nullable — pass the
      // client value through untouched (no today() backfill), so an unset
      // field lands NULL and a picked date lands exactly as chosen.
      postingDate: req.body.postingDate || null,
      // T-2026-067: no default injection for the two classification
      // fields — the chooser is the source of truth. A request that
      // omits propertyType / transactionType must fail loudly, not
      // silently default to values the user never chose.
      propertyType: req.body.propertyType,
      transactionType: req.body.transactionType,
      location: req.body.location || '',
      createdByAdminId: req.auth.role === 'admin' ? Number(req.auth.sub) : null,
    });
    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

router.put('/:id', validate(idParam, 'params'), validate(propertyBody), validateDynamicDataMiddleware, async (req, res, next) => {
  try {
    res.json(await management.updateProperty(req.params.id, {
      ...req.body,
      price: req.body.price ?? 0,
      // Posting Date is user-supplied — pass through untouched (nullable
      // DB column). Same rationale as the create handler above.
      postingDate: req.body.postingDate || null,
      // T-2026-067: no default injection for the two classification
      // fields — the chooser is the source of truth. A request that
      // omits propertyType / transactionType must fail loudly, not
      // silently default to values the user never chose.
      propertyType: req.body.propertyType,
      transactionType: req.body.transactionType,
      location: req.body.location || '',
    }));
  } catch (err) {
    next(err);
  }
});

router.patch('/:id/status', idempotency(), validate(idParam, 'params'), validate(statusBody), async (req, res, next) => {
  try {
    const changedBy = req.auth?.role === 'admin' ? Number(req.auth.sub) : null;
    // `req` is forwarded so the service can append the Status History entry
    // to audit_log (it needs the actor + ip off the request). Optional on the
    // service side, so any other caller keeps working unchanged.
    res.json(await management.updateStatus(req.params.id, req.body.status, req.body.note || null, changedBy, req));
  } catch (err) {
    next(err);
  }
});

// Status History for one property: every recorded status change, newest
// first, each with the from/to codes, the operator note if one was typed,
// who changed it and when. Reads audit_log (see management.listStatusHistory
// for why this is not served from the /admin/audit-log router).
router.get('/:id/status-history', validate(idParam, 'params'), async (req, res, next) => {
  try {
    const { rows, total } = await management.listStatusHistory(req.params.id);
    // `metadata` is a JSON column and MariaDB returns it as a string, so
    // parse defensively - same approach as the audit-log router.
    const parse = (v) => {
      if (v === null || v === undefined) return {};
      if (typeof v === 'object') return v;
      try { return JSON.parse(v) || {}; } catch { return {}; }
    };
    res.json({
      data: rows.map((r) => {
        const m = parse(r.metadata);
        return {
          id: r.id,
          from: m.from || null,
          to: m.to || null,
          note: m.note || null,
          actorName: r.actor_name || null,
          changedAt: r.created_at,
        };
      }),
      total,
    });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', validate(idParam, 'params'), async (req, res, next) => {
  try {
    await management.removeProperty(req.params.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.post('/:id/images', validate(idParam, 'params'), imageUploadMiddleware, async (req, res, next) => {
  try {
    if (!req.files || req.files.length === 0) {
      throw new HttpError(400, 'NO_FILES', 'No files uploaded');
    }
    res.status(201).json(await management.addImages(req.params.id, req.files));
  } catch (err) {
    next(err);
  }
});

router.delete('/:id/images/:fileId', validate(subIdParam, 'params'), async (req, res, next) => {
  try {
    res.json(await management.removeImage(req.params.id, req.params.fileId));
  } catch (err) {
    next(err);
  }
});

router.post('/:id/documents', validate(idParam, 'params'), documentUploadMiddleware, async (req, res, next) => {
  try {
    if (!req.files || req.files.length === 0) {
      throw new HttpError(400, 'NO_FILES', 'No files uploaded');
    }
    res.status(201).json(await management.addDocuments(req.params.id, req.files));
  } catch (err) {
    next(err);
  }
});

router.delete('/:id/documents/:fileId', validate(subIdParam, 'params'), async (req, res, next) => {
  try {
    res.json(await management.removeDocument(req.params.id, req.params.fileId));
  } catch (err) {
    next(err);
  }
});

router.get('/:id/documents/:fileId', validate(subIdParam, 'params'), async (req, res, next) => {
  try {
    const file = await management.findDocument(req.params.fileId);
    if (!file || file.property_kind !== 'enquiry' || Number(file.property_id) !== Number(req.params.id) || file.file_kind !== 'document') {
      throw new HttpError(404, 'NOT_FOUND', 'Document not found');
    }
    return management.streamDocument(res, file);
  } catch (err) {
    next(err);
  }
});

// Share the property via email. Runtime-only; owner / staff-only fields are
// stripped inside the share service (never reach the wire).
const shareSectionField = Joi.object({
  key:       Joi.string().trim().max(120).required(),
  label:     Joi.string().trim().max(255).allow('', null).optional(),
  type:      Joi.string().trim().max(64).allow('', null).optional(),
  masterKey: Joi.string().trim().max(120).allow('', null).optional(),
}).unknown(true);
const shareSection = Joi.object({
  key:    Joi.string().trim().max(120).allow('', null).optional(),
  title:  Joi.string().trim().max(255).required(),
  fields: Joi.array().items(shareSectionField).max(200).default([]),
}).unknown(true);
const shareBody = Joi.object({
  recipientEmails: Joi.string().trim().min(3).max(2000).required(),
  subject: Joi.string().trim().max(255).allow('', null).optional(),
  message: Joi.string().trim().max(5000).allow('', null).optional(),
  sections: Joi.array().items(shareSection).max(30).optional(),
  includeDetails:     Joi.boolean().default(true),
  includeDescription: Joi.boolean().default(true),
  includeImages:      Joi.boolean().default(true),
  includeDocuments:   Joi.boolean().default(true),
  includePropertyUrl: Joi.boolean().default(true),
  // false when the operator unticked something in the Share dialog, which
  // tells the service to skip its completion pass and send exactly the
  // chosen sections. Defaults true so any caller that omits it keeps the
  // previous "everything" behaviour.
  completeMissingFields: Joi.boolean().default(true),
});

router.post(
  '/:id/share',
  validate(idParam, 'params'),
  validate(shareBody, 'body'),
  async (req, res, next) => {
    try {
      const result = await shareProperty('enquiry', Number(req.params.id), req.body);
      res.json({ message: 'Property shared successfully.', ...result });
    } catch (err) {
      next(err);
    }
  },
);

module.exports = router;
