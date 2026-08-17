/**
 * T-2026-165: CRM follow-up appointment slot validation + create / edit /
 * cancel service. Extends the T-2026-151 changeStatus flow.
 *
 * Guarantees (per spec §29, §32, §34):
 *   1. 15-minute slot enforcement -- scheduled_at is floored to the
 *      nearest 15-min bucket; two active appointments cannot share the
 *      same bucket.
 *   2. Concurrency-safe -- transaction locks the enquiry row + performs
 *      an in-tx SELECT-for-slot before INSERT; UNIQUE(active_slot_key)
 *      DB constraint catches races that slip past the app check.
 *   3. Google Calendar external conflict -- freebusy query against the
 *      connected calendar; if Google reports the slot busy, we 409
 *      (without leaking the external event's title).
 *   4. PII masking on 409 -- lead name/mobile/email in the conflict
 *      body are masked unless the caller provided a valid X-Key-Pin
 *      header (opts.unmasked).
 *   5. Edit updates the SAME google_event_id (not a new event).
 *   6. Cancel calls events.delete on GCal (idempotent 404/410).
 *   7. Email fires ONLY after both CRM commit + GCal success (best-
 *      effort; failure does not roll back the booking).
 */

const { HttpError } = require('../../middleware/errors');
const { pool } = require('../../db/pool');
const crm = require('../../db/queries/crm');
const appts = require('../../db/queries/appointments');
const googleCalendar = require('./googleCalendar');
const appointmentEmail = require('./appointmentEmail');
const { google } = require('googleapis');
const parents = require('./parents');

const DEFAULT_TIMEZONE = 'Asia/Kolkata';
const DEFAULT_DURATION_MINUTES = 30;
const REMINDER_MINUTES_A = 1440;
const REMINDER_MINUTES_B = 60;

// Slot grid window: 06:00 through 23:45 IST.
//
// Semantics:
//   * SLOT_HOUR_START = 06 -> first slot on the selected date is 06:00.
//   * SLOT_HOUR_END   = 24 -> the loop generates 06:00 through 23:45,
//                             (24-06)*4 = 72 slots at a 15-min stride.
//
// The synthetic "midnight boundary" slot at 00:00 that T-2026-169 Phase C
// (spec §6) appended after 23:45 has been REMOVED -- the day now ends at
// 11:45 PM in both the add and the edit picker. It was never actually
// bookable on today's date (listAvailableSlots hard-coded it to
// conflict_source='past'), and on a future date its slot_key YYYYMMDD0000
// pointed at the START of the picked day while the UI rendered it at the
// END, which is contradictory. Dropping it removes that ambiguity.
const SLOT_HOUR_START = 6;
const SLOT_HOUR_END = 24;

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

function pad2(n) { return String(n).padStart(2, '0'); }

// T-2026-176: IST "now" primitives -- used to (a) filter past slots from
// the availability grid on today's date, and (b) reject past-slot writes
// from create / update. All comparisons happen in IST wall-clock string
// space (YYYYMMDDHHMM) so we never rely on the server's local TZ.
const IST_OFFSET_MS = (5 * 60 + 30) * 60_000;

/**
 * Returns { todayIso, nowHhmm, nowSlotKey } computed in Asia/Kolkata.
 *   todayIso   'YYYY-MM-DD' IST today
 *   nowHhmm    'HH:MM' current wall-clock, floored to 15-min bucket
 *   nowSlotKey 'YYYYMMDDHHMM' of the current 15-min bucket
 * Callers use these to (a) mark past slots on today's grid as
 * unavailable, and (b) reject writes whose target slot_key < nowSlotKey.
 */
function computeIstNowFloor() {
  const now = new Date();
  const istWallMs = now.getTime() + IST_OFFSET_MS;
  const d = new Date(istWallMs);
  const y = d.getUTCFullYear();
  const mo = d.getUTCMonth();
  const da = d.getUTCDate();
  const h = d.getUTCHours();
  const m = Math.floor(d.getUTCMinutes() / 15) * 15;
  const yyyy = String(y).padStart(4, '0');
  const mm = pad2(mo + 1);
  const dd = pad2(da);
  const hh = pad2(h);
  const mi = pad2(m);
  return {
    todayIso: `${yyyy}-${mm}-${dd}`,
    nowHhmm: `${hh}:${mi}`,
    nowSlotKey: `${yyyy}${mm}${dd}${hh}${mi}`,
  };
}

/**
 * True when the given slotKey (YYYYMMDDHHMM) is in the past relative to
 * the current IST 15-min bucket. Uses lexicographic comparison (safe
 * because the key is zero-padded fixed-width digits).
 *
 * Spec §4 (T-2026-176): a slot whose START time has already elapsed is
 * past. Example: at 13:10 IST (nowFloor=13:00), slot 13:00 IS past (its
 * start-of-bucket already elapsed 10 min ago); slot 13:15 is future.
 * So the comparison is `slotKey <= nowSlotKey` -- the current bucket
 * itself is disabled.
 */
function isSlotKeyInPastIst(slotKey) {
  if (!slotKey || slotKey.length !== 12) return false;
  const { nowSlotKey } = computeIstNowFloor();
  return slotKey <= nowSlotKey;
}

/**
 * Build the whole 15-min grid for a date. Returns array of { slot_start:
 * 'HH:MM' }.
 *
 * The loop iterates HOURS 06..23 inclusive -> 72 slots, 06:00 .. 23:45.
 * No midnight-boundary slot is appended; see the SLOT_HOUR_* comment
 * above for why the old synthetic '00:00' tail slot was dropped.
 */
function buildDayGrid() {
  const out = [];
  for (let h = SLOT_HOUR_START; h < SLOT_HOUR_END; h++) {
    for (let m = 0; m < 60; m += 15) {
      out.push({ slot_start: `${pad2(h)}:${pad2(m)}` });
    }
  }
  return out;
}

/**
 * Mask a mobile number the same way parents.js does (see T-2026-151
 * Phase 3): keep the last 4 digits, replace the rest with X.
 */
function maskMobile(raw) {
  if (!raw) return '';
  const digits = String(raw).replace(/\D+/g, '');
  if (digits.length < 4) return 'XXXX';
  return 'X'.repeat(digits.length - 4) + digits.slice(-4);
}

function maskName(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  if (s.length <= 2) return `${s.charAt(0)}*`;
  return `${s.slice(0, 2)}${'*'.repeat(Math.max(2, s.length - 2))}`;
}

function maskEmail(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  const at = s.indexOf('@');
  if (at < 1) return '****';
  const local = s.slice(0, at);
  const domain = s.slice(at);
  const shown = local.slice(0, Math.min(2, local.length));
  return `${shown}${'*'.repeat(Math.max(2, local.length - shown.length))}${domain}`;
}

/**
 * Look up the live lead identity (name / mobile / email / property_ids)
 * for an enquiry, using the JSON-first COALESCE query that CrmList uses.
 * Returns null when the enquiry is not found.
 */
async function resolveLeadIdentity(enquiryId) {
  const row = await crm.findEnquiryByIdForDisplay(enquiryId);
  if (!row) return null;
  let name = '';
  let mobile = '';
  let email = '';
  if (row.source_type === 'website') {
    name = row.live_website_name || '';
    mobile = row.live_website_mobile || '';
    email = row.live_website_email || '';
  } else if (row.source_type === 'npd') {
    name = row.live_npd_owner_name || '';
    mobile = row.live_npd_owner_contact || '';
    email = row.live_npd_owner_email || '';
  }
  let propertyIds = [];
  const rawIds = row.interested_property_ids;
  if (Array.isArray(rawIds)) propertyIds = rawIds;
  else if (typeof rawIds === 'string') {
    try { propertyIds = JSON.parse(rawIds) || []; } catch (_) { propertyIds = []; }
  }
  return {
    enquiry_id: row.id,
    enquiry_code: row.enquiry_code,
    source_type: row.source_type,
    source_id: row.source_id,
    name,
    mobile,
    email,
    property_ids: propertyIds,
    current_status_code: row.status_code,
  };
}

/**
 * Query Google Calendar freebusy for a given IST wall-clock slot.
 * Returns { busy: bool, window?: {start, end} }. Skips gracefully
 * (returns { busy: false }) when Google isn't connected or the API
 * call fails -- we prefer to let the CRM booking proceed rather than
 * block on a flaky external service.
 */
async function checkGoogleCalendarBusy(scheduledAtIst, durationMinutes) {
  try {
    const auth = await googleCalendar.getAuthorisedClient();
    if (!auth) return { busy: false, reason: 'NOT_CONNECTED' };
    const calendar = google.calendar({ version: 'v3', auth });
    const startMs = scheduledAtIst.getTime();
    const endMs = startMs + (durationMinutes || DEFAULT_DURATION_MINUTES) * 60_000;
    // freebusy.query expects UTC ISO. Convert IST wall-clock -> UTC by
    // subtracting 5h30 from the "IST-as-if-UTC" Date.
    const IST_OFFSET_MS = (5 * 60 + 30) * 60_000;
    const startUtcIso = new Date(startMs - IST_OFFSET_MS).toISOString();
    const endUtcIso = new Date(endMs - IST_OFFSET_MS).toISOString();
    const res = await calendar.freebusy.query({
      requestBody: {
        timeMin: startUtcIso,
        timeMax: endUtcIso,
        timeZone: DEFAULT_TIMEZONE,
        items: [{ id: googleCalendar.calendarId() }],
      },
    });
    const cal = res && res.data && res.data.calendars && res.data.calendars[googleCalendar.calendarId()];
    const busy = (cal && Array.isArray(cal.busy) && cal.busy.length) ? cal.busy[0] : null;
    if (!busy) return { busy: false };
    return { busy: true, window: { start: busy.start, end: busy.end } };
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[appointmentSlots] gcal freebusy failed (fail-open):', (e && e.message) || 'unknown');
    return { busy: false, reason: 'GCAL_FREEBUSY_FAILED' };
  }
}

/**
 * Fetch busy blocks from Google Calendar for a whole IST calendar day.
 * Returns array of { start_iso, end_iso } in UTC. Used by
 * listAvailableSlots to gray out slots that overlap an external event.
 * Fail-open on any error.
 */
async function listGoogleBusyForDate(dateStr) {
  try {
    const auth = await googleCalendar.getAuthorisedClient();
    if (!auth) return { busy: [], reason: 'NOT_CONNECTED' };
    const calendar = google.calendar({ version: 'v3', auth });
    // Day boundaries in IST -> UTC.
    const IST_OFFSET_MS = (5 * 60 + 30) * 60_000;
    const [y, mo, da] = dateStr.split('-').map(Number);
    const dayStartIstMs = Date.UTC(y, mo - 1, da, 0, 0, 0);   // IST wall-clock 00:00
    const dayEndIstMs = Date.UTC(y, mo - 1, da, 23, 59, 59);
    const startUtcIso = new Date(dayStartIstMs - IST_OFFSET_MS).toISOString();
    const endUtcIso = new Date(dayEndIstMs - IST_OFFSET_MS).toISOString();
    const res = await calendar.freebusy.query({
      requestBody: {
        timeMin: startUtcIso,
        timeMax: endUtcIso,
        timeZone: DEFAULT_TIMEZONE,
        items: [{ id: googleCalendar.calendarId() }],
      },
    });
    const cal = res && res.data && res.data.calendars && res.data.calendars[googleCalendar.calendarId()];
    const busy = (cal && Array.isArray(cal.busy)) ? cal.busy : [];
    return { busy: busy.map((b) => ({ start_iso: b.start, end_iso: b.end })) };
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[appointmentSlots] gcal freebusy day failed (fail-open):', (e && e.message) || 'unknown');
    return { busy: [], reason: 'GCAL_FREEBUSY_FAILED' };
  }
}

/**
 * Given a HH:MM slot and a list of Google busy windows (UTC ISO), decide
 * if the slot overlaps any of them. Slot duration defaults to 30 mins.
 */
function slotOverlapsBusy(dateStr, hhmm, busyList, durationMinutes = DEFAULT_DURATION_MINUTES) {
  if (!busyList || !busyList.length) return false;
  const IST_OFFSET_MS = (5 * 60 + 30) * 60_000;
  const [y, mo, da] = dateStr.split('-').map(Number);
  const [h, m] = hhmm.split(':').map(Number);
  const slotStartUtcMs = Date.UTC(y, mo - 1, da, h, m, 0) - IST_OFFSET_MS;
  const slotEndUtcMs = slotStartUtcMs + durationMinutes * 60_000;
  return busyList.some((b) => {
    const bStart = new Date(b.start_iso).getTime();
    const bEnd = new Date(b.end_iso).getTime();
    return slotStartUtcMs < bEnd && slotEndUtcMs > bStart;
  });
}

/**
 * Build an enriched booking DTO for the hover tooltip on a booked slot.
 * T-2026-169 Phase C (spec §7): tooltip surfaces every field the operator
 * needs to identify who owns the slot -- enquiry code, masked lead
 * name/mobile, the three-field lead taxonomy (Stage/Status/Rating), the
 * property IDs + resolved property_code + title, context/detailed notes,
 * booking source. Every field is included even when empty so the FE can
 * decide which to render (the FE contract is "only render fields with
 * data").
 *
 * PII rule mirrors the 409 conflict payload: name + mobile are MASKED by
 * default. The list-slots endpoint runs under gateUnmask (no unmasked=1
 * query flag today) so this always returns masked -- future work can
 * plumb an unmasked flag through the route.
 */
async function buildBookedSlotDto(row) {
  if (!row) return null;
  // row already carries enquiry_code / source_type / source_id via the
  // JOIN in listActiveAppointmentsOnDate. Look up live identity + lead
  // taxonomy for the tooltip via findEnquiryByIdForDisplay (same JOIN
  // topology as the CRM listing).
  const enq = await crm.findEnquiryByIdForDisplay(row.enquiry_id);
  let name = '';
  let mobile = '';
  let propertyIds = [];
  let sourcePropertyCode = null;
  let sourcePropertyTitle = null;
  let leadStage = null;
  let leadStatus = null;
  let leadRating = null;
  let legacyStatus = null;
  if (enq) {
    if (enq.source_type === 'website') {
      name   = enq.live_website_name   || '';
      mobile = enq.live_website_mobile || '';
      sourcePropertyCode  = enq.live_website_property_code || null;
      sourcePropertyTitle = null;
    } else if (enq.source_type === 'npd') {
      name   = enq.live_npd_owner_name    || '';
      mobile = enq.live_npd_owner_contact || '';
      sourcePropertyCode  = enq.live_npd_property_code  || null;
      sourcePropertyTitle = enq.live_npd_property_title || null;
    }
    // interested_property_ids may be a JSON string or already-parsed array
    const raw = enq.interested_property_ids;
    if (Array.isArray(raw)) propertyIds = raw;
    else if (typeof raw === 'string') {
      try { propertyIds = JSON.parse(raw) || []; } catch (_e) { propertyIds = []; }
    }
    leadStage    = enq.lead_stage_code   || null;
    leadStatus   = enq.lead_status_code  || null;
    leadRating   = enq.lead_rating_code  || null;
    legacyStatus = enq.status_code       || null;
  }
  return {
    appointment_id:   row.id,
    enquiry_id:       row.enquiry_id,
    enquiry_code:     row.enquiry_code,
    source_type:      row.source_type || null,
    // Masked identity per PII contract.
    lead_name:        maskName(name),
    lead_mobile:      maskMobile(mobile),
    // Lead taxonomy trio (Phase A/B additive columns).
    lead_stage_code:  leadStage,
    lead_status_code: leadStatus,
    lead_rating_code: leadRating,
    // Legacy status kept for callers/consumers that still surface it.
    status_code:      legacyStatus,
    // Property linkage. sourceCode is the enquiry_property/website_property
    // code (single). property_ids is the interested_property_ids array on
    // the enquiry (0..N). Both are surfaced so the FE can render whichever
    // is more informative.
    source_property_code:  sourcePropertyCode,
    source_property_title: sourcePropertyTitle,
    property_ids:     propertyIds,
    // Booking body.
    scheduled_at:     row.scheduled_at || null,
    context_note:     row.context_note || null,
    detailed_note:    row.detailed_note || null,
    booking_source:   'crm',
    reminder_minutes_before_a: row.reminder_minutes_before_a || null,
    reminder_minutes_before_b: row.reminder_minutes_before_b || null,
    sync_status:      row.sync_status || null,
    google_event_id:  row.google_event_id || null,
  };
}

/**
 * List the whole 15-min availability grid for a given IST date.
 * Cross-checks CRM active appointments + Google Calendar busy blocks.
 *
 * T-2026-169 Phase C: each row now carries an optional `booking` field
 * with the enriched appointment DTO (per buildBookedSlotDto above) for
 * CRM-booked slots. The FE hover tooltip renders any non-empty fields.
 */
async function listAvailableSlots({ date /* YYYY-MM-DD */ }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'date must be YYYY-MM-DD');
  }
  const grid = buildDayGrid();
  const [crmRows, gcalResult] = await Promise.all([
    appts.listActiveAppointmentsOnDate(date),
    listGoogleBusyForDate(date),
  ]);
  // Bucket CRM rows by HH:MM. Store the raw row so we can build the
  // tooltip DTO for the slot it occupies.
  const crmBusyByHhmm = new Map();
  for (const r of crmRows) {
    const key = r.active_slot_key;
    if (!key || key.length !== 12) continue;
    const h = key.slice(8, 10);
    const m = key.slice(10, 12);
    crmBusyByHhmm.set(`${h}:${m}`, r);
  }
  // Build tooltip DTOs in parallel for all CRM-booked slots (usually <= 72
  // slots, most days have <5 bookings -> effectively a handful of look-ups).
  const bookingDtos = new Map();
  await Promise.all(
    Array.from(crmBusyByHhmm.entries()).map(async ([hhmm, row]) => {
      try {
        const dto = await buildBookedSlotDto(row);
        if (dto) bookingDtos.set(hhmm, dto);
      } catch (_e) {
        // Fail-open per slot: leave the tooltip empty rather than 500 the
        // whole grid because one row's identity lookup blew up.
      }
    }),
  );
  // T-2026-176: filter out past slots for today's date. Precedence when
  // multiple conflict sources apply: PAST > CRM > GCAL. Rationale: a slot
  // in the past cannot be booked regardless of who else "owns" it, so
  // marking it as 'past' is the most operator-actionable label. On future
  // dates the past filter is a no-op (istNow.todayIso < date).
  const istNow = computeIstNowFloor();
  return grid.map((s) => {
    // Compute this slot's key for a lexicographic past-check.
    const [y, mo, da] = date.split('-').map(Number);
    const [h, m] = s.slot_start.split(':').map(Number);
    const slotKey = `${String(y).padStart(4,'0')}${pad2(mo)}${pad2(da)}${pad2(h)}${pad2(m)}`;
    const isPast = (
      date === istNow.todayIso && slotKey <= istNow.nowSlotKey
    ) || date < istNow.todayIso;
    const inCrmRow = crmBusyByHhmm.get(s.slot_start) || null;
    const inCrm = Boolean(inCrmRow);
    const inGcal = slotOverlapsBusy(date, s.slot_start, gcalResult.busy);
    let conflictSource = null;
    if (isPast) conflictSource = 'past';
    else if (inCrm) conflictSource = 'crm';
    else if (inGcal) conflictSource = 'google_calendar';
    const out = {
      slot_start: s.slot_start,
      available: !isPast && !inCrm && !inGcal,
      conflict_source: conflictSource,
    };
    // Only attach booking tooltip when the source is genuinely CRM
    // (past slots suppress the tooltip -- FE also gates this).
    if (inCrm && !isPast) {
      out.booking = bookingDtos.get(s.slot_start) || null;
    }
    return out;
  });
}

/**
 * Compute the next available HH:MM slot on the same date, starting AFTER
 * the given hh:mm. Returns null if the day is exhausted (i.e. nothing
 * free between the cursor and 23:45).
 *
 * Searches by ARRAY POSITION relative to the cursor's index rather than
 * by string comparison. With the grid now strictly chronological the two
 * are equivalent, but index-based scanning keeps this correct if the grid
 * ever gains non-monotonic entries again.
 */
async function findNextAvailableSlot(dateStr, hh, mm) {
  const grid = await listAvailableSlots({ date: dateStr });
  const cursor = `${pad2(hh)}:${pad2(mm)}`;
  const cursorIdx = grid.findIndex((g) => g.slot_start === cursor);
  const startFrom = cursorIdx >= 0 ? cursorIdx + 1 : 0;
  for (let i = startFrom; i < grid.length; i += 1) {
    if (grid[i].available) return grid[i].slot_start;
  }
  return null;
}

/**
 * Build a masked conflict payload for the 409 response. Applies the same
 * PII rule as the rest of the CRM: masked by default, raw only when
 * unmasked=true (which means the caller already passed the X-Key-Pin
 * header and the middleware validated it).
 */
async function buildConflictPayload(existing, source, opts) {
  const unmasked = !!(opts && opts.unmasked);
  const scheduledDateStr = existing.slot_key ? existing.slot_key.slice(0, 8) : null;
  const scheduledHhmm = existing.slot_key ? `${existing.slot_key.slice(8, 10)}:${existing.slot_key.slice(10, 12)}` : null;
  let nextAvailable = null;
  if (scheduledDateStr && scheduledHhmm) {
    const dateFmt = `${scheduledDateStr.slice(0, 4)}-${scheduledDateStr.slice(4, 6)}-${scheduledDateStr.slice(6, 8)}`;
    nextAvailable = await findNextAvailableSlot(dateFmt, Number(scheduledHhmm.slice(0, 2)), Number(scheduledHhmm.slice(3, 5)));
  }
  const conflict = {
    source,
    next_available_slot: nextAvailable, // 'HH:MM' or null
  };
  if (source === 'crm') {
    const name = unmasked ? existing.lead_name : maskName(existing.lead_name || '');
    const mobile = unmasked ? existing.lead_mobile : maskMobile(existing.lead_mobile || '');
    conflict.appointment = {
      appointment_id: existing.appointment_id,
      crm_enquiry_id: existing.crm_enquiry_id,
      enquiry_code: existing.enquiry_code,
      name,
      mobile,
      property_ids: existing.property_ids || [],
      current_status_code: existing.current_status_code || null,
      scheduled_at: existing.scheduled_at_wallclock || null,
    };
  } else if (source === 'google_calendar') {
    conflict.google_busy = {
      // Deliberately vague per spec (do not leak external event title).
      note: 'Another calendar event exists in this window on the connected Google Calendar.',
      window: existing.window || null,
    };
  }
  return conflict;
}

/**
 * Compose SLOT_CONFLICT HttpError.
 */
function slotConflictError(conflict) {
  const err = new HttpError(409, 'SLOT_CONFLICT', 'This 15-minute slot is not available.');
  err.details = conflict;
  return err;
}

// ─────────────────────────────────────────────────────────────────────
// Create appointment (called by the status-change flow or directly)
// ─────────────────────────────────────────────────────────────────────

/**
 * Payload:
 *   enquiryId          number
 *   scheduledDate      'YYYY-MM-DD'   (IST calendar date)   -- OR --
 *   scheduledTime      'HH:MM'                              (24h IST)
 *   scheduledAt        Date | string (ISO with +05:30)      (alt shape)
 *   contextNote        string
 *   detailedNote       string
 *   statusHistoryId    number | null   (link to status change if any)
 *   adminId            number | null
 *   unmasked           bool            (X-Key-Pin verified; 409 body raw)
 */
async function createAppointment(payload) {
  const {
    enquiryId,
    scheduledDate, scheduledTime,
    contextNote, detailedNote,
    scheduledAt,
    statusHistoryId,
    adminId,
    unmasked,
    // Optional. Supplied by enquiries.js#changeStatus, which books the
    // appointment BEFORE it writes the taxonomy (so a slot conflict 409s
    // before any status change lands -- see the comment at its call site).
    // Without this the confirmation email reads the taxonomy back from the
    // DB while that write is still pending and reports the PRE-change trio:
    // a lead being moved to follow_up / spoke / hot mailed out as
    // new / unattended / — . Any field left undefined here falls back to
    // the DB value, which is correct for the direct-booking path
    // (POST /enquiries/:id/appointment) where nothing is changing.
    leadTaxonomyOverride,
  } = payload || {};

  if (!enquiryId) throw new HttpError(400, 'VALIDATION_ERROR', 'enquiryId required');

  // Resolve wall-clock -> floored bucket.
  let flooredIstDate;
  let slotKey;
  if (scheduledDate && scheduledTime) {
    const f = appts.parseAndFloorIstWallClock(scheduledDate, scheduledTime);
    if (!f) throw new HttpError(400, 'VALIDATION_ERROR', 'scheduledDate/Time must be YYYY-MM-DD + HH:MM');
    flooredIstDate = f.istDate;
    slotKey = f.slotKey;
  } else if (scheduledAt) {
    const parsed = new Date(scheduledAt);
    if (Number.isNaN(parsed.getTime())) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'scheduledAt must be a valid ISO date-time');
    }
    // Convert the ISO instant to IST-wall-clock components, then floor.
    const IST_OFFSET_MS = (5 * 60 + 30) * 60_000;
    const asIstWall = new Date(parsed.getTime() + IST_OFFSET_MS);
    const y = asIstWall.getUTCFullYear();
    const mo = asIstWall.getUTCMonth();
    const da = asIstWall.getUTCDate();
    const h = asIstWall.getUTCHours();
    const m = Math.floor(asIstWall.getUTCMinutes() / 15) * 15;
    flooredIstDate = new Date(Date.UTC(y, mo, da, h, m, 0));
    slotKey = appts.slotKeyFromIstWallClock(flooredIstDate);
  } else {
    throw new HttpError(400, 'VALIDATION_ERROR', 'scheduledDate + scheduledTime (or scheduledAt) required');
  }

  // T-2026-176 (spec §7): reject a booking whose slot is in the past
  // (IST comparison). Runs BEFORE any DB work so no transaction is
  // opened for a request that will always fail. FE has a matching
  // client-side guard; this is defense-in-depth.
  if (isSlotKeyInPastIst(slotKey)) {
    throw new HttpError(400, 'PAST_SLOT', 'Cannot book a slot in the past.');
  }

  const identity = await resolveLeadIdentity(Number(enquiryId));
  if (!identity) throw new HttpError(404, 'NOT_FOUND', 'Enquiry not found');

  // GCal freebusy pre-check (outside tx -- external call, don't hold locks).
  // Call through module.exports so tests can monkey-patch this method
  // without touching the local closure reference.
  const gcalBusy = await module.exports.checkGoogleCalendarBusy(flooredIstDate, DEFAULT_DURATION_MINUTES);
  if (gcalBusy.busy) {
    const conflict = await buildConflictPayload(
      { slot_key: slotKey, window: gcalBusy.window },
      'google_calendar',
      { unmasked },
    );
    throw slotConflictError(conflict);
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    // Lock the enquiry row so a concurrent status-change on the same
    // enquiry can't race us.
    const existingEnq = await crm.findEnquiryByIdForConn(conn, Number(enquiryId));
    if (!existingEnq) throw new HttpError(404, 'NOT_FOUND', 'Enquiry not found');

    // In-tx conflict check (FOR UPDATE).
    const existingConflict = await appts.findActiveAppointmentBySlotKeyForConn(conn, slotKey);
    if (existingConflict) {
      const conflictIdentity = await resolveLeadIdentity(existingConflict.enquiry_id);
      const conflict = await buildConflictPayload({
        slot_key: slotKey,
        appointment_id: existingConflict.id,
        crm_enquiry_id: existingConflict.enquiry_id,
        enquiry_code: existingConflict.enquiry_code,
        lead_name: conflictIdentity ? conflictIdentity.name : '',
        lead_mobile: conflictIdentity ? conflictIdentity.mobile : '',
        property_ids: conflictIdentity ? conflictIdentity.property_ids : [],
        current_status_code: conflictIdentity ? conflictIdentity.current_status_code : null,
        scheduled_at_wallclock: existingConflict.scheduled_at,
      }, 'crm', { unmasked });
      throw slotConflictError(conflict);
    }

    // Insert PENDING row first (google_event_id filled in a moment).
    let appointmentId;
    try {
      appointmentId = await appts.insertAppointmentForConn(conn, {
        enquiryId: Number(enquiryId),
        scheduledAt: flooredIstDate,
        activeSlotKey: slotKey,
        timezone: DEFAULT_TIMEZONE,
        reminderA: REMINDER_MINUTES_A,
        reminderB: REMINDER_MINUTES_B,
        contextNote: contextNote || null,
        detailedNote: detailedNote || null,
        statusHistoryId: statusHistoryId || null,
        googleEventId: null,
        syncStatus: 'PENDING',
        syncLastError: null,
        createdByAdminId: adminId || null,
      });
    } catch (e) {
      // Race lost to UNIQUE(active_slot_key): translate to 409.
      if (e && (e.code === 'ER_DUP_ENTRY' || e.errno === 1062)) {
        // Re-query the winner for the conflict payload.
        const [rows] = await conn.query(
          `SELECT ca.*, e.enquiry_code FROM crm_calendar_activities ca
             JOIN crm_enquiries e ON e.id = ca.enquiry_id
            WHERE ca.active_slot_key = ? AND ca.booking_status = 'active' LIMIT 1`,
          [slotKey],
        );
        const winner = rows[0] || null;
        if (winner) {
          const conflictIdentity = await resolveLeadIdentity(winner.enquiry_id);
          const conflict = await buildConflictPayload({
            slot_key: slotKey,
            appointment_id: winner.id,
            crm_enquiry_id: winner.enquiry_id,
            enquiry_code: winner.enquiry_code,
            lead_name: conflictIdentity ? conflictIdentity.name : '',
            lead_mobile: conflictIdentity ? conflictIdentity.mobile : '',
            property_ids: conflictIdentity ? conflictIdentity.property_ids : [],
            current_status_code: conflictIdentity ? conflictIdentity.current_status_code : null,
            scheduled_at_wallclock: winner.scheduled_at,
          }, 'crm', { unmasked });
          throw slotConflictError(conflict);
        }
      }
      throw e;
    }

    // Insert 'created' history row.
    await appts.insertHistoryForConn(conn, {
      appointmentId,
      action: 'created',
      fromScheduledAt: null,
      toScheduledAt: flooredIstDate,
      adminId: adminId || null,
      actionNote: contextNote || null,
    });

    await conn.commit();

    // Post-commit: GCal + email (best-effort, fire-and-forget).
    const gcalPayload = {
      enquiry_id: Number(enquiryId),
      enquiry_code: identity.enquiry_code,
      scheduled_at_iso: istDateToIsoWithOffset(flooredIstDate),
      context_note: contextNote || '',
      detailed_note: detailedNote || '',
      reminder_minutes_before_a: REMINDER_MINUTES_A,
      reminder_minutes_before_b: REMINDER_MINUTES_B,
      // NEW T-165 fields for enriched event body (per spec §7/§8/§9)
      lead_name: identity.name,
      lead_mobile: identity.mobile,
      enquiry_type: identity.source_type,
      property_ids: identity.property_ids,
      current_status_code: identity.current_status_code,
    };
    const gcalResult = await googleCalendar.createEvent(gcalPayload);

    // Persist sync result (best-effort; failure here doesn't roll back
    // the CRM booking -- per spec §29 the CRM record stays).
    if (gcalResult.sync_status === 'SYNCED' && gcalResult.google_event_id) {
      const c2 = await pool.getConnection();
      try {
        await appts.updateAppointmentSyncForConn(c2, {
          appointmentId,
          googleEventId: gcalResult.google_event_id,
          syncStatus: 'SYNCED',
          syncLastError: null,
        });
      } finally { c2.release(); }
    } else if (gcalResult.sync_status === 'FAILED') {
      const c2 = await pool.getConnection();
      try {
        await appts.updateAppointmentSyncForConn(c2, {
          appointmentId,
          googleEventId: null,
          syncStatus: 'FAILED',
          syncLastError: gcalResult.reason || 'GCAL_UNKNOWN',
        });
      } finally { c2.release(); }
    }

    // T-2026-179: admin-only notification (never to customer). The
    // adminNotifications service loads recipient dynamically from Email
    // Master; leadEmail is captured only for the defensive guard.
    // Resolve the lead taxonomy trio + resolved property codes for the
    // email body via the display-projection query (JSON-first).
    setImmediate(async () => {
      let leadStage = null, leadStatus = null, leadRating = null;
      try {
        const enq = await crm.findEnquiryByIdForDisplay(Number(enquiryId));
        if (enq) {
          leadStage  = enq.lead_stage_code  || null;
          leadStatus = enq.lead_status_code || null;
          leadRating = enq.lead_rating_code || null;
        }
      } catch (_e) { /* fail-open: taxonomy fields render as '—' */ }
      // Caller-supplied values win over the DB read -- see the
      // leadTaxonomyOverride note on the payload destructure. `undefined`
      // means "not being changed", so it keeps the DB value; an explicit
      // null means "cleared" and must NOT fall back.
      if (leadTaxonomyOverride) {
        if (leadTaxonomyOverride.stage  !== undefined) leadStage  = leadTaxonomyOverride.stage;
        if (leadTaxonomyOverride.status !== undefined) leadStatus = leadTaxonomyOverride.status;
        if (leadTaxonomyOverride.rating !== undefined) leadRating = leadTaxonomyOverride.rating;
      }
      appointmentEmail.sendAppointmentEmail({
        mode: 'created',
        enquiryCode: identity.enquiry_code,
        enquiryType: identity.source_type,
        leadName:    identity.name,
        leadEmail:   identity.email,
        leadMobile:  identity.mobile,
        scheduledAt: flooredIstDate,
        propertyIds: identity.property_ids,
        leadStage, leadStatus, leadRating,
        notes: contextNote || null,
      }).catch(() => { /* swallow -- trySendMail already logs */ });
    });

    return {
      appointment_id: appointmentId,
      enquiry_id: Number(enquiryId),
      scheduled_at: flooredIstDate,
      active_slot_key: slotKey,
      sync_status: gcalResult.sync_status,
      sync_reason: gcalResult.reason || null,
      google_event_id: gcalResult.google_event_id || null,
    };
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Convert an IST-wall-clock Date (whose UTC components == IST wall clock)
 * back to an ISO string with +05:30 offset. Used by GCal payload.
 */
function istDateToIsoWithOffset(d) {
  if (!d || !(d instanceof Date)) return null;
  const y = d.getUTCFullYear();
  const mo = pad2(d.getUTCMonth() + 1);
  const da = pad2(d.getUTCDate());
  const h = pad2(d.getUTCHours());
  const mi = pad2(d.getUTCMinutes());
  const s = pad2(d.getUTCSeconds());
  return `${y}-${mo}-${da}T${h}:${mi}:${s}+05:30`;
}

// ─────────────────────────────────────────────────────────────────────
// Edit appointment
// ─────────────────────────────────────────────────────────────────────

async function updateAppointment({
  appointmentId,
  scheduledDate, scheduledTime,
  contextNote, detailedNote,
  adminId,
  unmasked,
}) {
  if (!appointmentId) throw new HttpError(400, 'VALIDATION_ERROR', 'appointmentId required');
  if (!scheduledDate || !scheduledTime) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'scheduledDate + scheduledTime required');
  }
  const f = appts.parseAndFloorIstWallClock(scheduledDate, scheduledTime);
  if (!f) throw new HttpError(400, 'VALIDATION_ERROR', 'scheduledDate/Time must be YYYY-MM-DD + HH:MM');
  const newSlotKey = f.slotKey;
  const newIstDate = f.istDate;

  // T-2026-176 (spec §7): reject shift to a past slot BEFORE opening the
  // transaction. FE has a matching client-side guard; this is defense-in-
  // depth against clock drift or client-side bypass.
  if (isSlotKeyInPastIst(newSlotKey)) {
    throw new HttpError(400, 'PAST_SLOT', 'Cannot reschedule to a slot in the past.');
  }

  // Look up identity for the email later.
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const existing = await appts.getAppointmentByIdForConn(conn, Number(appointmentId));
    if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Appointment not found');
    if (existing.booking_status !== 'active') {
      throw new HttpError(409, 'ALREADY_CANCELLED', 'This appointment has been cancelled and cannot be edited.');
    }

    const enquiryId = existing.enquiry_id;
    const oldScheduledAt = existing.scheduled_at;
    const slotChanged = existing.active_slot_key !== newSlotKey;

    // GCal freebusy pre-check for a REAL change of slot.
    if (slotChanged) {
      const gcalBusy = await module.exports.checkGoogleCalendarBusy(newIstDate, DEFAULT_DURATION_MINUTES);
      if (gcalBusy.busy) {
        const conflict = await buildConflictPayload(
          { slot_key: newSlotKey, window: gcalBusy.window },
          'google_calendar',
          { unmasked },
        );
        throw slotConflictError(conflict);
      }
      // In-tx CRM conflict check (exclude self).
      const collide = await appts.findActiveAppointmentBySlotKeyForConn(conn, newSlotKey, { excludeAppointmentId: Number(appointmentId) });
      if (collide) {
        const conflictIdentity = await resolveLeadIdentity(collide.enquiry_id);
        const conflict = await buildConflictPayload({
          slot_key: newSlotKey,
          appointment_id: collide.id,
          crm_enquiry_id: collide.enquiry_id,
          enquiry_code: collide.enquiry_code,
          lead_name: conflictIdentity ? conflictIdentity.name : '',
          lead_mobile: conflictIdentity ? conflictIdentity.mobile : '',
          property_ids: conflictIdentity ? conflictIdentity.property_ids : [],
          current_status_code: conflictIdentity ? conflictIdentity.current_status_code : null,
          scheduled_at_wallclock: collide.scheduled_at,
        }, 'crm', { unmasked });
        throw slotConflictError(conflict);
      }
    }

    try {
      await appts.updateAppointmentSlotForConn(conn, {
        appointmentId: Number(appointmentId),
        scheduledAt: newIstDate,
        activeSlotKey: newSlotKey,
        contextNote: contextNote != null ? contextNote : existing.context_note,
        detailedNote: detailedNote != null ? detailedNote : existing.detailed_note,
        updatedByAdminId: adminId || null,
        // Migration 112: only a real slot move re-arms the 1-day / 1-hour
        // admin reminders. Same gate as the reschedule email below.
        resetReminders: slotChanged,
      });
    } catch (e) {
      if (e && (e.code === 'ER_DUP_ENTRY' || e.errno === 1062)) {
        const [rows] = await conn.query(
          `SELECT ca.*, e.enquiry_code FROM crm_calendar_activities ca
             JOIN crm_enquiries e ON e.id = ca.enquiry_id
            WHERE ca.active_slot_key = ? AND ca.booking_status = 'active' LIMIT 1`,
          [newSlotKey],
        );
        const winner = rows[0] || null;
        if (winner) {
          const conflictIdentity = await resolveLeadIdentity(winner.enquiry_id);
          const conflict = await buildConflictPayload({
            slot_key: newSlotKey,
            appointment_id: winner.id,
            crm_enquiry_id: winner.enquiry_id,
            enquiry_code: winner.enquiry_code,
            lead_name: conflictIdentity ? conflictIdentity.name : '',
            lead_mobile: conflictIdentity ? conflictIdentity.mobile : '',
            property_ids: conflictIdentity ? conflictIdentity.property_ids : [],
            current_status_code: conflictIdentity ? conflictIdentity.current_status_code : null,
            scheduled_at_wallclock: winner.scheduled_at,
          }, 'crm', { unmasked });
          throw slotConflictError(conflict);
        }
      }
      throw e;
    }

    // Insert edit-history row (only when slot actually changed OR notes changed).
    await appts.insertHistoryForConn(conn, {
      appointmentId: Number(appointmentId),
      action: 'edited',
      fromScheduledAt: oldScheduledAt,
      toScheduledAt: newIstDate,
      adminId: adminId || null,
      actionNote: null,
    });

    await conn.commit();

    // Post-commit: GCal update (or create if no existing event_id).
    const identity = await resolveLeadIdentity(enquiryId);
    const gcalPayload = {
      enquiry_id: enquiryId,
      enquiry_code: identity ? identity.enquiry_code : null,
      scheduled_at_iso: istDateToIsoWithOffset(newIstDate),
      context_note: contextNote != null ? contextNote : (existing.context_note || ''),
      detailed_note: detailedNote != null ? detailedNote : (existing.detailed_note || ''),
      reminder_minutes_before_a: REMINDER_MINUTES_A,
      reminder_minutes_before_b: REMINDER_MINUTES_B,
      lead_name: identity ? identity.name : '',
      lead_mobile: identity ? identity.mobile : '',
      enquiry_type: identity ? identity.source_type : null,
      property_ids: identity ? identity.property_ids : [],
      current_status_code: identity ? identity.current_status_code : null,
    };
    let gcalResult;
    if (existing.google_event_id) {
      gcalResult = await googleCalendar.updateEvent(existing.google_event_id, gcalPayload);
    } else {
      gcalResult = await googleCalendar.createEvent(gcalPayload);
    }
    if (gcalResult.sync_status === 'SYNCED' && gcalResult.google_event_id) {
      const c2 = await pool.getConnection();
      try {
        await appts.updateAppointmentSyncForConn(c2, {
          appointmentId: Number(appointmentId),
          googleEventId: gcalResult.google_event_id,
          syncStatus: 'SYNCED',
          syncLastError: null,
        });
      } finally { c2.release(); }
    } else if (gcalResult.sync_status === 'FAILED') {
      const c2 = await pool.getConnection();
      try {
        await appts.updateAppointmentSyncForConn(c2, {
          appointmentId: Number(appointmentId),
          googleEventId: existing.google_event_id || null,
          syncStatus: 'FAILED',
          syncLastError: gcalResult.reason || 'GCAL_UNKNOWN',
        });
      } finally { c2.release(); }
    }

    // T-2026-179: rescheduled notification -- ONLY fires when the slot
    // actually changed (spec §C.5: "Only fire when date and/or time
    // actually changed. Do NOT fire when only lead_* fields change").
    // Since this branch of appointmentSlots.js only runs when
    // updateAppointment is called (which always passes a scheduledDate +
    // scheduledTime), we still gate on slotChanged to avoid a spurious
    // reschedule email when the operator saved the same slot with only
    // notes changed. Lead taxonomy changes flow through the separate
    // /status-change endpoint (services/crm/enquiries.js#changeStatus)
    // which does NOT trigger this email path -- so the "only lead_*"
    // scenario is structurally impossible on this code path.
    if (identity && slotChanged) {
      // Resolve the operator's display name for "Updated By" (best-effort;
      // fall back to id string, then '—' via template).
      let updatedByName = null;
      if (adminId) {
        try {
          // eslint-disable-next-line global-require
          const admins = require('../../db/queries/admins');
          const adminRow = await admins.findActiveById(Number(adminId));
          updatedByName = adminRow?.full_name || null;
        } catch (_e) { /* fail-open */ }
      }
      setImmediate(() => {
        appointmentEmail.sendAppointmentEmail({
          mode: 'edited',
          enquiryCode: identity.enquiry_code,
          enquiryType: identity.source_type,
          leadName:    identity.name,
          leadEmail:   identity.email,
          leadMobile:  identity.mobile,
          previousScheduledAt: oldScheduledAt,
          scheduledAt: newIstDate,
          propertyIds: identity.property_ids,
          updatedByName,
        }).catch(() => {});
      });
    }

    return {
      appointment_id: Number(appointmentId),
      enquiry_id: enquiryId,
      scheduled_at: newIstDate,
      active_slot_key: newSlotKey,
      sync_status: gcalResult.sync_status,
      sync_reason: gcalResult.reason || null,
      google_event_id: gcalResult.google_event_id || existing.google_event_id || null,
    };
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

// ─────────────────────────────────────────────────────────────────────
// Cancel appointment
// ─────────────────────────────────────────────────────────────────────

async function cancelAppointment({ appointmentId, adminId, actionNote }) {
  if (!appointmentId) throw new HttpError(400, 'VALIDATION_ERROR', 'appointmentId required');

  const conn = await pool.getConnection();
  let existing;
  try {
    await conn.beginTransaction();
    existing = await appts.getAppointmentByIdForConn(conn, Number(appointmentId));
    if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Appointment not found');
    if (existing.booking_status !== 'active') {
      throw new HttpError(409, 'ALREADY_CANCELLED', 'This appointment has already been cancelled.');
    }
    await appts.cancelAppointmentForConn(conn, {
      appointmentId: Number(appointmentId),
      cancelledByAdminId: adminId || null,
    });
    await appts.insertHistoryForConn(conn, {
      appointmentId: Number(appointmentId),
      action: 'cancelled',
      fromScheduledAt: existing.scheduled_at,
      toScheduledAt: null,
      adminId: adminId || null,
      actionNote: actionNote || null,
    });
    await conn.commit();
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }

  // Post-commit: GCal delete (best-effort). Do not re-fail the response
  // on GCal error -- the CRM cancellation is authoritative per spec.
  let gcalResult = { sync_status: 'CANCELLED', reason: 'NO_EVENT_ID' };
  if (existing.google_event_id) {
    gcalResult = await googleCalendar.cancelEvent(existing.google_event_id);
  }

  // T-2026-179: cancellation notification goes to admin ONLY (never to
  // the lead). Fires per spec §C.4 with previously-scheduled date/time
  // + cancellation reason (if operator supplied one).
  const identity = await resolveLeadIdentity(existing.enquiry_id);
  if (identity) {
    setImmediate(() => {
      appointmentEmail.sendAppointmentEmail({
        mode: 'cancelled',
        enquiryCode: identity.enquiry_code,
        enquiryType: identity.source_type,
        leadName:    identity.name,
        leadEmail:   identity.email,
        leadMobile:  identity.mobile,
        scheduledAt: existing.scheduled_at,
        propertyIds: identity.property_ids,
        cancellationReason: actionNote || null,
      }).catch(() => {});
    });
  }

  return {
    appointment_id: Number(appointmentId),
    booking_status: 'cancelled',
    gcal_sync_status: gcalResult.sync_status,
    gcal_reason: gcalResult.reason || null,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Read helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * Return the current active appointment for an enquiry, or null. Used
 * by the CrmList row to decide whether to show Edit/Cancel actions.
 */
async function getActiveForEnquiry(enquiryId) {
  const row = await appts.getActiveAppointmentForEnquiry(Number(enquiryId));
  return row ? appointmentToDto(row) : null;
}

function appointmentToDto(row) {
  return {
    id: row.id,
    enquiry_id: row.enquiry_id,
    scheduled_at: row.scheduled_at,
    active_slot_key: row.active_slot_key || null,
    timezone: row.timezone,
    context_note: row.context_note || null,
    detailed_note: row.detailed_note || null,
    google_event_id: row.google_event_id || null,
    sync_status: row.sync_status,
    booking_status: row.booking_status,
    status_history_id: row.status_history_id || null,
    reminder_minutes_before_a: row.reminder_minutes_before_a,
    reminder_minutes_before_b: row.reminder_minutes_before_b,
    created_at: row.created_at,
    updated_at: row.updated_at,
    cancelled_at: row.cancelled_at || null,
  };
}

async function listAppointmentHistory(appointmentId) {
  const rows = await appts.listHistoryByAppointment(Number(appointmentId));
  return rows.map((r) => ({
    id: r.id,
    appointment_id: r.appointment_id,
    action: r.action,
    from_scheduled_at: r.from_scheduled_at || null,
    to_scheduled_at: r.to_scheduled_at || null,
    admin_id: r.admin_id || null,
    action_note: r.action_note || null,
    created_at: r.created_at,
  }));
}

module.exports = {
  listAvailableSlots,
  createAppointment,
  updateAppointment,
  cancelAppointment,
  getActiveForEnquiry,
  listAppointmentHistory,
  appointmentToDto,
  // exported for tests
  buildConflictPayload,
  resolveLeadIdentity,
  slotConflictError,
  checkGoogleCalendarBusy,
  istDateToIsoWithOffset,
  // T-2026-176 exports for smoke tests
  computeIstNowFloor,
  isSlotKeyInPastIst,
  SLOT_HOUR_START,
  SLOT_HOUR_END,
  DEFAULT_DURATION_MINUTES,
};
