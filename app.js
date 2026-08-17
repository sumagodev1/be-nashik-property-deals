require('dotenv').config();

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');

const apiRouter = require('./server/routes');
const { notFound, errorHandler } = require('./server/middleware/errors');

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1);

// CORS goes BEFORE helmet and the body parsers so the preflight OPTIONS
// requests resolve cleanly without falling through to other middleware that
// might set conflicting headers or return early.
//
// We use a function-style `origin` rather than an array of strings — that
// way the `Vary: Origin` and `Access-Control-Allow-Origin: <exact-origin>`
// headers always reflect the actual request, never the wildcard `*`. The
// browser refuses `*` whenever the request is credentialed (cookies /
// Authorization / withCredentials:true), which is the failure mode we see
// in the seller login flow.
const corsAllowlist = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean)
  : [];
app.use(cors({
  origin(origin, callback) {
    // Same-origin / curl / server-to-server (no Origin header) — let through.
    if (!origin) return callback(null, true);
    if (corsAllowlist.includes(origin)) return callback(null, origin);
    // Unknown origin → reject. Browser surfaces this as a CORS error which
    // is what we want — better than silently allowing every site.
    return callback(new Error(`Origin "${origin}" not allowed by CORS`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'],
}));

// Helmet's default Cross-Origin-Resource-Policy is `same-origin`, which
// prevents the frontend (on a different origin) from loading uploaded images
// served from /uploads/public. Relax it to `cross-origin` so <img src> works
// across origins. All other security headers stay enforced.
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

const publicUploadsDir = path.resolve(__dirname, process.env.UPLOAD_PUBLIC_DIR || 'uploads/public');
app.use('/uploads/public', express.static(publicUploadsDir, { maxAge: '7d', fallthrough: true }));

app.use('/api', apiRouter);

const staticDir = path.resolve(__dirname, 'public');
app.use(express.static(staticDir));

app.get(/^\/(?!api|uploads).*/, (req, res, next) => {
  res.sendFile(path.join(staticDir, 'index.html'), (err) => {
    if (err) next();
  });
});

app.use(notFound);
app.use(errorHandler);

const port = Number(process.env.PORT) || 4000;
if (require.main === module) {
  // One-shot: on the first boot after Global / Email exists but has no
  // rows, migrate the legacy SMTP_* env vars into an Active configuration
  // so email keeps working without manual re-entry. Idempotent — every
  // subsequent boot short-circuits after a single COUNT query. Never
  // blocks startup: any error is logged and swallowed.
  const envMigration = require('./server/services/email/env_migration');
  envMigration.runIfNeeded().finally(() => {
    app.listen(port, () => {
      // eslint-disable-next-line no-console
      console.log(`API listening on :${port} (${process.env.NODE_ENV || 'development'})`);
      // T-2026-164: start the Google Calendar sync worker. Gated by
      // GOOGLE_CALENDAR_SYNC_WORKER_ENABLED (default true); returns
      // {started:false, reason:'DISABLED_BY_ENV'} when explicitly
      // disabled by tests / secondary instances. Silent no-op when
      // no admin has connected -- the worker itself short-circuits
      // its tick when the token row is absent.
      try {
        const gcalWorker = require('./server/services/crm/googleCalendarSyncWorker');
        const outcome = gcalWorker.start();
        // eslint-disable-next-line no-console
        console.log('[googleCalendarSyncWorker] start', outcome);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[googleCalendarSyncWorker] boot error', (e && e.message) || 'unknown');
      }

      // Migration 112: dispatch the 1-day / 1-hour admin reminder emails for
      // booked CRM follow-ups. Runs in-process on an interval (same shape as
      // the GCal worker above) rather than depending solely on the cron
      // endpoint -- without this, a deployment that never added the cPanel
      // cron entry silently sends no reminders at all. Gated by
      // CRM_REMINDER_WORKER_ENABLED (default true). The cron endpoint remains
      // available for manual / external scheduling; both paths are safe
      // together because each reminder is claimed atomically before send.
      try {
        const reminderWorker = require('./server/services/crm/appointmentReminders');
        const outcome = reminderWorker.start();
        // eslint-disable-next-line no-console
        console.log('[appointmentReminders] start', outcome);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[appointmentReminders] boot error', (e && e.message) || 'unknown');
      }
    });
  });
}

module.exports = app;
