const express = require('express');
const Joi = require('joi');

const { validate } = require('../../middleware/validate');
const { requireAuth, requireModule } = require('../../middleware/auth');
const { imageUploadMiddleware, documentUploadMiddleware } = require('../../middleware/imageMulter');
const idempotency = require('../../middleware/idempotency');
const management = require('../../services/inventory/management');
const { validateDynamicData } = require('../../services/inventory/dynamicDataValidation');
const {
  AREA_UNITS,
} = require('../../constants/property');

// Master codes are validated semantically in the service layer against the
// current master_* tables (which the admin can edit). The shape check below
// just ensures the value looks like a master code so we fail fast on garbage.
const masterCodeField = Joi.string().trim().lowercase().pattern(/^[a-z0-9][a-z0-9_-]{0,62}[a-z0-9]$/);
const { MODULES } = require('../../constants/modules');
const { HttpError } = require('../../middleware/errors');

const router = express.Router();

router.use(requireAuth, requireModule(MODULES.INVENTORY_MANAGEMENT));

const idParam = Joi.object({ id: Joi.number().integer().positive().required() });
const subIdParam = Joi.object({
  id: Joi.number().integer().positive().required(),
  fileId: Joi.number().integer().positive().required(),
});

// All property fields are optional at the API layer — the DB accepts partial
// payloads. Callers can send any subset of these keys; missing/empty values
// are treated as "not provided" and never rejected. Only structural sanity
// caps remain (max lengths) to prevent abuse — no min lengths, no format
// patterns, no `.required()` for property fields.
const titleField = Joi.string().trim().max(255).allow('', null);
const descField = Joi.string().trim().max(2000).allow('', null);
const locField = Joi.string().trim().max(255).allow('', null);
const propertyTypeField = Joi.string().trim().max(255).allow('', null);
const phoneField = Joi.string().trim().max(20).allow('', null);
const personField = Joi.string().trim().max(255).allow('', null);

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
  status: masterCodeField.optional(),
  location: Joi.string().trim().max(255).optional(),
  priceMin: Joi.number().min(0).optional(),
  priceMax: Joi.number().min(0).optional(),
  dateFrom: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
  isDraft: Joi.boolean().optional(),
  sort: Joi.string()
    .pattern(/^(created_at|price|location|property_type|title):(asc|desc)$/)
    .default('created_at:desc'),
});

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
  description: descField,
  registrationDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional().allow('', null),
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
  location: locField,
  district: masterCodeField.optional().allow('', null),
  taluka: masterCodeField.optional().allow('', null),
  shivar: masterCodeField.optional().allow('', null),
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
  ownerName: personField.optional(),
  ownerContact: phoneField.optional(),
  agentName: personField.optional(),
  agentContact: phoneField.optional(),
  // Open-ended bag of category-specific fields (flat floor / plot zoning /
  // hostel timing / stamp duty breakdown / etc. + lat/lng map pin). The form
  // shape is defined on the client; the server just stores it as JSON.
  // Capped at 200 keys to prevent abuse — well above what any real
  // registration form would need.
  details: Joi.object().unknown(true).max(200).optional().allow(null),
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
    if (body.isDraft) return next();
    const dyn = body.details && body.details.dynamicData;
    if (!dyn) return next();
    const { value, errors } = validateDynamicData(dyn);
    if (errors.length > 0) {
      // Prefix each path so the frontend can route the message back to the
      // right field in the dynamic form (`details.dynamicData.<field>`).
      const details = errors.map((e) => ({
        path: `details.dynamicData.${e.path}`,
        message: e.message,
      }));
      return next(new HttpError(400, 'VALIDATION_ERROR', 'Invalid request', details));
    }
    // Write the sanitized value back so the DB stores trimmed / coerced data.
    req.body.details.dynamicData = value;
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

// IMPORTANT: export routes MUST be defined BEFORE /:id, otherwise Express
// treats `export.csv` and `export.xlsx` as :id values and the param validator
// rejects them.
// T-2026-072: export endpoints pass `req.auth` through to the service so
// the branded PDF header renders "Generated By: <admin>". Filenames follow
// the standard project convention: <Module>_<YYYY-MM-DD>.<ext>.
router.get('/export.csv', validate(exportQuery, 'query'), async (req, res, next) => {
  try {
    const csv = await management.exportCsv(req.query, { auth: req.auth });
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
    const buffer = await management.exportXlsx(req.query, { auth: req.auth });
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
    const buffer = await management.exportPdf(req.query, { auth: req.auth });
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
