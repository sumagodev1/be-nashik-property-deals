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
 */

const crypto = require('crypto');
const { pool } = require('../db/pool');

const DEFAULT_TTL_SECONDS = 5 * 60; // 5 minutes — enough to cover a flaky-network retry.

function scopeFor(req) {
  const actor = (req.auth && req.auth.sub) ? `u:${req.auth.sub}` : `ip:${req.ip}`;
  return `${req.method} ${req.baseUrl}${req.route?.path || req.path} ${actor}`;
}

// Strip the prefix that gets prepended by the route mount path (e.g.
// /api/admin/inventory-properties). We don't need full URL parsing —
// scopeFor() handles the variation. Sticking with what Express gives us.

module.exports = function idempotency({ ttlSeconds = DEFAULT_TTL_SECONDS } = {}) {
  return async function idempotencyMiddleware(req, res, next) {
    const rawKey = req.get('Idempotency-Key');
    if (!rawKey) return next();
    // Trim + bound the key length so a misbehaving client can't store
    // arbitrary blobs in our table.
    const key = String(rawKey).slice(0, 128);
    const scope = scopeFor(req);

    let cached;
    try {
      const [rows] = await pool.query(
        `SELECT status_code, response_body
           FROM idempotency_keys
          WHERE idempotency_key = ? AND scope = ?
            AND created_at > (NOW() - INTERVAL ? SECOND)
          LIMIT 1`,
        [key, scope, ttlSeconds],
      );
      cached = rows[0];
    } catch (err) {
      // Storage errors should never block legitimate traffic — log + skip.
      // eslint-disable-next-line no-console
      console.error('[idempotency] lookup failed:', err.message);
      return next();
    }

    if (cached) {
      // Replay the cached response verbatim. The body was stored as raw
      // JSON text so we can pass it through without re-serialising.
      res.status(Number(cached.status_code) || 200);
      if (cached.response_body) {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Idempotent-Replay', 'true');
        return res.send(cached.response_body);
      }
      res.setHeader('Idempotent-Replay', 'true');
      return res.end();
    }

    // No cache entry yet — wrap res.json / res.send so we capture the
    // response and persist it before forwarding it to the client.
    const originalJson = res.json.bind(res);
    const originalSend = res.send.bind(res);
    let captured = false;

    async function persist(body) {
      if (captured) return;
      captured = true;
      const status = res.statusCode;
      // Only cache successful + client-error responses. 5xx are server
      // bugs — the next retry should hit the handler again, not the
      // cache of a transient failure.
      if (status >= 500) return;
      try {
        const json = typeof body === 'string' ? body : JSON.stringify(body);
        await pool.query(
          `INSERT IGNORE INTO idempotency_keys (idempotency_key, scope, status_code, response_body)
           VALUES (?, ?, ?, ?)`,
          [key, scope, status, json],
        );
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[idempotency] persist failed:', err.message);
      }
    }

    res.json = (body) => {
      persist(body);
      return originalJson(body);
    };
    res.send = (body) => {
      if (typeof body === 'object' && body !== null) persist(body);
      else if (typeof body === 'string') {
        try { persist(JSON.parse(body)); } catch { /* not JSON, skip */ }
      }
      return originalSend(body);
    };

    return next();
  };
};

// Small helper used by callers that want to generate a key server-side
// (e.g. an internal cron). Not used by request paths — clients supply
// their own keys.
module.exports.makeKey = () => crypto.randomUUID();
