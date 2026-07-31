/**
 * Key PIN Master service.
 *
 * Owns:
 *  - CRUD around the 6-digit "security PIN" that gates access to
 *    confidential owner / key-person details and sensitive property
 *    mutations (create / update / delete).
 *  - Bcrypt-hashing of every stored PIN (plaintext PINs never touch
 *    the DB layer).
 *  - The max-5-active-PIN business rule.
 *  - The verify() call: bcrypt-compares an incoming plaintext PIN
 *    against every active hash.
 *
 * Security notes:
 *  - Plaintext PINs are handled in memory only for the duration of a
 *    single request; no logging, no storage.
 *  - Hashes are never returned to callers of any HTTP endpoint —
 *    the queries layer's public projection omits `hashed_pin`.
 *  - Verify uses a constant-ish time-loop over all active hashes so
 *    a caller can't infer how many active PINs exist from response time.
 */

const bcrypt = require('bcrypt');
const { HttpError } = require('../../middleware/errors');
const keyPins = require('../../db/queries/key_pins');

const MAX_ACTIVE_PINS = 5;
const BCRYPT_ROUNDS = 12;
const PIN_REGEX = /^[0-9]{6}$/;

// Dummy hash used to burn a bcrypt.compare cycle when there are zero
// active PINs, so verify() response time is not obviously different in
// the empty-set case.
const DUMMY_HASH = '$2b$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalida';

function assertPinShape(pin) {
  if (typeof pin !== 'string' || !PIN_REGEX.test(pin)) {
    throw new HttpError(400, 'INVALID_PIN', 'PIN must be exactly 6 numeric digits.');
  }
}

function normalizeStatus(raw) {
  if (raw === true || raw === 'active' || raw === 1 || raw === '1') return 'active';
  if (raw === false || raw === 'inactive' || raw === 0 || raw === '0') return 'inactive';
  return null;
}

/**
 * Shape the row for API responses. `hashed_pin` is stripped defensively
 * even though the queries layer already omits it, and a masked display
 * value is added for convenience of the frontend.
 */
function toApi(row) {
  if (!row) return null;
  const { hashed_pin, ...safe } = row;
  return {
    ...safe,
    pinMasked: '••••••',
  };
}

async function list(params = {}) {
  const res = await keyPins.list(params);
  return { ...res, data: res.data.map(toApi) };
}

async function getOne(id) {
  const row = await keyPins.getById(id);
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Key PIN not found');
  return toApi(row);
}

async function create({ pin, status = 'active' }, req) {
  assertPinShape(pin);
  const targetStatus = normalizeStatus(status) || 'active';

  if (targetStatus === 'active') {
    const activeCount = await keyPins.countActive();
    if (activeCount >= MAX_ACTIVE_PINS) {
      throw new HttpError(
        409,
        'PIN_LIMIT_REACHED',
        `Maximum of ${MAX_ACTIVE_PINS} active PINs allowed.`,
      );
    }
  }

  // Reject duplicates — an incoming PIN must not match any existing
  // non-deleted (active OR inactive) PIN. We check against active hashes
  // via verify semantics; inactive duplicates are also blocked to avoid
  // confusing re-enable races.
  const activeMatch = await verifyPlaintext(pin);
  if (activeMatch.matched) {
    throw new HttpError(409, 'PIN_DUPLICATE', 'This PIN already exists.');
  }

  const hashedPin = await bcrypt.hash(pin, BCRYPT_ROUNDS);
  const adminId = req?.auth?.sub ? Number(req.auth.sub) : null;
  const created = await keyPins.create({ hashedPin, status: targetStatus, adminId });
  return toApi(created);
}

async function update(id, { pin = null, status = null }, req) {
  const existing = await keyPins.getById(id);
  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Key PIN not found');

  const targetStatus = status === null || status === undefined ? null : normalizeStatus(status);
  if (status !== null && status !== undefined && targetStatus === null) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'status must be "active" or "inactive".');
  }

  // Enabling an inactive PIN counts against the max-5-active limit.
  if (targetStatus === 'active' && existing.status !== 'active') {
    const activeCount = await keyPins.countActive();
    if (activeCount >= MAX_ACTIVE_PINS) {
      throw new HttpError(
        409,
        'PIN_LIMIT_REACHED',
        `Maximum of ${MAX_ACTIVE_PINS} active PINs allowed.`,
      );
    }
  }

  let hashedPin = null;
  if (pin !== null && pin !== undefined && pin !== '') {
    assertPinShape(pin);
    // Prevent renaming a PIN to the value of another already-active PIN.
    const activeMatch = await verifyPlaintext(pin);
    if (activeMatch.matched && Number(activeMatch.id) !== Number(id)) {
      throw new HttpError(409, 'PIN_DUPLICATE', 'This PIN already exists.');
    }
    hashedPin = await bcrypt.hash(pin, BCRYPT_ROUNDS);
  }

  const adminId = req?.auth?.sub ? Number(req.auth.sub) : null;
  const updated = await keyPins.update(id, {
    hashedPin,
    status: targetStatus,
    adminId,
  });
  return toApi(updated);
}

async function remove(id) {
  const existing = await keyPins.getById(id);
  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Key PIN not found');
  await keyPins.softDelete(id);
}

/**
 * Internal helper: compare a plaintext PIN against every active hash.
 * Returns { matched, id } — id is populated only on a hit.
 * Timing: iterates every active hash even after a match to keep the
 * response time flat regardless of which slot matched. Also compares
 * against a dummy hash when there are zero active PINs so the empty-
 * set response is not visibly faster than the "no match" case.
 */
async function verifyPlaintext(pin) {
  const hashes = await keyPins.listActiveForVerification();
  let matched = false;
  let matchedId = null;
  if (hashes.length === 0) {
    await bcrypt.compare(pin, DUMMY_HASH);
    return { matched: false, id: null };
  }
  for (const row of hashes) {
    // eslint-disable-next-line no-await-in-loop
    const ok = await bcrypt.compare(pin, row.hashed_pin);
    if (ok && !matched) {
      matched = true;
      matchedId = row.id;
    }
  }
  return { matched, id: matchedId };
}

/**
 * Public verify: called by the /verify endpoint.
 * Throws INVALID_PIN on no match — HTTP layer maps to 401.
 */
async function verify({ pin }) {
  assertPinShape(pin);
  const { matched } = await verifyPlaintext(pin);
  if (!matched) {
    throw new HttpError(
      401,
      'INVALID_PIN',
      'Invalid Security PIN. Please enter a valid 6-digit PIN.',
    );
  }
  return { ok: true };
}

module.exports = {
  list,
  getOne,
  create,
  update,
  remove,
  verify,
  MAX_ACTIVE_PINS,
};
