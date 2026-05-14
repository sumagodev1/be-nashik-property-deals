// Cron-driven endpoints. Token-gated, NO JWT. Designed to be hit by
// cPanel's "Cron Jobs" feature using a curl-with-header invocation.
// Example (every 10 minutes):
//   <cron expr> curl -fsS -X POST -H "X-Cron-Token: $TOKEN" \
//     https://your-host/api/cron/email-outbox/process > /dev/null
// Token is configured via CRON_TOKEN env var. Keep it >=32 chars random.

const express = require('express');

const { requireCronToken } = require('../middleware/cronAuth');
const outbox = require('../services/email/outbox');

const router = express.Router();
router.use(requireCronToken);

router.post('/email-outbox/process', async (req, res, next) => {
  try {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || outbox.DEFAULT_BATCH_SIZE));
    const summary = await outbox.processBatch({ limit });
    res.json({ ok: true, ...summary });
  } catch (e) { next(e); }
});

module.exports = router;
