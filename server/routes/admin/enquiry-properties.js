const express = require('express');
const Joi = require('joi');

const { validate } = require('../../middleware/validate');
const { requireAuth, requireModule } = require('../../middleware/auth');
const { imageUploadMiddleware, documentUploadMiddleware } = require('../../middleware/imageMulter');
const idempotency = require('../../middleware/idempotency');
const management = require('../../services/enquiry/management');
const { shareProperty } = require('../../services/properties/shareProperty');
// dynamicData validation is table-agnostic — reused from the inventory
// service to keep the shape rules (contact/phone/email/dualMode/etc.)
// authored in one place. Enquiry rows use the same DynamicPropertyForm
// engine on the frontend, so the payload shape is identical.
const { validateDynamicData } = require('../../services/inventory/dynamicDataValidation');
const {
  AREA_UNITS,
} = require('../../constants/property');

const masterCodeField = Joi.string().trim().lowercase().pattern(/^[a-z0-9][a-z0-9_-]{0,62}[a-z0-9]$/);
const { MODULES } = require('../../constants/modules');
const { HttpError } = require('../../middleware/errors');

const router = express.Router();

// Access control reuses INVENTORY_MANAGEMENT — a Sub Admin who can manage
// Inventory records is authorised to manage Enquiry records as well. This
// avoids silently locking existing Sub Admins out of the new surface on
// deploy. If finer-grained separation is needed later, introduce
// ENQUIRY_MANAGEMENT here and grant it to existing roles in a follow-up.
router.use(requireAuth, requireModule(MODULES.INVENTORY_MANAGEMENT));

const idParam = Joi.object({ id: Joi.number().integer().positive().required() });
const subIdParam = Joi.object({
  id: Joi.number().integer().positive().required(),
  fileId: Joi.number().integer().positive().required(),
});

// Most property/enquiry fields are optional at the API layer. Only structural
// caps (max lengths, non-negative bounds) remain — no min lengths, no format
// patterns, no `.required()` on property fields.
//
// The 7 product-mandatory fields (Property Description, Owner Contact Name,
// Owner Contact Number, District, Taluka, Village, Address) ARE enforced —
// via `requiredWhenNotDraft` below — matching the Inventory route so an
// Enquiry submit that omits any of them is rejected with a 400
// VALIDATION_ERROR. Drafts stay lenient. Website Self Registration uses a
// separate route surface and is NOT affected.
const titleField = Joi.string().trim().max(255).allow('', null);
const descField = Joi.string().trim().max(2000).allow('', null);
const locField = Joi.string().trim().max(255).allow('', null);
const propertyTypeField = Joi.string().trim().max(255).allow('', null);
const phoneField = Joi.string().trim().max(20).allow('', null);
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
  status: masterCodeField.optional(),
  location: Joi.string().trim().max(255).optional(),
  priceMin: Joi.number().min(0).optional(),
  priceMax: Joi.number().min(0).optional(),
  dateFrom: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
  isDraft: Joi.boolean().optional(),
  sort: Joi.string()
    .pattern(/^(created_at|price|location|property_type|title):(asc|desc)$/)
    .default('title:asc'),
});

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
  ownerContact: requiredWhenNotDraft(phoneField, 'Owner Contact Number is required.'),
  agentName: personField.optional(),
  agentContact: phoneField.optional(),
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
function normalizeEnquiryNature(dyn) {
  if (!dyn || typeof dyn !== 'object') return;
  if (!Object.prototype.hasOwnProperty.call(dyn, 'nature')) return;
  const raw = dyn.nature;
  const list = Array.isArray(raw)
    ? raw
    : (raw === '' || raw === null || raw === undefined ? [] : [raw]);
  const seen = new Set();
  const out = [];
  for (const v of list) {
    const s = String(v ?? '').trim();
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  dyn.nature = out;
}

function validateDynamicDataMiddleware(req, res, next) {
  try {
    const body = req.body || {};
    // Enquiry-only Nature array coercion runs for drafts too so the stored
    // shape stays consistent whether or not the record is a draft.
    if (body.details && body.details.dynamicData) {
      normalizeEnquiryNature(body.details.dynamicData);
    }
    if (body.isDraft) return next();
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
      if (mandatoryDynErrors.length > 0) {
        return next(new HttpError(400, 'VALIDATION_ERROR', 'Validation failed.', mandatoryDynErrors));
      }
      return next();
    }
    const { value, errors } = validateDynamicData(dyn);
    if (errors.length > 0 || mandatoryDynErrors.length > 0) {
      const details = [
        ...mandatoryDynErrors,
        ...errors.map((e) => ({
          path: `details.dynamicData.${e.path}`,
          message: e.message,
        })),
      ];
      return next(new HttpError(400, 'VALIDATION_ERROR', 'Validation failed.', details));
    }
    req.body.details.dynamicData = value;
    // The shared validator preserves unknown keys (stripUnknown:false) and
    // never touches `nature`, but re-assert the array shape defensively in
    // case any coercion pass reshaped it.
    normalizeEnquiryNature(req.body.details.dynamicData);
    return next();
  } catch (err) {
    return next(err);
  }
}

router.get('/', validate(listQuery, 'query'), async (req, res, next) => {
  try {
    res.json(await management.listProperties(req.query));
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
    const csv = await management.exportCsv(req.query, { auth: req.auth });
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
    const buffer = await management.exportXlsx(req.query, { auth: req.auth });
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
    const buffer = await management.exportPdf(req.query, { auth: req.auth });
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
      // Posting Date is optional on the API; the DB column is NOT NULL, so
      // backfill today's date when the client omits it.
      postingDate: req.body.postingDate || new Date().toISOString().slice(0, 10),
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
      // Same postingDate backfill as create — the DB column is NOT NULL.
      postingDate: req.body.postingDate || new Date().toISOString().slice(0, 10),
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
