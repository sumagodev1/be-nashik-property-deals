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

module.exports = {
  enqueue,
  processBatch,
  BACKOFF_MINUTES,
  MAX_ATTEMPTS,
  DEFAULT_BATCH_SIZE,
};
