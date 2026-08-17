// Cron-driven endpoints. Token-gated, NO JWT. Designed to be hit by
// cPanel's "Cron Jobs" feature using a curl-with-header invocation.
// Example (every 10 minutes):
//   <cron expr> curl -fsS -X POST -H "X-Cron-Token: $TOKEN" \
//     https://your-host/api/cron/email-outbox/process > /dev/null
// Token is configured via CRON_TOKEN env var. Keep it >=32 chars random.

const express = require('express');

const { requireCronToken } = require('../middleware/cronAuth');
const outbox = require('../services/email/outbox');
const appointmentReminders = require('../services/crm/appointmentReminders');

const router = express.Router();
router.use(requireCronToken);

router.post('/email-outbox/process', async (req, res, next) => {
  try {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || outbox.DEFAULT_BATCH_SIZE));
    const summary = await outbox.processBatch({ limit });
    res.json({ ok: true, ...summary });
  } catch (e) { next(e); }
});

// Migration 112: admin reminder emails for booked CRM follow-up calls, at
// the 1-day and 1-hour offsets stored on each booking. Idempotent — each
// reminder is claimed atomically before send, so overlapping invocations
// (or a manual re-run) never double-mail the admin.
//
// Every 15 minutes is the intended cadence; the 1-hour reminder then lands
// 45-60 min ahead of the call. A missed window is NOT lost — the scan has no
// lower bound on lateness, so the next tick still sends as long as the call
// has not already happened.
//   */15 * * * * curl -fsS -X POST -H "X-Cron-Token: $CRON_TOKEN" \
//     https://your-host/api/cron/crm/appointment-reminders/dispatch > /dev/null
router.post('/crm/appointment-reminders/dispatch', async (req, res, next) => {
  try {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    const summary = await appointmentReminders.dispatchDueReminders({ limit });
    res.json({ ok: true, ...summary });
  } catch (e) { next(e); }
});

module.exports = router;
