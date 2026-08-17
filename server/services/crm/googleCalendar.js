/**
 * Google Calendar integration -- User OAuth2 (Strategy B) live client.
 *
 * T-2026-164: rewrites the T-2026-151 Phase-1 Strategy-C stub.
 *
 * Behaviour:
 *   * If no google_calendar_tokens row exists (no admin has clicked
 *     Connect yet), every call returns PENDING with reason='NOT_CONNECTED'
 *     synchronously without any network activity. This preserves the
 *     T-151 stub semantics for the un-connected state so a fresh dev DB
 *     works exactly like Phase 1 shipped.
 *   * If a token row exists, we use its refresh_token to mint a
 *     short-lived access_token (cached in the same row until ~60s
 *     before expiry), then call googleapis calendar.events.insert /
 *     update / delete.
 *
 * Interface preserved (zero call-site changes needed anywhere in the
 * CRM enquiries/statusHistory layer):
 *   createEvent(payload)         -> { google_event_id, sync_status, reason }
 *   updateEvent(eventId, payload)-> { google_event_id, sync_status, reason }
 *   cancelEvent(eventId)         -> { google_event_id?, sync_status, reason }
 *
 * Security invariants (T-2026-164 §9 constraints):
 *   * refresh_token is READ FROM the DB and passed only into
 *     oauth2Client.setCredentials(). It is never logged, JSON-
 *     serialised, echoed to any response, or included in any error.
 *   * access_token has the same treatment.
 *   * We catch every network / API error and log ONLY err.message --
 *     never err.config, err.response.request, err.stack (which can
 *     include Authorization headers with the Bearer token).
 *   * The exported "reason" enum is a small fixed set so nothing leaks
 *     from Google's error strings into a URL.
 */

const { google } = require('googleapis');
const gcalDb = require('../../db/queries/googleCalendar');

const CALENDAR_ID_DEFAULT = 'primary';
const DEFAULT_TIMEZONE = 'Asia/Kolkata';
const DEFAULT_DURATION_MINUTES = 30;
const REMINDER_MINUTES_A = 1440; // 1 day
const REMINDER_MINUTES_B = 60;   // 1 hour
const ACCESS_TOKEN_REFRESH_BUFFER_MS = 60 * 1000; // refresh 60s before expiry

// Reason enum -- keep tight so the callback route can categorise every
// failure into a small set. Never expose raw Google error text.
const REASONS = Object.freeze({
  NOT_CONNECTED: 'NOT_CONNECTED',
  API_ERROR: 'GOOGLE_API_ERROR',
  MISSING_CONFIG: 'GOOGLE_CALENDAR_NOT_CONFIGURED',
  MISSING_EVENT_ID: 'MISSING_EVENT_ID',
});

function calendarId() {
  return process.env.GOOGLE_CALENDAR_ID || CALENDAR_ID_DEFAULT;
}

function hasClientConfig() {
  return !!(
    process.env.GOOGLE_CLIENT_ID &&
    process.env.GOOGLE_CLIENT_SECRET &&
    process.env.GOOGLE_REDIRECT_URI
  );
}

/**
 * Sanitised error logger. Only the message string, never the config,
 * headers, or stack. Additional context is a plain object of primitives
 * chosen by the caller -- never spread `err` in here.
 */
function logGcalError(where, err, extra = {}) {
  const msg = (err && typeof err.message === 'string') ? err.message : 'unknown';
  // Truncate to prevent accidental token echo from very long messages.
  const safeMsg = msg.length > 300 ? `${msg.slice(0, 300)}…` : msg;
  // eslint-disable-next-line no-console
  console.error('[googleCalendar]', where, safeMsg, extra);
}

// -------------------- OAuth2 client factory --------------------

/**
 * Builds a fresh OAuth2 client wired with the process-env credentials.
 * Callers pass this to setCredentials() with the singleton row's
 * refresh_token. NEVER cache the client at module scope -- if the
 * refresh_token gets rotated (e.g. via revoke + reconnect) we want
 * every call to pick up the latest row.
 */
function makeOAuth2Client() {
  if (!hasClientConfig()) {
    const err = new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI missing');
    err.code = 'GOOGLE_ENV_MISSING';
    throw err;
  }
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI,
  );
}

/**
 * Returns an authorised OAuth2 client backed by a fresh access token,
 * or null if the DB has no connected token row. Refreshes the access
 * token cache in the DB when the current one is missing or within the
 * 60s expiry buffer.
 */
async function getAuthorisedClient() {
  const row = await gcalDb.getSingletonToken();
  if (!row) return null;

  const oauth2 = makeOAuth2Client();

  const now = Date.now();
  const cachedExpiryMs = row.access_token_expires_at
    ? new Date(row.access_token_expires_at).getTime()
    : 0;
  const cachedStillFresh = row.access_token && (cachedExpiryMs - ACCESS_TOKEN_REFRESH_BUFFER_MS) > now;

  if (cachedStillFresh) {
    oauth2.setCredentials({
      refresh_token: row.refresh_token,
      access_token: row.access_token,
      expiry_date: cachedExpiryMs,
    });
    return oauth2;
  }

  // Refresh silently. googleapis' oauth2Client.getAccessToken() uses
  // the refresh_token to mint a fresh access_token behind the scenes.
  oauth2.setCredentials({ refresh_token: row.refresh_token });
  const { token: freshAccess } = await oauth2.getAccessToken();
  // getAccessToken caches on oauth2.credentials with expiry_date; read
  // it and persist to the DB so peer workers can share.
  const creds = oauth2.credentials || {};
  const expiryDate = creds.expiry_date
    ? new Date(creds.expiry_date)
    : new Date(now + 55 * 60 * 1000); // Google access tokens live ~1h; be conservative.

  await gcalDb.updateAccessTokenCache({
    access_token: freshAccess || null,
    access_token_expires_at: expiryDate,
  });
  return oauth2;
}

// -------------------- Payload -> Google event body --------------------

/**
 * Combine a YYYY-MM-DD date and HH:MM time (24h) into an Asia/Kolkata
 * ISO string with an explicit +05:30 offset. Matches the FE helper
 * combineIstDateTimeToIso() so start/end timestamps round-trip cleanly.
 */
function combineIstToIso(dateStr, timeStr) {
  const d = String(dateStr || '').trim();
  const t = String(timeStr || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  if (!/^\d{2}:\d{2}$/.test(t)) return null;
  return `${d}T${t}:00+05:30`;
}

/**
 * Adds N minutes to an ISO string of the form YYYY-MM-DDTHH:MM:SS+05:30.
 * Preserves the +05:30 offset (does NOT convert to UTC) so end.dateTime
 * lines up in the same wall-clock timezone as start.dateTime.
 */
function addMinutesIst(isoStr, minutes) {
  if (!isoStr) return null;
  // Parse the date via the Date constructor (which normalises to UTC
  // internally), add minutes, then re-render in +05:30 wall-clock.
  const asDate = new Date(isoStr);
  if (Number.isNaN(asDate.getTime())) return null;
  const shifted = new Date(asDate.getTime() + minutes * 60000);
  // Render in IST (UTC+5:30). Build via the tzOffset trick.
  const istMs = shifted.getTime() + (5 * 60 + 30) * 60000;
  const d = new Date(istMs);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const da = String(d.getUTCDate()).padStart(2, '0');
  const h = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  const s = String(d.getUTCSeconds()).padStart(2, '0');
  return `${y}-${mo}-${da}T${h}:${mi}:${s}+05:30`;
}

/**
 * Build the Google Calendar event body from a CRM payload.
 *
 * Accepts EITHER shape (backward compat with the T-2026-151 Phase 1
 * enquiries.changeStatus() call-site which uses camelCase, AND the
 * newer FE StatusChangeDialog / retry worker which use snake_case):
 *   * { scheduled_date, scheduled_time }          -- FE dialog raw
 *   * { scheduled_at_iso }                        -- retry worker
 *   * { scheduledAt }                             -- T-151 call-site
 *                                                   (ISO string)
 *   * { contextNote / context_note }              -- either accepted
 *   * { reminderA / reminder_minutes_before_a }   -- either accepted
 *   * { reminderB / reminder_minutes_before_b }   -- either accepted
 */
function buildEventBody(payload) {
  const p = payload || {};
  // Support both naming schemes.
  const scheduled_date  = p.scheduled_date  || null;
  const scheduled_time  = p.scheduled_time  || null;
  const scheduled_at_iso = p.scheduled_at_iso || p.scheduledAt || null;
  const context_note    = p.context_note    || p.contextNote  || '';
  const detailed_note   = p.detailed_note   || p.detailedNote || '';
  const enquiry_code    = p.enquiry_code    || p.enquiryCode  || null;
  // T-2026-165: enriched fields for the description body (spec §7/§8/§9).
  // All optional; when absent the corresponding line is either omitted
  // or filled with '—' (per spec).
  const lead_name       = p.lead_name       || p.leadName       || '';
  const lead_mobile     = p.lead_mobile     || p.leadMobile     || '';
  const enquiry_type    = p.enquiry_type    || p.enquiryType    || null;   // 'website' | 'npd'
  const property_ids    = Array.isArray(p.property_ids) ? p.property_ids : (Array.isArray(p.propertyIds) ? p.propertyIds : []);
  const current_status_code = p.current_status_code || p.currentStatusCode || null;
  const reminder_minutes_before_a = (p.reminder_minutes_before_a != null)
    ? p.reminder_minutes_before_a
    : (p.reminderA != null ? p.reminderA : REMINDER_MINUTES_A);
  const reminder_minutes_before_b = (p.reminder_minutes_before_b != null)
    ? p.reminder_minutes_before_b
    : (p.reminderB != null ? p.reminderB : REMINDER_MINUTES_B);
  const duration_minutes = (p.duration_minutes != null)
    ? p.duration_minutes
    : DEFAULT_DURATION_MINUTES;

  let startIso = scheduled_at_iso || combineIstToIso(scheduled_date, scheduled_time);
  if (!startIso) {
    const err = new Error('scheduled_date + scheduled_time (or scheduled_at_iso) required');
    err.code = 'GOOGLE_CALENDAR_BAD_PAYLOAD';
    throw err;
  }
  // If scheduled_at_iso came from a DATETIME column, it might be a
  // plain "YYYY-MM-DD HH:MM:SS" string (no timezone). Coerce.
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(startIso)) {
    startIso = startIso.replace(' ', 'T') + '+05:30';
  }
  const endIso = addMinutesIst(startIso, Number(duration_minutes) || DEFAULT_DURATION_MINUTES);

  // T-2026-165: title format per spec §7
  //   "CRM Follow-up — {Name} — {enquiry_code}"
  //   Fallback when Name missing: "CRM Follow-up — {enquiry_code}"
  //   Fallback when both missing: context_note (backward-compat with
  //   T-151/T-164 which used context_note as the summary).
  let summary;
  if (lead_name && enquiry_code) {
    summary = `CRM Follow-up — ${String(lead_name).slice(0, 80)} — ${enquiry_code}`;
  } else if (enquiry_code) {
    summary = `CRM Follow-up — ${enquiry_code}`;
  } else {
    summary = (String(context_note || '').trim().slice(0, 200)) || 'CRM Follow-up';
  }

  // T-2026-165: multi-line description per spec §8/§9.
  //   Enquiry Name / Mobile / ID / Type / Property IDs / Current Status
  //   -- blank line --
  //   Context / Reminder Note: <...>
  //   -- blank line --
  //   Detailed Note: <...>
  //   -- blank line --
  //   Scheduled Date: DD/MM/YYYY
  //   Scheduled Time: hh:mm AM/PM IST
  //
  // Legacy callers that only pass context_note + detailed_note (T-151
  // enquiries.changeStatus() pre-T-165) still work -- the enriched
  // lines simply render '—' for missing values.
  function enquiryTypeLabel(t) {
    if (t === 'website') return 'Website Enquiry';
    if (t === 'npd') return 'NPD Enquiry';
    return '—';
  }
  function fmtDate(iso) {
    // startIso is 'YYYY-MM-DDTHH:MM:SS+05:30'; extract date + time.
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):/.exec(iso || '');
    if (!m) return { date: '', time: '' };
    const [, y, mo, d, h, mi] = m;
    let hh = Number(h);
    const period = hh >= 12 ? 'PM' : 'AM';
    hh = hh % 12; if (hh === 0) hh = 12;
    return {
      date: `${d}/${mo}/${y}`,
      time: `${String(hh).padStart(2, '0')}:${mi} ${period} IST`,
    };
  }
  const { date: schedDate, time: schedTime } = fmtDate(startIso);
  const propStr = property_ids && property_ids.length ? property_ids.join(', ') : '—';
  const descLines = [
    `Enquiry Name: ${lead_name || '—'}`,
    `Mobile Number: ${lead_mobile || '—'}`,
    `Enquiry ID: ${enquiry_code || '—'}`,
    `Enquiry Type: ${enquiryTypeLabel(enquiry_type)}`,
    `Property ID(s): ${propStr}`,
    `Current CRM Status: ${current_status_code || '—'}`,
    '',
    `Context / Reminder Note: ${context_note || '—'}`,
    '',
    `Detailed Note: ${detailed_note || '—'}`,
    '',
    `Scheduled Date: ${schedDate}`,
    `Scheduled Time: ${schedTime}`,
  ];
  const description = descLines.join('\n');

  const remindersOverrides = [];
  if (Number(reminder_minutes_before_a) > 0) remindersOverrides.push({ method: 'popup', minutes: Number(reminder_minutes_before_a) });
  if (Number(reminder_minutes_before_b) > 0) remindersOverrides.push({ method: 'popup', minutes: Number(reminder_minutes_before_b) });

  return {
    summary,
    description,
    start: { dateTime: startIso, timeZone: DEFAULT_TIMEZONE },
    end:   { dateTime: endIso,   timeZone: DEFAULT_TIMEZONE },
    reminders: {
      useDefault: false,
      overrides: remindersOverrides.length ? remindersOverrides : undefined,
    },
  };
}

// -------------------- Public API --------------------

async function createEvent(payload) {
  const auth = await getAuthorisedClient();
  if (!auth) {
    return {
      google_event_id: null,
      sync_status: 'PENDING',
      reason: REASONS.NOT_CONNECTED,
    };
  }
  let body;
  try {
    body = buildEventBody(payload);
  } catch (e) {
    logGcalError('createEvent/buildBody', e, { enquiry_code: payload && payload.enquiry_code });
    return {
      google_event_id: null,
      sync_status: 'FAILED',
      reason: REASONS.API_ERROR,
    };
  }
  try {
    const calendar = google.calendar({ version: 'v3', auth });
    // T-2026-179 §D: `sendUpdates: 'none'` guarantees Google does NOT
    // email invitations to any attendee. We do not add attendees today
    // (see buildEventBody -- no `attendees:` key), but this is the
    // belt-and-braces layer so a future edit that adds attendees for a
    // legitimate reason cannot accidentally email a customer.
    const response = await calendar.events.insert({
      calendarId: calendarId(),
      requestBody: body,
      sendUpdates: 'none',
    });
    const eventId = response && response.data && response.data.id ? response.data.id : null;
    if (!eventId) {
      return {
        google_event_id: null,
        sync_status: 'FAILED',
        reason: REASONS.API_ERROR,
      };
    }
    return {
      google_event_id: eventId,
      sync_status: 'SYNCED',
      reason: null,
    };
  } catch (e) {
    logGcalError('createEvent', e, { enquiry_code: payload && payload.enquiry_code });
    return {
      google_event_id: null,
      sync_status: 'FAILED',
      reason: REASONS.API_ERROR,
    };
  }
}

async function updateEvent(googleEventId, payload) {
  if (!googleEventId) {
    return {
      google_event_id: null,
      sync_status: 'FAILED',
      reason: REASONS.MISSING_EVENT_ID,
    };
  }
  const auth = await getAuthorisedClient();
  if (!auth) {
    return {
      google_event_id: googleEventId,
      sync_status: 'PENDING',
      reason: REASONS.NOT_CONNECTED,
    };
  }
  let body;
  try {
    body = buildEventBody(payload);
  } catch (e) {
    logGcalError('updateEvent/buildBody', e, { event_id: googleEventId });
    return {
      google_event_id: googleEventId,
      sync_status: 'FAILED',
      reason: REASONS.API_ERROR,
    };
  }
  try {
    const calendar = google.calendar({ version: 'v3', auth });
    // T-2026-179 §D: suppress any attendee update emails Google might
    // dispatch for a rescheduled event.
    const response = await calendar.events.update({
      calendarId: calendarId(),
      eventId: googleEventId,
      requestBody: body,
      sendUpdates: 'none',
    });
    const eventId = response && response.data && response.data.id ? response.data.id : googleEventId;
    return {
      google_event_id: eventId,
      sync_status: 'SYNCED',
      reason: null,
    };
  } catch (e) {
    logGcalError('updateEvent', e, { event_id: googleEventId });
    return {
      google_event_id: googleEventId,
      sync_status: 'FAILED',
      reason: REASONS.API_ERROR,
    };
  }
}

async function cancelEvent(googleEventId) {
  if (!googleEventId) {
    return {
      google_event_id: null,
      sync_status: 'CANCELLED',
      reason: REASONS.MISSING_EVENT_ID,
    };
  }
  const auth = await getAuthorisedClient();
  if (!auth) {
    return {
      google_event_id: googleEventId,
      sync_status: 'CANCELLED',
      reason: REASONS.NOT_CONNECTED,
    };
  }
  try {
    const calendar = google.calendar({ version: 'v3', auth });
    // T-2026-179 §D: suppress cancellation invite emails to attendees.
    await calendar.events.delete({
      calendarId: calendarId(),
      eventId: googleEventId,
      sendUpdates: 'none',
    });
    return {
      google_event_id: googleEventId,
      sync_status: 'CANCELLED',
      reason: null,
    };
  } catch (e) {
    // If Google returns 404/410 the event is already gone -- treat
    // as CANCELLED, not FAILED (idempotent cancel).
    const status = e && e.code;
    if (status === 404 || status === 410) {
      return {
        google_event_id: googleEventId,
        sync_status: 'CANCELLED',
        reason: null,
      };
    }
    logGcalError('cancelEvent', e, { event_id: googleEventId });
    return {
      google_event_id: googleEventId,
      sync_status: 'FAILED',
      reason: REASONS.API_ERROR,
    };
  }
}

// Legacy compatibility: T-2026-151 Phase 1 exported isLiveMode() +
// STUB_REASON. Retain both so any diagnostic caller still works.
function isLiveMode() {
  // Live mode = both env config present AND a token row exists. The
  // second half is best-effort here (sync check would need a DB call);
  // callers should treat this as an env-only advisory. The real
  // gating is inside getAuthorisedClient() which is async.
  return hasClientConfig();
}

const STUB_REASON = REASONS.NOT_CONNECTED;

module.exports = {
  createEvent,
  updateEvent,
  cancelEvent,
  // exported for tests / diagnostic endpoints
  isLiveMode,
  STUB_REASON,
  REASONS,
  // exported for the sync worker + tests
  getAuthorisedClient,
  buildEventBody,
  combineIstToIso,
  addMinutesIst,
  makeOAuth2Client,
  hasClientConfig,
  calendarId,
};
