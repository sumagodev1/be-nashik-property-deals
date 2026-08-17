/**
 * Google Calendar routes.
 *
 * T-2026-164. Mounted at /api/google-calendar (NOT under /admin/crm --
 * this is auth-infrastructure, not a CRM data endpoint).
 *
 * Endpoints:
 *   GET  /api/google-calendar/status       -- admin-authed; returns
 *                                              connection + calendar
 *                                              metadata (never any
 *                                              token value).
 *   GET  /api/google-calendar/connect      -- admin-authed; returns
 *                                              { auth_url, state } for
 *                                              the FE to navigate to.
 *   GET  /api/google-calendar/callback     -- NOT auth-required;
 *                                              Google redirects here
 *                                              from the browser after
 *                                              consent. Exchanges the
 *                                              code, stores the tokens,
 *                                              302-redirects back to
 *                                              the FE.
 *   POST /api/google-calendar/disconnect   -- admin-authed; revokes
 *                                              the refresh_token and
 *                                              deletes the local row.
 *
 * Security invariants (T-2026-164 §9):
 *   * No route echoes or logs GOOGLE_CLIENT_SECRET, refresh_token,
 *     access_token, or code.
 *   * State param is CSRF-safe (64 hex chars, single-use, 10min TTL,
 *     validated before token exchange).
 *   * Callback errors mapped to a fixed enum -- never Google's raw
 *     error text -- so the redirect URL query string cannot leak
 *     information.
 */

const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { HttpError } = require('../middleware/errors');
const oauthSvc = require('../services/crm/googleCalendarOAuth');

const router = express.Router();

// ------------------------------------------------------------------
// GET /status  (admin-authed)
// ------------------------------------------------------------------
router.get(
  '/status',
  requireAuth,
  requireRole('admin', 'sub_admin'),
  async (req, res, next) => {
    try {
      const status = await oauthSvc.getStatus();
      res.json(status);
    } catch (e) { next(e); }
  },
);

// ------------------------------------------------------------------
// GET /connect  (admin-authed)
// ------------------------------------------------------------------
// Returns { auth_url, state } so the FE can navigate the operator to
// Google's consent screen. State is single-use CSRF-safe per §9.
router.get(
  '/connect',
  requireAuth,
  requireRole('admin', 'sub_admin'),
  async (req, res, next) => {
    try {
      const rawSub = req.auth && (req.auth.sub || req.auth.userId || req.auth.id);
      const adminId = rawSub != null ? Number(rawSub) || rawSub : null;
      const adminEmail = req.auth && req.auth.email;
      if (!adminId) throw new HttpError(401, 'UNAUTHENTICATED', 'Missing admin identity');
      const out = await oauthSvc.buildConnectUrl({ adminId, adminEmail });
      res.json(out);
    } catch (e) { next(e); }
  },
);

// ------------------------------------------------------------------
// GET /callback  (PUBLIC -- Google redirects here from the browser)
// ------------------------------------------------------------------
// This handler NEVER throws to the express error handler. Every
// failure resolves to a categorised error redirect back to the FE.
router.get('/callback', async (req, res) => {
  try {
    const redirectTo = await oauthSvc.handleCallback(req.query || {});
    res.redirect(302, redirectTo);
  } catch (e) {
    // Absolute fallback -- should never reach here because
    // handleCallback catches everything, but this belt-and-braces
    // ensures the redirect always happens.
    // eslint-disable-next-line no-console
    console.error('[googleCalendar] callback route fallback', (e && e.message) || 'unknown');
    const url = oauthSvc.frontendCrmUrl(`google_calendar=error&reason=${encodeURIComponent(oauthSvc.CALLBACK_ERROR_REASONS.UNEXPECTED)}`);
    res.redirect(302, url);
  }
});

// ------------------------------------------------------------------
// POST /disconnect  (admin-authed)
// ------------------------------------------------------------------
router.post(
  '/disconnect',
  requireAuth,
  requireRole('admin', 'sub_admin'),
  async (req, res, next) => {
    try {
      const out = await oauthSvc.disconnect();
      res.json(out);
    } catch (e) { next(e); }
  },
);

module.exports = router;
