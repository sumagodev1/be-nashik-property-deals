/**
 * Email outbox worker. Two entry points:
 *   - enqueue(opts)       — drop a message into the queue (used by trySendMail
 *                            on initial-send failure)
 *   - processBatch({limit}) — claim due rows and attempt to send each
 *
 * processBatch is what the cron endpoint + admin "Run now" button call.
 */

const outboxRepo = require('../../db/queries/email_outbox');
const { sendMail } = require('./transporter');

// Cumulative backoff: schedule of minutes to next attempt after each failure.
// After all entries are used, the row is marked permanently failed.
// Tuned so transient SMTP outages (1-2h) self-resolve without manual action,
// while a misconfigured account doesn't keep retrying for days.
const BACKOFF_MINUTES = [5, 30, 120, 360, 1440]; // 5min, 30min, 2h, 6h, 24h
const MAX_ATTEMPTS = BACKOFF_MINUTES.length + 1; // 6 attempts total
const DEFAULT_BATCH_SIZE = 25;

async function enqueue({ to, subject, text, html }) {
  if (!to || !subject) throw new Error('outbox.enqueue: to + subject required');
  return outboxRepo.enqueue({ to, subject, text, html, nextAttemptAt: null });
}

/**
 * Claim up to `limit` due rows, attempt each, and update DB state. Returns
 * a summary of what happened. Safe to call concurrently with cron — the
 * row claim is atomic.
 */
async function processBatch({ limit = DEFAULT_BATCH_SIZE } = {}) {
  const claimed = await outboxRepo.claimBatch(limit);
  const summary = { claimed: claimed.length, sent: 0, retried: 0, failed: 0, errors: [] };

  for (const row of claimed) {
    const attemptNumber = (row.attempts || 0) + 1;
    try {
      await sendMail({
        to: row.to_address,
        subject: row.subject,
        text: row.body_text || undefined,
        html: row.body_html || undefined,
      });
      await outboxRepo.markSent(row.id);
      summary.sent += 1;
    } catch (err) {
      const errorMessage = String(err.code || err.message || 'send failed').slice(0, 1000);
      if (attemptNumber >= MAX_ATTEMPTS) {
        await outboxRepo.markFailedPermanent(row.id, {
          attempts: attemptNumber,
          error: errorMessage,
        });
        summary.failed += 1;
      } else {
        const minutes = BACKOFF_MINUTES[attemptNumber - 1];
        const nextAt = sqlDatetime(new Date(Date.now() + minutes * 60_000));
        await outboxRepo.markRetry(row.id, {
          attempts: attemptNumber,
          nextAttemptAt: nextAt,
          error: errorMessage,
        });
        summary.retried += 1;
      }
      summary.errors.push({ id: row.id, error: errorMessage });
    }
  }

  return summary;
}

function sqlDatetime(d) {
  // pool sets session timezone to UTC; we format the date as UTC.
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

// ─────────────────────────────────────────────────────────────────────
// In-process drainer
// ─────────────────────────────────────────────────────────────────────
//
// WHY THIS EXISTS
//   trySendMail() sends inline and falls back to enqueue() when SMTP fails, so
//   the outbox is where every undelivered admin notification lands. Until now
//   nothing drained it automatically — the only path was an operator calling
//   POST /admin/email-outbox/process by hand. A deployment that never wired
//   that up therefore queued mail forever: this database held 5 rows, the
//   oldest from 31 Aug, every one `pending` with attempts = 0, including a CRM
//   follow-up reminder the UI was already reporting as sent.
//
//   Same shape as the Google Calendar and appointment-reminder workers in
//   app.js: an interval, gated by an env flag, safe to run alongside the manual
//   route because processBatch claims rows before sending.
//
// Failures inside a tick are logged and swallowed — a broken SMTP config must
// not take the API process down, and the rows stay queued for the next tick.

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
let timer = null;

function start() {
  if (String(process.env.EMAIL_OUTBOX_WORKER_ENABLED || 'true').toLowerCase() === 'false') {
    return { started: false, reason: 'EMAIL_OUTBOX_WORKER_ENABLED=false' };
  }
  if (timer) return { started: false, reason: 'ALREADY_RUNNING' };

  const intervalMs = Math.max(
    60 * 1000,
    Number(process.env.EMAIL_OUTBOX_WORKER_INTERVAL_MS) || DEFAULT_INTERVAL_MS,
  );

  const tick = async () => {
    try {
      const summary = await processBatch({});
      // Only speak up when something actually moved, so a healthy idle queue
      // does not fill the log.
      if (summary && (summary.sent || summary.failed || summary.retried)) {
        // eslint-disable-next-line no-console
        console.log('[emailOutbox] tick', summary);
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[emailOutbox] tick error', (e && e.message) || 'unknown');
    }
  };

  timer = setInterval(tick, intervalMs);
  if (timer.unref) timer.unref();
  // Drain once at boot so a backlog left by a previous run goes out without
  // waiting a full interval.
  tick();
  return { started: true, intervalMs };
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = {
  enqueue,
  processBatch,
  start,
  stop,
  BACKOFF_MINUTES,
  MAX_ATTEMPTS,
  DEFAULT_BATCH_SIZE,
};
