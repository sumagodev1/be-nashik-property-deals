/**
 * Idempotency middleware — Stripe-style.
 *
 * Reads the `Idempotency-Key` header on incoming requests. If a key has
 * been seen before (within the TTL) for the same method + path + caller,
 * the cached response is replayed and the handler is skipped. Otherwise
 * the handler runs, and the response is captured into the cache before
 * being sent.
 *
 * Apply selectively — most code paths get this added at the route level
 * because not every endpoint needs dedupe (GETs don't, idempotent PUTs
 * arguably don't either). The ones that DO need it: lead capture, seller
 * registration, property create, status flips, approvals.
 *
 *   const idempotent = require('../../middleware/idempotency');
 *   router.post('/', idempotent(), validate(body), handler);
 *
 * Scope:
 *   method + path are always part of the cache key. The actor — the
 *   authenticated user's id when present, otherwise the source IP — is
 *   added so two unrelated requests can't collide on the same UUID.
 *
 * T-2026-110 concurrency guarantee:
 *   Two identical CONCURRENT requests are serialised via the UNIQUE KEY
 *   constraint on `idempotency_keys(idempotency_key, scope)`. The winner
 *   INSERTs a "pending" row (status_code=0), runs the handler, and
 *   UPDATEs the row with the real response. The loser gets a duplicate-
 *   key error, polls the row until it becomes non-pending, then replays.
 *   No persistent DB connection is held during the handler — the pool
 *   is not starved even under heavy same-key contention.
 */

const crypto = require('crypto');
const { pool } = require('../db/pool');

const DEFAULT_TTL_SECONDS = 5 * 60; // 5 minutes — enough to cover a flaky-network retry.

// T-2026-110: how long a "loser" request polls for the winner's response
// before giving up and returning 503-ish. Property creates finish well
// under 5s on this project (95th percentile ~700ms per DB query trace).
// 15s gives a comfortable margin for a slow disk / cold pool.
const WAIT_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 50; // 50ms polling — 300 polls fit in the timeout window

function scopeFor(req) {
  const actor = (req.auth && req.auth.sub) ? `u:${req.auth.sub}` : `ip:${req.ip}`;
  return `${req.method} ${req.baseUrl}${req.route?.path || req.path} ${actor}`;
}

// Sleep helper — plain setTimeout wrapped in a Promise so we can `await`.
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

module.exports = function idempotency({ ttlSeconds = DEFAULT_TTL_SECONDS } = {}) {
  return async function idempotencyMiddleware(req, res, next) {
    const rawKey = req.get('Idempotency-Key');
    if (!rawKey) return next();
    // Trim + bound the key length so a misbehaving client can't store
    // arbitrary blobs in our table.
    const key = String(rawKey).slice(0, 128);
    const scope = scopeFor(req);

    // Step 1 — Try to CLAIM the key by INSERTing a "pending" row.
    // The UNIQUE KEY (idempotency_key, scope) is the concurrency primitive.
    // If INSERT succeeds → we are the WINNER: run the handler + record
    // the real response. If the row is a duplicate → we are the LOSER:
    // poll until the winner's response lands, then replay.
    //
    // status_code=0 marks the row as pending. Any real response has
    // status_code >= 100 (HTTP). A row older than the TTL is treated
    // as stale — we take over by DELETE+INSERT so a stuck request from
    // an earlier deploy doesn't permanently poison the key.
    let isWinner = false;
    try {
      // Purge stale pending / expired rows for THIS key so a hung
      // previous request doesn't lock us out forever. Also purges
      // rows past TTL — the response replay is stale anyway.
      await pool.query(
        `DELETE FROM idempotency_keys
          WHERE idempotency_key = ? AND scope = ?
            AND created_at < (NOW() - INTERVAL ? SECOND)`,
        [key, scope, ttlSeconds],
      );
      const [ins] = await pool.query(
        `INSERT IGNORE INTO idempotency_keys
           (idempotency_key, scope, status_code, response_body)
         VALUES (?, ?, 0, NULL)`,
        [key, scope],
      );
      isWinner = ins.affectedRows === 1;
    } catch (err) {
      // Storage error — never block legitimate traffic. Fall through
      // without the concurrency guard. In production this would only
      // happen under a DB outage, which is a separate incident anyway.
      // eslint-disable-next-line no-console
      console.error('[idempotency] claim failed:', err.message);
      return next();
    }

    // ── LOSER PATH ────────────────────────────────────────────────
    if (!isWinner) {
      // Poll the row until the winner writes a real response (status_code
      // becomes non-zero), then replay it. Bail out with 503 if the
      // winner never completes within the timeout — the client can retry
      // with a new UUID.
      const startedAt = Date.now();
      let waited = 0;
      let winnerRow = null;
      while (waited < WAIT_TIMEOUT_MS) {
        try {
          const [rows] = await pool.query(
            `SELECT status_code, response_body
               FROM idempotency_keys
              WHERE idempotency_key = ? AND scope = ?
              LIMIT 1`,
            [key, scope],
          );
          const r = rows[0];
          if (r && Number(r.status_code) > 0) {
            winnerRow = r;
            break;
          }
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('[idempotency] poll failed:', err.message);
          break;
        }
        await sleep(POLL_INTERVAL_MS);
        waited = Date.now() - startedAt;
      }
      if (winnerRow) {
        // Replay verbatim. response_body is the raw JSON text; deliver
        // with application/json Content-Type + the Idempotent-Replay
        // marker header so clients can distinguish a replay from a
        // fresh response if they care.
        res.status(Number(winnerRow.status_code) || 200);
        res.setHeader('Idempotent-Replay', 'true');
        if (winnerRow.response_body) {
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          return res.send(winnerRow.response_body);
        }
        return res.end();
      }
      // Winner never finished — return 503 so the client sees a
      // deterministic failure and can retry. We do NOT fall through to
      // next() because that would run the handler unguarded, defeating
      // the whole point of the dedupe.
      // eslint-disable-next-line no-console
      console.error(`[idempotency] loser wait timeout for key ${key.slice(0, 8)}… scope ${scope}`);
      res.status(503).json({
        error: {
          code: 'IDEMPOTENCY_WAIT_TIMEOUT',
          message: 'A previous request with the same Idempotency-Key is still in progress. Please retry with a new key.',
        },
      });
      return;
    }

    // ── WINNER PATH ───────────────────────────────────────────────
    // We inserted the pending row. Run the handler, capture the
    // response via wrapped res.json / res.send, and UPDATE the row
    // with the real status + body BEFORE the response is sent to the
    // client. This guarantees any loser polling wakes up to the real
    // response instead of the pending placeholder.
    const originalJson = res.json.bind(res);
    const originalSend = res.send.bind(res);
    let captured = false;

    async function persist(body) {
      if (captured) return;
      captured = true;
      const status = res.statusCode;
      try {
        const json = typeof body === 'string' ? body : JSON.stringify(body);
        if (status >= 500) {
          // 5xx is a server bug — the next retry should hit the handler
          // again, not the cache of a transient failure. Delete our
          // pending row so a subsequent request with the same key
          // proceeds normally instead of replaying the 5xx forever.
          await pool.query(
            `DELETE FROM idempotency_keys WHERE idempotency_key = ? AND scope = ?`,
            [key, scope],
          );
          return;
        }
        await pool.query(
          `UPDATE idempotency_keys
              SET status_code = ?, response_body = ?
            WHERE idempotency_key = ? AND scope = ?`,
          [status, json, key, scope],
        );
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[idempotency] persist failed:', err.message);
      }
    }

    // Ordering enforced by these wrappers:
    //   1. handler calls res.json(body)
    //   2. wrapper awaits persist(body) — UPDATE commits the real response
    //   3. wrapper delegates to originalJson(body) — Express writes bytes
    //   4. any loser polling this key sees the UPDATE and replays it
    // Because persist is awaited BEFORE originalJson runs, any poll AFTER
    // that point sees the completed row. Losers polling BEFORE that point
    // may see the pending row and wait one more 50ms cycle — bounded.
    res.json = (body) => {
      persist(body).then(
        () => originalJson(body),
        () => originalJson(body),
      );
      return res;
    };
    res.send = (body) => {
      let toPersist = null;
      if (typeof body === 'object' && body !== null) {
        toPersist = body;
      } else if (typeof body === 'string') {
        try { toPersist = JSON.parse(body); } catch { toPersist = null; }
      }
      if (toPersist !== null) {
        persist(toPersist).then(
          () => originalSend(body),
          () => originalSend(body),
        );
      } else {
        originalSend(body);
      }
      return res;
    };

    // If the handler crashes without ever sending a response (i.e. Express
    // hands to the error middleware which sends a 500 without going
    // through our wrapper), the pending row would be orphaned. Wire an
    // 'finish' safety net: if we never captured, DELETE the pending row
    // so retries aren't blocked. TTL-based cleanup would eventually clear
    // it too, but this makes the recovery immediate.
    res.on('finish', async () => {
      if (!captured) {
        try {
          await pool.query(
            `DELETE FROM idempotency_keys
              WHERE idempotency_key = ? AND scope = ? AND status_code = 0`,
            [key, scope],
          );
        } catch (_e) { /* best-effort cleanup */ }
      }
    });

    return next();
  };
};

// Small helper used by callers that want to generate a key server-side
// (e.g. an internal cron). Not used by request paths — clients supply
// their own keys.
module.exports.makeKey = () => crypto.randomUUID();
