/**
 * Key-PIN header middleware (T-2026-151 Phase 3).
 *
 * Gates PII-unmask requests on the CRM subsystem. When a request wants
 * raw name/mobile/email (via ?unmasked=1), the caller MUST also send
 * the operator's 6-digit Security PIN in the `X-Key-Pin` request
 * header. The middleware re-validates that PIN against the same
 * bcrypt-hashed key_pins table used by /api/admin/key-pins/verify --
 * a valid FE session alone is NOT enough per spec §42-§44.
 *
 * Why re-validate on every unmask request instead of trusting a
 * server-side session flag?
 *   - PII disclosure is auditable per-request, not per-session.
 *   - No new schema (no session table, no signed cookie).
 *   - Mirrors how the FE already prompts the operator (10-minute
 *     shared PIN gate via useAdminActionPinGate + PinVerificationModal
 *     -> shared/api/keyPins.verifyKeyPin()). The FE holds the PIN in
 *     memory for the modal's lifetime only; each unmask request
 *     re-submits it as the X-Key-Pin header (see
 *     shared/api/crm.js listAllocationsByProperty({ unmasked, pin })).
 *   - A wrong header returns 401 UNMASK_PIN_INVALID; a missing
 *     header returns 401 UNMASK_PIN_REQUIRED. The route handler that
 *     mounted this middleware ONLY runs the unmasked branch when the
 *     header path resolves cleanly; masked responses never touch this
 *     middleware (see routes/admin/crm.js -- masked default path
 *     bypasses requireKeyPinHeader entirely).
 *
 * Rate limiting: this middleware DOES NOT wrap its own limiter. The
 * primary throttle for wrong-PIN attempts is the existing
 * /api/admin/key-pins/verify limiter (20 attempts / 5 min per IP).
 * A malicious client that tries to brute-force via unmask requests
 * would surface the same wrong PIN through both paths; the shared
 * limiter is already applied at that surface. If future analysis
 * shows the unmask path warrants its own limiter, add it at the
 * router level -- do not layer another limiter here (would cause
 * confusing double-counting).
 */

const { HttpError } = require('./errors');
const keyPins = require('../services/security/key_pins');
const { verify: verifyKeyPin } = keyPins;

const PIN_REGEX = /^[0-9]{6}$/;

/**
 * Extract the pin from the incoming request. Header name is case-
 * insensitive per HTTP; Express normalizes headers to lowercase, so
 * we read req.headers['x-key-pin']. Falls back to the alternate name
 * `x-pin` for callers that prefer the shorter form.
 */
function readPinFromRequest(req) {
  const raw = req.headers['x-key-pin'] || req.headers['x-pin'] || '';
  return String(raw || '').trim();
}

/**
 * Middleware factory. Returns an Express handler that:
 *   - Reads the X-Key-Pin header.
 *   - 401 UNMASK_PIN_REQUIRED when absent / malformed.
 *   - Delegates to key_pins.verify() (bcrypt-compare against every
 *     active hash, constant-ish time) -- 401 UNMASK_PIN_INVALID on
 *     no match; passes control to next() on match.
 *
 * The verify service throws HttpError(401, 'INVALID_PIN', ...) on a
 * no-match; we catch that specifically and re-throw with a distinct
 * unmask-specific code so the FE can surface a targeted message
 * ("Wrong PIN for reveal, try again") instead of collapsing to the
 * generic PIN-verify error string.
 */
function requireKeyPinHeader() {
  return async function keyPinHeaderMiddleware(req, res, next) {
    try {
      const pin = readPinFromRequest(req);
      if (!pin) {
        throw new HttpError(
          401,
          'UNMASK_PIN_REQUIRED',
          'Security PIN required to reveal contact details.',
        );
      }
      if (!PIN_REGEX.test(pin)) {
        throw new HttpError(
          401,
          'UNMASK_PIN_INVALID',
          'Security PIN must be exactly 6 numeric digits.',
        );
      }
      try {
        await verifyKeyPin({ pin });
      } catch (err) {
        // key_pins.verify throws INVALID_PIN with status 401 on no-match.
        // Preserve the 401 but relabel so the FE can distinguish an
        // unmask-path rejection from a generic /verify call.
        if (err && err.status === 401 && err.code === 'INVALID_PIN') {
          throw new HttpError(
            401,
            'UNMASK_PIN_INVALID',
            'Invalid Security PIN. Reveal denied.',
          );
        }
        throw err;
      }
      // OK -- attach a marker so downstream handlers can log/audit
      // the unmask path if they choose. Consumers should NOT rely on
      // this for authorization; the middleware presence is the gate.
      req.keyPinVerified = true;
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Conditional variant: only requires the header when a boolean flag
 * is truthy. Consumers use this on routes where masked (default) and
 * unmasked (?unmasked=1) both flow through the same handler.
 *
 * Example:
 *   router.get('/enquiries', requireKeyPinHeaderWhen((req) => boolQ(req.query.unmasked)), handler)
 *
 * The predicate is evaluated on each request; when it returns false
 * the middleware calls next() immediately -- zero cost for masked
 * calls. When true, it delegates to requireKeyPinHeader().
 */
function requireKeyPinHeaderWhen(predicate) {
  const gate = requireKeyPinHeader();
  return function keyPinHeaderConditional(req, res, next) {
    try {
      if (!predicate(req)) return next();
      return gate(req, res, next);
    } catch (err) {
      next(err);
    }
  };
}

module.exports = {
  requireKeyPinHeader,
  requireKeyPinHeaderWhen,
};
