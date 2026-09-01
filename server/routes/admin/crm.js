/**
 * CRM admin routes (T-2026-151 Phase 1 + Phase 3 additions).
 *
 * Mounts under /api/admin/crm. All endpoints gated by requireAuth +
 * requireModule(MODULES.CRM_MANAGEMENT); the master admin CRUD for
 * crm_status flows through the existing /api/admin/masters/crm_status
 * surface via the LOOKUP_KEYS registration, not through this file.
 *
 * Endpoints:
 *   Parents:
 *     GET  /parents                     -- paginated list (masked by default)
 *     GET  /parents/:id                 -- single parent (masked)
 *     POST /parents/resolve-conflict    -- resolve a duplicate conflict
 *     GET  /parents/conflicts           -- list unresolved conflicts
 *
 *   Enquiries:
 *     GET  /enquiries                       -- paginated list (masked by default)
 *     GET  /enquiries/:id                   -- single enquiry (masked)
 *     POST /enquiries/:id/status-change     -- change status + optional calendar activity
 *     GET  /enquiries/:id/history           -- immutable status history
 *     GET  /enquiries/:id/calendar          -- calendar activities for this enquiry
 *     POST /enquiries/:id/allocation/add    -- Phase 3 -- add propertyId to interested list
 *     POST /enquiries/:id/allocation/remove -- Phase 3 -- remove propertyId from interested list
 *
 *   T-2026-155 (corrective for T-2026-151 Phase 1): the manual-add
 *   endpoint POST /enquiries has been REMOVED. CRM is a projection
 *   over two real sources -- Website Buyer Enquiries (source_type=
 *   'website') and admin NPD Enquiry Properties (source_type='npd').
 *   CRM does NOT own records; there is no admin surface to create a
 *   CRM enquiry directly with an arbitrary source_type. Ingestion
 *   flows through duplicateResolver from services/enquiry/management.js
 *   and services/website_property/management.js only.
 *
 *   Allocations:
 *     GET  /allocations/by-property         -- Phase 3 -- reverse lookup for Property View
 *
 *   Statuses:
 *     GET  /statuses                        -- active crm_status master rows (dropdown)
 *
 * PII masking (Phase 1 scaffolding + Phase 3 gate):
 *   Every list/detail/allocation response is masked by default. Pass
 *   ?unmasked=1 AND an X-Key-Pin header carrying the operator's active
 *   6-digit Security PIN to receive raw name/mobile/email. The header
 *   is re-validated on every unmask request via
 *   middleware/keyPinHeader.js requireKeyPinHeaderWhen -- the query
 *   flag alone is NEVER trusted (Phase 3 §42-§44 non-negotiable).
 */

const express = require('express');
const Joi = require('joi');
const { validate } = require('../../middleware/validate');
const { requireAuth, requireModule, requireModuleWriteOnMutation } = require('../../middleware/auth');
const { MODULES } = require('../../constants/modules');
const { HttpError } = require('../../middleware/errors');
const { requireKeyPinHeaderWhen } = require('../../middleware/keyPinHeader');

const parents = require('../../services/crm/parents');
const enquiries = require('../../services/crm/enquiries');
const statusHistory = require('../../services/crm/statusHistory');
const statuses = require('../../services/crm/statuses');
const dealPayments = require('../../services/crm/dealPayments');
const followUps = require('../../services/crm/followUps');
const duplicateResolver = require('../../services/crm/duplicateResolver');
const allocations = require('../../services/crm/allocations');
const propertyCodes = require('../../db/queries/property_codes');
const crm = require('../../db/queries/crm');
// T-2026-164: retry-sync endpoint for a single crm_calendar_activities row.
const gcalWorker = require('../../services/crm/googleCalendarSyncWorker');
// T-2026-165: appointment slot validation + edit / cancel.
const appointmentSlots = require('../../services/crm/appointmentSlots');

const router = express.Router();

// Every route requires CRM module access. Admin implicitly has it.
router.use(requireAuth, requireModule(MODULES.CRM_MANAGEMENT));
// T-2026-173 Phase 2: sub-admins with only Read access get 403 on mutation.
router.use(requireModuleWriteOnMutation(MODULES.CRM_MANAGEMENT));

function boolQ(v) {
  if (v === true) return true;
  if (v === false || v == null) return false;
  const s = String(v).toLowerCase();
  return s === '1' || s === 'true' || s === 'yes';
}

// Phase 3: shared gate for the ?unmasked=1 query. Predicate evaluates
// per-request so masked (default) callers pay zero cost. When the flag
// is truthy, the middleware requires a valid X-Key-Pin header before
// the handler runs -- the handler still branches on boolQ(unmasked)
// itself to choose the masked vs unmasked service call.
const gateUnmask = requireKeyPinHeaderWhen((req) => boolQ(req.query.unmasked));

// ------------------------------------------------------------------
// Parents
// ------------------------------------------------------------------
router.get('/parents', gateUnmask, async (req, res, next) => {
  try {
    const out = await parents.list({
      page: req.query.page,
      pageSize: req.query.pageSize,
      search: req.query.search || '',
      unmasked: boolQ(req.query.unmasked),
    });
    res.json(out);
  } catch (e) { next(e); }
});

router.get('/parents/conflicts', async (req, res, next) => {
  try {
    const rows = await crm.listConflicts({ unresolvedOnly: true });
    res.json({
      data: rows.map((r) => ({
        id: r.id,
        parent_a_id: r.parent_a_id,
        parent_a_name: r.parent_a_name,
        parent_b_id: r.parent_b_id,
        parent_b_name: r.parent_b_name,
        source_type: r.source_type,
        source_id: r.source_id,
        payload_json: (typeof r.payload_json === 'string' ? JSON.parse(r.payload_json) : r.payload_json),
        created_at: r.created_at,
      })),
    });
  } catch (e) { next(e); }
});

router.post('/parents/resolve-conflict', async (req, res, next) => {
  try {
    const out = await duplicateResolver.resolveConflict({
      conflictId: req.body.conflict_id,
      attachToParentId: req.body.attach_to_parent_id,
      adminId: req.auth?.userId || req.auth?.id || null,
    });
    res.json(out);
  } catch (e) { next(e); }
});

router.get('/parents/:id', gateUnmask, async (req, res, next) => {
  try {
    const out = await parents.getById(Number(req.params.id), {
      unmasked: boolQ(req.query.unmasked),
    });
    res.json(out);
  } catch (e) { next(e); }
});

// ------------------------------------------------------------------
// Enquiries
// ------------------------------------------------------------------
router.get('/enquiries', gateUnmask, async (req, res, next) => {
  try {
    const out = await enquiries.list({
      page: req.query.page,
      pageSize: req.query.pageSize,
      search: req.query.search || '',
      statusCode: req.query.status_code || '',
      parentId: req.query.parent_id ? Number(req.query.parent_id) : null,
      sourceType: req.query.source_type || '',
      // T-2026-169 Phase A: new-taxonomy filters (§18). Backward-compat:
      // omitting these mirrors the pre-T-169 listing behaviour byte-for-byte.
      leadStageCode:  req.query.lead_stage_code  || '',
      leadStatusCode: req.query.lead_status_code || '',
      leadRatingCode: req.query.lead_rating_code || '',
      unmasked: boolQ(req.query.unmasked),
    });
    res.json(out);
  } catch (e) { next(e); }
});

// T-2026-155: POST /enquiries (manual CRM add) removed per user spec.
// CRM is a projection over Website Buyer Enquiries + admin NPD Enquiry
// Properties -- there is no admin surface to create a CRM enquiry with
// an arbitrary source_type. Any caller hitting this path receives 404
// via the router's normal not-found handling; the FE (shared/api/crm.js)
// no longer exports a createManualEnquiry() wrapper.

router.get('/enquiries/:id', gateUnmask, async (req, res, next) => {
  try {
    const out = await enquiries.getById(Number(req.params.id), {
      unmasked: boolQ(req.query.unmasked),
    });
    res.json(out);
  } catch (e) { next(e); }
});

// T-2026-165: gate the status-change endpoint with the same optional
// PIN-unmask logic used elsewhere in CRM. When the caller passes
// ?unmasked=1 AND the X-Key-Pin header, a 409 SLOT_CONFLICT response
// carries the conflicting lead's name/mobile in the CLEAR. Absent
// unmasked, the 409 body is masked (default). The status change itself
// does NOT require the PIN -- only the PII in the conflict body.
router.post('/enquiries/:id/status-change', gateUnmask, async (req, res, next) => {
  try {
    const out = await enquiries.changeStatus(Number(req.params.id), req.body, {
      adminId: req.auth?.userId || req.auth?.id || null,
      unmasked: boolQ(req.query.unmasked),
    });
    res.json(out);
  } catch (e) {
    // Structured 409 for SLOT_CONFLICT per T-2026-165 spec §32.
    if (e && e.status === 409 && e.code === 'SLOT_CONFLICT' && e.details) {
      return res.status(409).json({
        code: 'SLOT_CONFLICT',
        message: e.message,
        conflict: e.details,
      });
    }
    next(e);
  }
});

router.get('/enquiries/:id/history', async (req, res, next) => {
  try {
    const rows = await statusHistory.listForEnquiry(Number(req.params.id));
    res.json({ data: rows });
  } catch (e) { next(e); }
});

router.get('/enquiries/:id/calendar', async (req, res, next) => {
  try {
    const rows = await statusHistory.listCalendarForEnquiry(Number(req.params.id));
    res.json({ data: rows });
  } catch (e) { next(e); }
});

// ------------------------------------------------------------------
// Allocations (T-2026-151 Phase 3)
// ------------------------------------------------------------------
// Storage lives on crm_enquiries.interested_property_ids (JSON array).
// See services/crm/allocations.js for the transactional add/remove +
// reverse-lookup implementations. Both mutations are idempotent so
// the FE Phase 3 diff-and-sync flow can retry safely.

router.post('/enquiries/:id/allocation/add', async (req, res, next) => {
  try {
    const out = await allocations.addToEnquiry({
      enquiryId:  Number(req.params.id),
      propertyId: req.body.property_id,
    });
    res.json(out);
  } catch (e) { next(e); }
});

router.post('/enquiries/:id/allocation/remove', async (req, res, next) => {
  try {
    const out = await allocations.removeFromEnquiry({
      enquiryId:  Number(req.params.id),
      propertyId: req.body.property_id,
    });
    res.json(out);
  } catch (e) { next(e); }
});

// Reverse lookup for the Property View "Allocated Enquiries" section
// (§41-§44). Masked by default; ?unmasked=1 requires a valid X-Key-Pin
// header (gateUnmask middleware). The FE calls this endpoint twice: once
// masked on mount, once unmasked after the operator enters the PIN in the
// reveal modal (the header lives only in the individual request, never
// persisted).
router.get('/allocations/by-property', gateUnmask, async (req, res, next) => {
  try {
    const rows = await allocations.listByProperty({
      // Carries a property CODE now, not a row id. The query-param name is
      // kept for wire compatibility with the existing FE clients.
      propertyId: req.query.property_id,
      unmasked:   boolQ(req.query.unmasked),
    });
    res.json({ data: rows });
  } catch (e) { next(e); }
});

// ------------------------------------------------------------------
// Property-code resolver
// ------------------------------------------------------------------
//
// Batch-resolve the property CODES stored in
// crm_enquiries.interested_property_ids into displayable, click-through-able
// properties.
//
//   POST /admin/crm/property-codes/resolve
//   Body:  { codes: ["AKL-BNG-26-0XCQYR5", ...] }   (max 500)
//   Reply: { data: { "AKL-BNG-26-0XCQYR5": {
//              code, source: 'inventory'|'enquiry'|'website',
//              id, title, property_type, location, deleted } } }
//
// `source` + `id` is what lets a CRM chip open the RIGHT page:
//   inventory -> /admin/inventory/:id
//   enquiry   -> /admin/enquiry/:id
//   website   -> /admin/website-properties/:id
// The three detail routes stay numeric-id based; resolving here means none of
// them (nor their Joi id validators) had to change.
//
// This REPLACES the id->code direction of
// POST /admin/inventory-properties/property-codes, which could only ever
// answer for inventory and so could never tell the FE which surface owns a
// code.
//
// Codes that resolve nowhere are OMITTED from the map, so the caller can tell
// "unknown code" from "known but deleted" (the latter comes back with
// deleted: true, which is the whole benefit of storing codes -- a deleted
// property can still be named).
//
// NO PIN GATE: property_code / title are the same identity fields the
// Inventory and Website listings already show to any admin with access. The
// click-through target is PIN-gated at the FE call site, matching the
// convention the old endpoint documented.
const resolveCodesBody = Joi.object({
  // Joi.string() deliberately, with NO pattern. Audited all 95 live codes:
  // lengths are 16/17/18 because district and property-type segments vary in
  // width, so a DDD-TTT-YY-RANDOM7 regex would reject most real data.
  codes: Joi.array().items(Joi.string().trim().max(64)).min(1).max(500).required(),
});
router.post('/property-codes/resolve', validate(resolveCodesBody), async (req, res, next) => {
  try {
    const data = await propertyCodes.resolvePropertyCodes(req.body.codes || []);
    res.json({ data });
  } catch (e) { next(e); }
});

// ------------------------------------------------------------------
// Statuses (master reader for the dropdown)
// ------------------------------------------------------------------
router.get('/statuses', async (req, res, next) => {
  try {
    const rows = await statuses.listActive();
    res.json({ data: rows });
  } catch (e) { next(e); }
});

// ------------------------------------------------------------------
// T-2026-169 Phase A: CRM Lead Taxonomy master readers
// ------------------------------------------------------------------
// The FE Change Lead modal + Listing chips fetch these three
// vocabularies live per project convention (§14: FE loads masters from
// BE, never hardcoded). Each endpoint returns { data: [{code,label,...}] }
// sorted by sort_order then label.
// The three vocabularies are INDEPENDENT: none of these endpoints filters by
// another field, so any active Stage / Status / Rating can be combined freely.
//
// ?keep=<code> re-admits one deactivated value — the one the lead being edited
// currently holds — so an existing lead keeps showing its saved value instead
// of opening on a blank dropdown. See statuses.js for why.
router.get('/lead-stages', async (req, res, next) => {
  try {
    const rows = await statuses.listActiveLeadStages(req.query.keep || '');
    res.json({ data: rows });
  } catch (e) { next(e); }
});

router.get('/lead-status', async (req, res, next) => {
  try {
    const rows = await statuses.listActiveLeadStatus(req.query.keep || '');
    res.json({ data: rows });
  } catch (e) { next(e); }
});

router.get('/lead-rating', async (req, res, next) => {
  try {
    const rows = await statuses.listActiveLeadRating(req.query.keep || '');
    res.json({ data: rows });
  } catch (e) { next(e); }
});

// ------------------------------------------------------------------
// CRM Follow-ups — read-only listing across every lead
// ------------------------------------------------------------------
// Backs the Reminders -> CRM Follow-ups Reminder page. It only SELECTs from
// crm_calendar_activities: the follow-up, its Google Calendar event and its two
// reminder emails are all created by the existing scheduling flow, and this
// endpoint must never produce a second one.
//
// gateUnmask, exactly as the enquiries list uses it: real names and mobiles
// require ?unmasked=true plus the Key PIN header, and the default response is
// masked.
router.get('/follow-ups', gateUnmask, async (req, res, next) => {
  try {
    const result = await followUps.list({
      search:     req.query.search || '',
      dateFrom:   req.query.dateFrom || '',
      dateTo:     req.query.dateTo || '',
      leadStage:  req.query.leadStage || '',
      leadStatus: req.query.leadStatus || '',
      leadRating: req.query.leadRating || '',
      status:     req.query.status || '',
      page:       req.query.page,
      pageSize:   req.query.pageSize,
      unmasked:   boolQ(req.query.unmasked),
    });
    res.json(result);
  } catch (e) { next(e); }
});

// ------------------------------------------------------------------
// Deal / Payment Details (migration 129)
// ------------------------------------------------------------------
// Only meaningful for a lead on the "Converted to Deal" stage, but the GET is
// deliberately not gated on the stage: the Edit Lead modal opens the section as
// soon as the operator PICKS Deal, before anything is saved, and must be able
// to load the existing figures at that moment. Hiding the section for other
// stages is a display rule (§14 keeps the data), not an access rule.
router.get('/enquiries/:id/deal-payment', async (req, res, next) => {
  try {
    res.json({ data: await dealPayments.getForLead(req.params.id) });
  } catch (e) { next(e); }
});

const installmentSchema = Joi.object({
  // A blank row the operator has not filled in yet is legal on the way in and
  // is stored as zero; the service is what rejects negatives and non-numbers.
  amount:      Joi.alternatives(Joi.number(), Joi.string().allow('')).optional(),
  // true once the operator has confirmed the row with "Calculate Amount";
  // only then does it count toward Total Amount Paid.
  isCalculated: Joi.boolean().optional(),
  paymentDate: Joi.string().allow('', null).optional(),
  remarks:     Joi.string().allow('', null).max(500).optional(),
});

const dealPaymentSchema = Joi.object({
  propertyCode:   Joi.string().max(64).allow('').optional(),
  advanceAmount:  Joi.alternatives(Joi.number(), Joi.string().allow('')).optional(),
  installments:   Joi.array().items(installmentSchema).max(50).optional(),
});

// The 50-item cap above is a payload guard, not the business rule: the real
// ceiling of 10 lives in the service so it is enforced identically for any
// caller, and a 12-item payload gets the business message rather than a schema
// error that does not explain itself.
// No per-route write gate: router.use(requireModuleWriteOnMutation(...)) above
// already covers every mutation verb on this router, and auth.js states that is
// deliberately router-level so a new endpoint is gated by default. Repeating it
// here would just run the same check twice.
router.put('/enquiries/:id/deal-payment',
  validate(dealPaymentSchema),
  async (req, res, next) => {
    try {
      res.json({ data: await dealPayments.saveForLead(req.params.id, req.body) });
    } catch (e) { next(e); }
  });

// ------------------------------------------------------------------
// Calendar activity retry-sync (T-2026-164)
// ------------------------------------------------------------------
// Manually retry pushing a single PENDING / FAILED crm_calendar_
// activities row to Google Calendar. Called from the
// CalendarActivityPanel "Retry" button. Returns { id, sync_status,
// google_event_id, reason } -- shape mirrors what the worker persists.
router.post('/calendar-activities/:id/retry-sync', async (req, res, next) => {
  try {
    const out = await gcalWorker.retryOne(Number(req.params.id));
    res.json(out);
  } catch (e) { next(e); }
});

// ------------------------------------------------------------------
// T-2026-165: Follow-up appointment slot validation + edit / cancel
// ------------------------------------------------------------------
// Structured 409 body on SLOT_CONFLICT:
//   { code:'SLOT_CONFLICT', message, conflict: {
//       source: 'crm' | 'google_calendar',
//       appointment?: { appointment_id, crm_enquiry_id, enquiry_code,
//                       name, mobile, property_ids, current_status_code,
//                       scheduled_at }        (name/mobile MASKED unless
//                                              caller passed X-Key-Pin
//                                              via unmasked=1),
//       google_busy?: { note, window },
//       next_available_slot: 'HH:MM' | null,
//   } }
function handleAppointmentError(e, res, next) {
  if (e && e.status === 409 && e.code === 'SLOT_CONFLICT' && e.details) {
    return res.status(409).json({
      code: 'SLOT_CONFLICT',
      message: e.message,
      conflict: e.details,
    });
  }
  if (e && e.status === 409 && e.code === 'ALREADY_CANCELLED') {
    return res.status(409).json({ code: 'ALREADY_CANCELLED', message: e.message });
  }
  next(e);
}

// GET /admin/crm/appointments/slots?date=YYYY-MM-DD
// Returns the whole 15-min availability grid for the given IST date.
// Considers both CRM active appointments and Google Calendar busy
// blocks. Fail-open on Google (returns availability from CRM only if
// GCal errors -- the FE never sees the failure).
router.get('/appointments/slots', async (req, res, next) => {
  try {
    const grid = await appointmentSlots.listAvailableSlots({
      date: String(req.query.date || ''),
    });
    res.json({ data: grid });
  } catch (e) { next(e); }
});

// POST /admin/crm/enquiries/:id/appointment
// Body: { scheduled_date, scheduled_time, context_note, detailed_note,
//         status_history_id? }
// Creates a new follow-up appointment (independent of a status change).
// The status-change endpoint /enquiries/:id/status-change internally
// delegates to the same appointmentSlots.createAppointment when
// scheduled_at is supplied, so both paths share the concurrency guard.
router.post('/enquiries/:id/appointment', gateUnmask, async (req, res, next) => {
  try {
    const out = await appointmentSlots.createAppointment({
      enquiryId:       Number(req.params.id),
      scheduledDate:   req.body.scheduled_date,
      scheduledTime:   req.body.scheduled_time,
      scheduledAt:     req.body.scheduled_at,  // alternate ISO shape
      contextNote:     req.body.context_note || null,
      detailedNote:    req.body.detailed_note || null,
      statusHistoryId: req.body.status_history_id || null,
      adminId:         req.auth?.userId || req.auth?.id || null,
      unmasked:        boolQ(req.query.unmasked),
    });
    res.json(out);
  } catch (e) { handleAppointmentError(e, res, next); }
});

// PATCH /admin/crm/appointments/:id
router.patch('/appointments/:id', gateUnmask, async (req, res, next) => {
  try {
    const out = await appointmentSlots.updateAppointment({
      appointmentId:  Number(req.params.id),
      scheduledDate:  req.body.scheduled_date,
      scheduledTime:  req.body.scheduled_time,
      contextNote:    req.body.context_note,
      detailedNote:   req.body.detailed_note,
      adminId:        req.auth?.userId || req.auth?.id || null,
      unmasked:       boolQ(req.query.unmasked),
    });
    res.json(out);
  } catch (e) { handleAppointmentError(e, res, next); }
});

// POST /admin/crm/appointments/:id/cancel
router.post('/appointments/:id/cancel', async (req, res, next) => {
  try {
    const out = await appointmentSlots.cancelAppointment({
      appointmentId: Number(req.params.id),
      adminId:       req.auth?.userId || req.auth?.id || null,
      actionNote:    req.body ? (req.body.action_note || null) : null,
    });
    res.json(out);
  } catch (e) { handleAppointmentError(e, res, next); }
});

// GET /admin/crm/appointments/:id/history
router.get('/appointments/:id/history', async (req, res, next) => {
  try {
    const rows = await appointmentSlots.listAppointmentHistory(Number(req.params.id));
    res.json({ data: rows });
  } catch (e) { next(e); }
});

module.exports = router;
