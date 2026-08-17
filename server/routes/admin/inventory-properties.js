const express = require('express');
const Joi = require('joi');

const { validate } = require('../../middleware/validate');
const { requireAuth, requireModule, requireModuleWriteOnMutation } = require('../../middleware/auth');
const { imageUploadMiddleware, documentUploadMiddleware } = require('../../middleware/imageMulter');
const idempotency = require('../../middleware/idempotency');
const management = require('../../services/inventory/management');
const { shareProperty } = require('../../services/properties/shareProperty');
const { validateDynamicData } = require('../../services/inventory/dynamicDataValidation');
const { computeLandPricing } = require('../../services/inventory/landPricingCompute');
const { computeLandFrontage } = require('../../services/inventory/landFrontageCompute');
const {
  AREA_UNITS,
} = require('../../constants/property');

// Master codes are validated semantically in the service layer against the
// current master_* tables (which the admin can edit). The shape check below
// just ensures the value looks like a master code so we fail fast on garbage.
const masterCodeField = Joi.string().trim().lowercase().pattern(/^[a-z0-9][a-z0-9_-]{0,62}[a-z0-9]$/);
const { MODULES } = require('../../constants/modules');
const { HttpError } = require('../../middleware/errors');
// T-2026-169 Phase D: direct pool for the batched property-code lookup.
const { pool: dbPool } = require('../../db/pool');

const router = express.Router();

// T-2026-174: split off from INVENTORY_MANAGEMENT umbrella key. This router
// serves the Inventory Properties surface (property owner listings for
// Sell/Rent Out/Lease Out/Out/Joint Venture). Sub-admins now need the
// discrete INVENTORY_PROPERTIES grant. Two layers of backward-compat keep
// pre-T-174 sub-admins fully functional:
//   (a) Migration 111 fans out every pre-T-174 sub_admin_modules row with
//       module_key='inventory_management' into 5 equivalent rows on the
//       new discrete keys (same access_level). Any re-login mints a JWT
//       that carries INVENTORY_PROPERTIES directly.
//   (b) middleware/auth.js#hasGrant treats a legacy 'inventory_management'
//       entry (in either shape) as an implicit grant on any of the 5 new
//       keys via LEGACY_UMBRELLA_ALIASES. So in-flight JWTs issued BEFORE
//       the migration deploy continue to work until refresh.
// Admin bypasses via requireModule's role==='admin' short-circuit.
router.use(requireAuth, requireModule(MODULES.INVENTORY_PROPERTIES));
// Sub-admins with only Read access on INVENTORY_PROPERTIES can hit GET
// endpoints but any POST/PUT/PATCH/DELETE is 403'd here at the router
// level. Nested router below (/:masterId/units) inherits this gate so
// unit CRUD is also write-gated.
router.use(requireModuleWriteOnMutation(MODULES.INVENTORY_PROPERTIES));

// T-2026-137: Builder Property unit CRUD lives on the same router surface
// under /:masterId/units. Mounted with mergeParams:true (see the child
// router file) so it can read :masterId. Mounted here — BEFORE the /:id
// handlers below — so Express's path matcher picks the more specific
// prefix. Auth + module gate are already applied by the router.use above,
// and are inherited by the child router; the child MUST NOT re-apply
// them (would double-invoke and log noise).
router.use('/:masterId/units', require('./inventory-property-units'));

const idParam = Joi.object({ id: Joi.number().integer().positive().required() });
const subIdParam = Joi.object({
  id: Joi.number().integer().positive().required(),
  fileId: Joi.number().integer().positive().required(),
});

// Most property fields are optional at the API layer — the DB accepts partial
// payloads. Callers can send any subset of these keys; missing/empty values
// are treated as "not provided" and never rejected. Only structural sanity
// caps remain (max lengths) to prevent abuse — no min lengths, no format
// patterns, no `.required()` for property fields.
//
// The 7 product-mandatory fields (Property Description, Owner Contact Name,
// Owner Contact Number, District, Taluka, Village, Address) ARE enforced —
// via `requiredWhenNotDraft` below — so a non-draft submission that omits
// any of them is rejected with a 400 VALIDATION_ERROR. Drafts stay lenient
// so half-filled records can still be parked. Applies to every Inventory
// AND Enquiry property form. Website Self Registration uses a separate
// route surface and is NOT affected.
const titleField = Joi.string().trim().max(255).allow('', null);
const descField = Joi.string().trim().max(2000).allow('', null);
const locField = Joi.string().trim().max(255).allow('', null);
const propertyTypeField = Joi.string().trim().max(255).allow('', null);
const phoneField = Joi.string().trim().max(20).allow('', null);
const personField = Joi.string().trim().max(255).allow('', null);

// Wrap a "usually optional" field so it is REQUIRED when `isDraft` is falsy
// (a real submission) and OPTIONAL when `isDraft` is true (half-filled park).
// `msg` is the message the admin sees inline — matches the FE messages so
// the two sides stay consistent when the FE mirrors the BE reject verbatim.
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
  // Owner Search filter (T-2026-032, additive). Narrows the list to rows
  // whose owner-only fields match - owner_name / owner_contact /
  // details.contacts[*] (matched via a JSON LIKE against the details
  // blob). Never matches property_type/title/description/etc. Disjoint
  // from the existing global `search` param.
  ownerSearch: Joi.string().trim().max(255).allow('').optional(),
  // Cascading location filters (2026-07-14). All three are stored as
  // master_lookups.code — validated by masterCodeField shape and matched
  // with '=' in db/queries/inventory_properties.js#list().
  district: masterCodeField.allow('').optional(),
  taluka: masterCodeField.allow('').optional(),
  shivar: masterCodeField.allow('').optional(),
  // Comma-separated list of stripped form labels (see the frontend
  // InventoryListFilterBar.jsx for how this is derived from the chooser
  // tree). Backend splits, dedupes, caps at 200, and turns it into a
  // parameterised property_type IN () clause.
  //   - Individual labels can be long ("Bunglow Registration Form
  //     [Resale Lease In]" stripped → "Bunglow [Resale Lease In]" ~= 30
  //     chars). A cap of 8192 chars comfortably fits the ~89-form tree
  //     even if the user selects the entire top-level Property Type
  //     (all txns × all varieties).
  propertyTypeIn: Joi.string().max(8192).allow('').optional(),
  // Cascading Transaction Type + Property Variety filters — additive
  // (2026-08-03). The FE derives these from the chooser tree selection
  // and sends BOTH the master `code` and canonical `label` so the query
  // can OR-match against records that stored either shape.
  //
  //   transactionTypeCode / transactionTypeLabel
  //     Match against ip.transaction_type (enum) OR ip.transaction_type_name.
  //   propertyVarietyCode / propertyVarietyLabel
  //     Match against ip.transaction_variant OR ip.property_variety_name.
  //
  // See db/queries/inventory_properties.js#list for the WHERE construction.
  transactionTypeCode:  Joi.string().trim().max(255).allow('').optional(),
  transactionTypeLabel: Joi.string().trim().max(255).allow('').optional(),
  propertyVarietyCode:  Joi.string().trim().max(255).allow('').optional(),
  propertyVarietyLabel: Joi.string().trim().max(255).allow('').optional(),
  status: masterCodeField.optional(),
  location: Joi.string().trim().max(255).optional(),
  priceMin: Joi.number().min(0).optional(),
  priceMax: Joi.number().min(0).optional(),
  // T-2026-109: Budget Range filter — Minimum / Maximum Budget in Rs.
  // Compares against the "Actual Property Cost" concept walked out of the
  // dynamicData JSON by the query builder (see queries/inventory_properties.js
  // for the COALESCE priority). Numeric, non-negative, decimals allowed
  // because the underlying `price` column and JSON-extracted candidates are
  // DECIMAL(14,2)-compatible. Both params optional and independently applied
  // — see the FE spec: only-min → >=, only-max → <=, both → range, neither
  // → no clause. FE also enforces min<=max before submit.
  minBudget: Joi.number().min(0).optional(),
  maxBudget: Joi.number().min(0).optional(),
  dateFrom: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
  // T-2026-117: Draft Status list filter. Two documented values plus
  // absence — anything else returns 400 VALIDATION_ERROR with a clear
  // message (no silent coercion). Normalised by applyDraftStatusFilter()
  // below into the internal boolean `isDraft` before the service call,
  // so the query-builder layer (db/queries/inventory_properties.js) sees
  // the existing `isDraft` shape and no lower-layer edits are needed.
  //   * 'draft'           → WHERE ip.is_draft = 1 (only draft rows)
  //   * 'all' or absent   → no additional constraint (byte-identical to
  //                         today's behaviour when the param is omitted).
  // Compose cleanly with every other list filter (district / taluka /
  // property_type / transaction_type / property_variety / status /
  // budget / date range / search) via ANDed WHERE clauses.
  draftStatus: Joi.string().valid('all', 'draft').optional().messages({
    'any.only': 'draftStatus must be either "all" or "draft".',
  }),
  sort: Joi.string()
    .pattern(/^(created_at|price|location|property_type|title):(asc|desc)$/)
    .default('title:asc'),
});

// T-2026-117: Normalise the public `draftStatus` list-filter param into
// the internal `isDraft` boolean that db/queries/inventory_properties.js
// already understands. Returns a NEW object so `req.query` is never
// mutated in place (safer for any downstream middleware / logs that
// re-read the same object).
//   * draftStatus omitted        → out.isDraft = undefined (no WHERE clause)
//   * draftStatus === 'all'      → out.isDraft = undefined (no WHERE clause)
//   * draftStatus === 'draft'    → out.isDraft = true      (WHERE is_draft = 1)
// The `draftStatus` key itself is stripped so downstream services and the
// export path never see it — keeping the internal contract exactly as it
// was before this ticket.
function applyDraftStatusFilter(query) {
  const { draftStatus, ...rest } = query || {};
  if (draftStatus === 'draft') return { ...rest, isDraft: true };
  return rest;
}

// Sanity ceilings — catch typos like an extra zero on price/area without
// being so tight that they reject a real ultra-prime Nashik property.
// 1000 crore (1e10) covers any conceivable real-estate price; 10 lakh sq.ft
// covers any realistic land parcel.
const PRICE_MAX = 1_000_00_00_000;
const AREA_MAX = 10_00_000;

// Every property field is optional. The API accepts partial payloads and
// stores whatever is provided. System-only concerns (max lengths, numeric
// bounds to catch obvious typos) are the only remaining constraints.
const propertyBody = Joi.object({
  title: titleField,
  // Property Description — MANDATORY on every Inventory / Enquiry submit.
  // Populated on the FE by promoting `details.dynamicData.propertyDescription`
  // to the top-level `description` before submit.
  description: requiredWhenNotDraft(descField, 'Property Description is required.'),
  // Posting Date — OPTIONAL per product policy (only the 7 fields listed at
  // the top of this file are mandatory). Renamed from `registrationDate` in
  // T-2026-XXX. The DB column was renamed too (migration 081). If the client
  // omits it, the route body handler backfills today's date so the NOT NULL
  // DB column still lands a value.
  postingDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional().allow('', null),
  // Available From Date — optional. Owner may or may not disclose availability.
  availableFromDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional().allow('', null),
  // T-2026-112: Agreement Tracking & Reminder System — the two dates
  // captured on Rent Out and Lease Out forms only. Both optional at the
  // API layer (drafts must accept partial values); if BOTH are provided,
  // end must be >= start. Any other transaction type submits `null` /
  // `''` for both, which are accepted here and stored as NULL in the DB.
  agreementStartDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional().allow('', null),
  agreementEndDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional().allow('', null),
  propertyType: propertyTypeField,
  transactionType: Joi.string().trim().max(255).allow('', null).optional(),
  transactionVariant: masterCodeField.optional().allow('', null),
  // T-2026-055: Property Type / Transaction Type / Property Variety
  // {id, name} pair fields captured verbatim from the pre-form chooser
  // (PropertyTypeChooser.jsx). Additive/optional so the API contract
  // stays fully backward-compatible with pre-055 callers that only
  // sent the canonical code trio. Stored on dedicated columns; read
  // back verbatim on list/detail/edit/view/website. NEVER derived
  // from title/form-code/heading/name/route.
  propertyTypeId:       Joi.number().integer().min(1).optional().allow(null, ''),
  propertyTypeName:     Joi.string().trim().max(255).allow('', null).optional(),
  transactionTypeId:    Joi.number().integer().min(1).optional().allow(null, ''),
  transactionTypeName:  Joi.string().trim().max(255).allow('', null).optional(),
  propertyVarietyId:    Joi.number().integer().min(1).optional().allow(null, ''),
  propertyVarietyName:  Joi.string().trim().max(255).allow('', null).optional(),
  // "Location with Landmark" — MANDATORY. Free-text captured alongside the
  // District/Taluka/Village cascade; without it the row is not discoverable
  // in the list search.
  location: requiredWhenNotDraft(locField, 'Location is required.'),
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
  status: masterCodeField.default('available'),
  isDraft: Joi.boolean().default(false),
  // T-2026-040: Owner-duplicate confirmation bypass flag. Frontend sets
  // this to true after the operator confirms the "Duplicate Owner Found"
  // dialog so any (optional) backend duplicate check can be skipped on the
  // retry submit. Currently no backend duplicate check exists on this
  // route, but the flag is accepted here so any future check can honour
  // the confirmation without a schema change. The service layer uses a
  // column-listed INSERT so this key is naturally stripped before the DB.
  skipDuplicateOwnerValidation: Joi.boolean().optional(),
  // Owner Contact Name + Number — MANDATORY on every Inventory / Enquiry
  // submit. Populated on the FE by promoting the first contact card's name
  // (`details.dynamicData.contacts[0].name`) and first mobile slot
  // (`contacts[0].mobiles[0]`) into these two top-level columns before
  // submit so the DB columns match the FE input.
  ownerName: requiredWhenNotDraft(personField, 'Owner Contact Name is required.'),
  ownerContact: requiredWhenNotDraft(phoneField, 'Owner Contact Number is required.'),
  agentName: personField.optional(),
  agentContact: phoneField.optional(),
  // Open-ended bag of category-specific fields (flat floor / plot zoning /
  // hostel timing / stamp duty breakdown / etc. + lat/lng map pin). The form
  // shape is defined on the client; the server just stores it as JSON.
  // Capped at 200 keys to prevent abuse — well above what any real
  // registration form would need.
  details: Joi.object().unknown(true).max(200).optional().allow(null),
  // T-2026-138: Builder Property / Multi-Unit Inventory (Admin-only).
  // Optional flag + counter, both persisted to dedicated top-level
  // columns via migration 099 (T-2026-136).
  //   isBuilderMaster:  1 = Builder Property MASTER row (holds project
  //                     info; unit rows live in inventory_property_units).
  //                     Default 0 for every ordinary record so the T1/T2
  //                     regression bar ("normal property flow byte-identical
  //                     when toggle OFF") is trivially satisfied.
  //   totalUnitsPlanned: Admin-entered target unit count. NULL when the
  //                     master isn't a Builder Property, or when the admin
  //                     hasn't picked a target yet. Non-negative integer.
  // FE promotes these keys from `details.dynamicData.builderProperty` /
  // `details.dynamicData.totalUnitsPlanned` at submit time (see
  // src/admin/pages/Inventory/InventoryForm.jsx#promoteMandatory in the
  // same slice). Non-Flat-New-Sale forms never send the keys.
  isBuilderMaster:   Joi.boolean().optional(),
  totalUnitsPlanned: Joi.number().integer().min(0).max(100000).optional().allow(null, ''),
}).unknown(true);

const statusBody = Joi.object({
  status: masterCodeField.required(),
  // Free-text "why" the admin recorded when flipping the status. Optional so a
  // quick status flip doesn't force typing; capped at 500 chars (well over a
  // sentence or two of context).
  note: Joi.string().trim().max(500).allow('', null).optional(),
});

const suggestQuery = Joi.object({
  q: Joi.string().trim().max(255).allow('').optional(),
  limit: Joi.number().integer().min(1).max(20).default(8),
  includeDrafts: Joi.boolean().default(false),
});

// Export query: same filters as list, but pagination is optional.
const exportQuery = listQuery.fork(['page', 'pageSize'], (s) => s.optional());

// Second-pass validator for the `details.dynamicData` blob. Runs AFTER the
// top-level Joi has already accepted the request shape. We keep it as a
// separate middleware (rather than folding the schema into propertyBody)
// because the dynamicData rules are large, per-key, and need cross-field
// checks — much cleaner as a standalone function than inline Joi.
//
// Drafts skip the strict shape check so half-filled records can still be
// parked. Non-drafts get the full validation.
function validateDynamicDataMiddleware(req, res, next) {
  try {
    const body = req.body || {};
    // T-2026-112: Cross-field agreement dates check — end must be
    // >= start when BOTH are provided. Runs on drafts AND non-drafts
    // (a draft with impossible dates is a bug worth flagging early),
    // but only when both dates are actually set — a partially-filled
    // draft (only start, or neither) passes silently.
    const agrStart = typeof body.agreementStartDate === 'string' ? body.agreementStartDate.trim() : '';
    const agrEnd = typeof body.agreementEndDate === 'string' ? body.agreementEndDate.trim() : '';
    if (agrStart && agrEnd && agrEnd < agrStart) {
      return next(new HttpError(400, 'VALIDATION_ERROR', 'Validation failed.', [{
        path: 'agreementEndDate',
        message: 'Agreement End Date cannot be earlier than Agreement Start Date.',
      }]));
    }
    if (body.isDraft) return next();
    const dyn = body.details && body.details.dynamicData;
    // Product-mandatory dynamic-form field: Address lives on
    // `details.dynamicData.address` (there is no top-level column). Enforce
    // it here so the FE gets a routable per-field VALIDATION_ERROR when the
    // admin submits without it. Every other product-mandatory field is
    // enforced by the top-level Joi `propertyBody`.
    const mandatoryDynErrors = [];
    const addressVal = dyn && typeof dyn.address === 'string' ? dyn.address.trim() : '';
    if (!addressVal) {
      mandatoryDynErrors.push({
        path: 'details.dynamicData.address',
        message: 'Address is required.',
      });
    }
    if (!dyn) {
      if (mandatoryDynErrors.length > 0) {
        return next(new HttpError(400, 'VALIDATION_ERROR', 'Validation failed.', mandatoryDynErrors));
      }
      return next();
    }
    const { value, errors } = validateDynamicData(dyn);
    if (errors.length > 0 || mandatoryDynErrors.length > 0) {
      // Prefix each path so the frontend can route the message back to the
      // right field in the dynamic form (`details.dynamicData.<field>`).
      const details = [
        ...mandatoryDynErrors,
        ...errors.map((e) => ({
          path: `details.dynamicData.${e.path}`,
          message: e.message,
        })),
      ];
      return next(new HttpError(400, 'VALIDATION_ERROR', 'Validation failed.', details));
    }
    // Advanced Land Pricing recompute (2026-08-05): recompute the
    // derived-value fields on Land Sale / Purchase and SEZ Land Sale /
    // Purchase records so the DB row matches what the FE calculator
    // would produce. Idempotent on any input; no-op for other property
    // types. Runs AFTER Joi so we compute from the already-coerced
    // numeric values instead of raw strings.
    const propertyType = req.body.propertyType || req.body.property_type;
    // T-2026-107: Land Frontage Foot -> Distance auto-derivation runs
    // FIRST so any downstream pricing / analytics see the corrected
    // Distance value. Idempotent; no-op when neither field is present.
    let dynAfterFrontage = computeLandFrontage(value);
    req.body.details.dynamicData = computeLandPricing(dynAfterFrontage, propertyType);
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

// T-2026-169 Phase D: batched property-code lookup used by the CRM
// listing to resolve numeric interested_property_ids into the human-
// readable business `property_code` chip (e.g. 56 -> PUN-FLT-26-MSFTB4M).
//
// Contract:
//   POST /admin/inventory-properties/property-codes
//   Body:  { ids: [1, 2, 3, ...] }   (max 500 per request)
//   Reply: { data: { "1": { code:"PUN-FLT-26-MSFTB4M", title:"..." }, ... } }
//
// Response includes ONLY the ids that resolve to a live (non-deleted)
// property. Missing / deleted ids are OMITTED from the map so the FE
// can render an inline "Property unavailable" fallback for anything
// not present in the reply.
//
// No PII in the payload -- property_code + title are public identity
// fields that the FE already exposes on the Inventory listing to any
// admin with INVENTORY_PROPERTIES access. No pin gate on the endpoint.
// The click-through target /admin/inventory/:id continues to gate via
// useAdminActionPinGate at the FE call-site (per
// project-admin-action-pin-gate).
const propertyCodesBody = Joi.object({
  ids: Joi.array().items(Joi.number().integer().positive()).min(1).max(500).required(),
});
router.post('/property-codes', validate(propertyCodesBody), async (req, res, next) => {
  try {
    const ids = req.body.ids || [];
    // Deduplicate to save a round-trip on tiny CRM pages.
    const uniqIds = Array.from(new Set(ids.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0)));
    if (!uniqIds.length) return res.json({ data: {} });
    const placeholders = uniqIds.map(() => '?').join(',');
    const [rows] = await dbPool.query(
      `SELECT id, property_code, title
         FROM inventory_properties
        WHERE id IN (${placeholders})
          AND deleted_at IS NULL`,
      uniqIds,
    );
    const map = {};
    for (const r of rows) {
      map[String(r.id)] = {
        code:  r.property_code || null,
        title: r.title         || null,
      };
    }
    res.json({ data: map });
  } catch (err) {
    next(err);
  }
});

// IMPORTANT: export routes MUST be defined BEFORE /:id, otherwise Express
// treats `export.csv` and `export.xlsx` as :id values and the param validator
// rejects them.
// T-2026-072: export endpoints pass `req.auth` through to the service so
// the branded PDF header renders "Generated By: <admin>". Filenames follow
// the standard project convention: <Module>_<YYYY-MM-DD>.<ext>.
router.get('/export.csv', validate(exportQuery, 'query'), async (req, res, next) => {
  try {
    const csv = await management.exportCsv(applyDraftStatusFilter(req.query), { auth: req.auth });
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="Inventory_Properties_${stamp}.csv"`);
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
    res.setHeader('Content-Disposition', `attachment; filename="Inventory_Properties_${stamp}.xlsx"`);
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
    res.setHeader('Content-Disposition', `attachment; filename="Inventory_Properties_${stamp}.pdf"`);
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
      // Drafts default missing fields to safe placeholders so the row is insertable.
      price: req.body.price ?? 0,
      // Posting Date is user-supplied. DB column is nullable — pass the
      // client value through untouched (no today() backfill), so an unset
      // field lands NULL and a picked date lands exactly as chosen.
      postingDate: req.body.postingDate || null,
      // T-2026-067: no `|| 'sale'` default on transactionType and no
      // `|| ''` PT injection. Both fields are user-selected via the
      // chooser; a request that omits them must fail loudly rather
      // than silently defaulting to values the user never picked.
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
      // T-2026-067: no `|| 'sale'` default on transactionType and no
      // `|| ''` PT injection. Both fields are user-selected via the
      // chooser; a request that omits them must fail loudly rather
      // than silently defaulting to values the user never picked.
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
    res.json(await management.updateStatus(req.params.id, req.body.status, req.body.note || null, changedBy));
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

// Share the property via email. Runtime-only — nothing about the share is
// persisted; SMTP failure surfaces a specific HttpError. Owner / staff-only
// fields are stripped inside the share service (never reach the wire).
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
  // Dynamic path (preferred): frontend sends the section schema derived
  // from the form config.
  sections: Joi.array().items(shareSection).max(30).optional(),
  // Back-compat flags for older clients that pre-date the dynamic renderer.
  includeDetails:     Joi.boolean().default(true),
  includeDescription: Joi.boolean().default(true),
  includeImages:      Joi.boolean().default(true),
  includeDocuments:   Joi.boolean().default(true),
  includePropertyUrl: Joi.boolean().default(true),
});

router.post(
  '/:id/share',
  validate(idParam, 'params'),
  validate(shareBody, 'body'),
  async (req, res, next) => {
    try {
      const result = await shareProperty('inventory', Number(req.params.id), req.body);
      res.json({ message: 'Property shared successfully.', ...result });
    } catch (err) {
      next(err);
    }
  },
);

// Stream a private document. Auth + module gate already enforced by router.use.
router.get('/:id/documents/:fileId', validate(subIdParam, 'params'), async (req, res, next) => {
  try {
    const file = await management.findDocument(req.params.fileId);
    if (!file || file.property_kind !== 'inventory' || Number(file.property_id) !== Number(req.params.id) || file.file_kind !== 'document') {
      throw new HttpError(404, 'NOT_FOUND', 'Document not found');
    }
    return management.streamDocument(res, file);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
