/**
 * Google Calendar OAuth Connect / Callback service.
 *
 * T-2026-164. Owns the /api/google-calendar/{status,connect,callback,
 * disconnect} handlers' business logic. Route layer is thin --
 * everything with real logic lives here.
 *
 * Security invariants (T-2026-164 §9):
 *   * State param is a 64-hex random string persisted in
 *     google_calendar_oauth_states with a 10-minute expiry. Callback
 *     pops it single-use before token exchange (CSRF-safe).
 *   * Callback validates state BEFORE calling oauth2Client.getToken().
 *   * Errors mapped to a small enum -- Google's raw error strings are
 *     never appended to the redirect URL.
 *   * refresh_token from the exchange response is stored and never
 *     echoed back. The status endpoint returns booleans + email only.
 */

const crypto = require('crypto');
const gcal = require('./googleCalendar');
const gcalDb = require('../../db/queries/googleCalendar');

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// calendar.events alone is NOT enough. It covers creating / updating /
// deleting the follow-up events (googleCalendar.createEvent etc.), but the
// slot picker's conflict detection calls calendar.freebusy.query --
// appointmentSlots.checkGoogleCalendarBusy on write, and listGoogleBusyForDate
// when building the availability grid -- and freebusy requires calendar
// READ access. With only calendar.events, every freebusy call came back
// "Request had insufficient authentication scopes" and hit the fail-open
// branch, so Google conflicts were silently never detected: no amber
// "Google busy" slots in the picker, and no pre-booking clash guard.
//
// Adding calendar.readonly rather than the broad `calendar` scope keeps the
// grant to the minimum that makes freebusy work.
//
// NOTE: an ALREADY-CONNECTED account keeps whatever scope it consented to --
// widening this list does not retro-grant. The operator must Disconnect and
// Connect again for the new scope to take effect (prompt:'consent' below
// forces a fresh consent screen, so the reconnect does pick it up).
const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
];

/**
 * Categorised failure enum for the callback redirect URL. Never expose
 * raw Google error text.
 */
const CALLBACK_ERROR_REASONS = Object.freeze({
  MISSING_STATE:      'missing_state',
  UNKNOWN_STATE:      'unknown_state',
  EXPIRED_STATE:      'expired_state',
  USER_DENIED:        'user_denied',
  GOOGLE_ERROR:       'google_error',
  EXCHANGE_FAILED:    'exchange_failed',
  NO_REFRESH_TOKEN:   'no_refresh_token',
  MISSING_CONFIG:     'missing_config',
  UNEXPECTED:         'unexpected',
});

/**
 * FE landing URL after the callback completes. Uses FRONTEND_ORIGIN
 * env if set, otherwise CORS_ORIGIN (first entry), otherwise
 * http://localhost:5173.
 */
function frontendOrigin() {
  if (process.env.FRONTEND_ORIGIN) return process.env.FRONTEND_ORIGIN;
  if (process.env.CORS_ORIGIN) {
    const first = String(process.env.CORS_ORIGIN).split(',').map((s) => s.trim()).filter(Boolean)[0];
    if (first) return first;
  }
  return 'http://localhost:5173';
}

function frontendCrmUrl(qs) {
  const origin = frontendOrigin().replace(/\/+$/, '');
  return `${origin}/admin/crm${qs ? `?${qs}` : ''}`;
}

// -------------------- /status --------------------

async function getStatus() {
  const row = await gcalDb.getSingletonToken();
  const base = {
    connected: false,
    calendar_id: gcal.calendarId(),
    scopes: SCOPES,
  };
  if (!row) return base;
  return {
    connected: true,
    calendar_id: gcal.calendarId(),
    scopes: SCOPES,
    connected_by_admin_email: row.connected_by_admin_email || null,
    connected_at: row.connected_at,
    scope_granted: row.scope_granted || null,
  };
}

// -------------------- /connect --------------------

/**
 * Builds the Google OAuth consent URL with a fresh CSRF state row.
 * Returns { auth_url, state }.
 */
async function buildConnectUrl({ adminId, adminEmail = null }) {
  if (!gcal.hasClientConfig()) {
    const err = new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI must be set');
    err.code = 'GOOGLE_CONFIG_MISSING';
    throw err;
  }
  if (!adminId) {
    const err = new Error('adminId required to build connect URL');
    err.code = 'ADMIN_ID_REQUIRED';
    throw err;
  }
  const state = crypto.randomBytes(32).toString('hex'); // 64 hex chars
  const expiresAt = new Date(Date.now() + STATE_TTL_MS);
  await gcalDb.insertOAuthState({
    state,
    admin_id: adminId,
    admin_email: adminEmail,
    expires_at: expiresAt,
  });
  const oauth2 = gcal.makeOAuth2Client();
  const auth_url = oauth2.generateAuthUrl({
    access_type: 'offline',     // required for refresh_token
    prompt: 'consent',          // force refresh_token issuance even on re-consent
    scope: SCOPES,
    state,
    include_granted_scopes: true,
  });
  return { auth_url, state };
}

// -------------------- /callback --------------------

/**
 * Processes the OAuth callback query. Returns a redirect URL string.
 * Never throws -- every failure is mapped to a categorised error redirect.
 *
 * Note the intentionally-narrow function surface: routes call this
 * with the raw query object and immediately res.redirect() the result.
 */
async function handleCallback(query) {
  const q = query || {};
  const state = q.state ? String(q.state) : '';

  // Case 1: Google returned an error (usually access_denied when the
  // user cancels on the consent screen). We still pop the state so it
  // can't be replayed.
  if (q.error) {
    if (state) { try { await gcalDb.popOAuthState(state); } catch (_) { /* ignore */ } }
    const reason = q.error === 'access_denied'
      ? CALLBACK_ERROR_REASONS.USER_DENIED
      : CALLBACK_ERROR_REASONS.GOOGLE_ERROR;
    return frontendCrmUrl(`google_calendar=error&reason=${encodeURIComponent(reason)}`);
  }

  // Case 2: no state -- either a directly-hit callback URL or a
  // corrupted Google redirect. Reject.
  if (!state) {
    return frontendCrmUrl(`google_calendar=error&reason=${encodeURIComponent(CALLBACK_ERROR_REASONS.MISSING_STATE)}`);
  }

  // Case 3: pop state single-use. If missing/expired, reject.
  let stateRow;
  try {
    stateRow = await gcalDb.popOAuthState(state);
  } catch (e) {
    return frontendCrmUrl(`google_calendar=error&reason=${encodeURIComponent(CALLBACK_ERROR_REASONS.UNEXPECTED)}`);
  }
  if (!stateRow) {
    return frontendCrmUrl(`google_calendar=error&reason=${encodeURIComponent(CALLBACK_ERROR_REASONS.UNKNOWN_STATE)}`);
  }
  if (stateRow.expired) {
    return frontendCrmUrl(`google_calendar=error&reason=${encodeURIComponent(CALLBACK_ERROR_REASONS.EXPIRED_STATE)}`);
  }

  // Case 4: no code -- shouldn't happen if state was present, but
  // guard anyway.
  const code = q.code ? String(q.code) : '';
  if (!code) {
    return frontendCrmUrl(`google_calendar=error&reason=${encodeURIComponent(CALLBACK_ERROR_REASONS.MISSING_STATE)}`);
  }

  // Case 5: happy path -- exchange code for tokens.
  let oauth2;
  try {
    oauth2 = gcal.makeOAuth2Client();
  } catch (e) {
    return frontendCrmUrl(`google_calendar=error&reason=${encodeURIComponent(CALLBACK_ERROR_REASONS.MISSING_CONFIG)}`);
  }

  let tokens;
  try {
    const resp = await oauth2.getToken(code);
    tokens = resp && resp.tokens ? resp.tokens : null;
  } catch (e) {
    // Log the MESSAGE only.
    // eslint-disable-next-line no-console
    console.error('[googleCalendar] callback getToken', (e && e.message) || 'unknown');
    return frontendCrmUrl(`google_calendar=error&reason=${encodeURIComponent(CALLBACK_ERROR_REASONS.EXCHANGE_FAILED)}`);
  }
  if (!tokens || !tokens.refresh_token) {
    // Google only issues refresh_token on the first consent or when
    // prompt=consent is set. If we're here without one, the user
    // must revoke the app from https://myaccount.google.com/permissions
    // then reconnect. Surface a distinct reason.
    return frontendCrmUrl(`google_calendar=error&reason=${encodeURIComponent(CALLBACK_ERROR_REASONS.NO_REFRESH_TOKEN)}`);
  }

  // Try to fetch the user's email (best-effort) for the /status
  // display. Requires the `openid` + `email` scopes which we didn't
  // request -- so this will typically fail silently. Fall back to the
  // admin_email captured in the state row.
  let googleEmail = null;
  try {
    oauth2.setCredentials({ access_token: tokens.access_token, refresh_token: tokens.refresh_token });
    const infoResp = await oauth2.request({ url: 'https://www.googleapis.com/oauth2/v3/userinfo' });
    if (infoResp && infoResp.data && infoResp.data.email) googleEmail = String(infoResp.data.email);
  } catch (_e) {
    // No calendar scope -> no userinfo; that's fine. Fall back below.
  }

  const persistedEmail = googleEmail || stateRow.admin_email || null;
  const expiryDate = tokens.expiry_date ? new Date(tokens.expiry_date) : null;

  try {
    await gcalDb.upsertSingletonToken({
      refresh_token: tokens.refresh_token,
      access_token: tokens.access_token || null,
      access_token_expires_at: expiryDate,
      scope_granted: tokens.scope || null,
      token_type: tokens.token_type || null,
      connected_by_admin_id: stateRow.admin_id,
      connected_by_admin_email: persistedEmail,
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[googleCalendar] callback upsertSingletonToken', (e && e.message) || 'unknown');
    return frontendCrmUrl(`google_calendar=error&reason=${encodeURIComponent(CALLBACK_ERROR_REASONS.UNEXPECTED)}`);
  }

  return frontendCrmUrl('google_calendar=connected');
}

// -------------------- /disconnect --------------------

/**
 * Best-effort revoke of the Google refresh_token, then delete the
 * local singleton row. Even if the revoke API call fails, we still
 * drop the local row so the local CRM immediately reverts to the
 * un-connected NOT_CONNECTED state.
 */
async function disconnect() {
  const row = await gcalDb.getSingletonToken();
  if (!row) {
    return { disconnected: true, already: true };
  }
  try {
    const oauth2 = gcal.makeOAuth2Client();
    oauth2.setCredentials({ refresh_token: row.refresh_token });
    if (typeof oauth2.revokeToken === 'function') {
      try {
        await oauth2.revokeToken(row.refresh_token);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[googleCalendar] disconnect revokeToken', (e && e.message) || 'unknown');
      }
    }
  } catch (e) {
    // Config missing -- can still delete the local row.
    // eslint-disable-next-line no-console
    console.error('[googleCalendar] disconnect prep', (e && e.message) || 'unknown');
  }
  await gcalDb.deleteSingletonToken();
  return { disconnected: true, already: false };
}

module.exports = {
  getStatus,
  buildConnectUrl,
  handleCallback,
  disconnect,
  frontendCrmUrl,
  CALLBACK_ERROR_REASONS,
  SCOPES,
  STATE_TTL_MS,
};
