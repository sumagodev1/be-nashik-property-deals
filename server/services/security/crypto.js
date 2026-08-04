/**
 * Symmetric encryption helper for at-rest secrets (currently only the
 * SMTP password on email_settings).
 *
 * Algorithm: AES-256-GCM.
 *   - 32-byte key derived from env `EMAIL_ENCRYPTION_KEY` (raw base64/hex)
 *     if provided, otherwise deterministically derived from `JWT_SECRET`
 *     via HKDF-SHA256 so the app boots on existing installations without
 *     a new env var. Rotating JWT_SECRET therefore invalidates stored
 *     ciphertexts — document this alongside JWT rotation procedures.
 *   - 12-byte random IV per encrypt (GCM standard).
 *   - 16-byte auth tag verifies integrity on decrypt; a tampered
 *     ciphertext throws instead of silently returning garbage.
 *
 * Storage format: `"<iv_b64>:<tag_b64>:<ct_b64>"`. Single delimited
 * string so it fits in a TEXT column and is grep-friendly in dumps.
 */

const crypto = require('crypto');

const ALG = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

let cachedKey = null;

function deriveKey() {
  if (cachedKey) return cachedKey;

  const raw = process.env.EMAIL_ENCRYPTION_KEY;
  if (raw && raw.trim()) {
    const trimmed = raw.trim();
    // Accept either 64-char hex or base64 (44 chars for 32 bytes).
    let buf;
    if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
      buf = Buffer.from(trimmed, 'hex');
    } else {
      try {
        buf = Buffer.from(trimmed, 'base64');
      } catch (e) {
        throw new Error('EMAIL_ENCRYPTION_KEY must be 32 bytes of hex or base64.');
      }
    }
    if (buf.length !== KEY_BYTES) {
      throw new Error(`EMAIL_ENCRYPTION_KEY must decode to exactly ${KEY_BYTES} bytes (got ${buf.length}).`);
    }
    cachedKey = buf;
    return cachedKey;
  }

  // Fallback: derive from an existing app secret so the app doesn't
  // require a new env var on existing deployments. HKDF gives us a
  // proper 32-byte key regardless of secret length. Salt + info are
  // constants so the derivation is deterministic — rotating the source
  // secret invalidates every stored ciphertext.
  const seed = process.env.JWT_ACCESS_SECRET
    || process.env.JWT_SECRET
    || process.env.JWT_REFRESH_SECRET;
  if (!seed) {
    throw new Error(
      'Cannot derive email encryption key: set EMAIL_ENCRYPTION_KEY (32 bytes hex/base64), or ensure JWT_ACCESS_SECRET is set in env.',
    );
  }
  cachedKey = crypto.hkdfSync(
    'sha256',
    Buffer.from(seed, 'utf8'),
    Buffer.from('npd-email-settings-v1', 'utf8'), // salt
    Buffer.from('smtp-password', 'utf8'),         // info
    KEY_BYTES,
  );
  cachedKey = Buffer.from(cachedKey); // hkdfSync returns ArrayBuffer on some Node versions
  return cachedKey;
}

/**
 * Encrypt a plaintext secret. Returns the delimited storage string.
 * Returns null when the input is null / empty (matches how the DB
 * column stores "no password").
 */
function encryptSecret(plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === '') return null;
  if (typeof plaintext !== 'string') {
    throw new Error('encryptSecret expects a string.');
  }
  const key = deriveKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALG, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

/**
 * Decrypt a value produced by encryptSecret. Throws on tamper/format error.
 * Returns null when input is null/empty (mirrors encryptSecret).
 */
function decryptSecret(stored) {
  if (stored === null || stored === undefined || stored === '') return null;
  if (typeof stored !== 'string') {
    throw new Error('decryptSecret expects a string.');
  }
  const parts = stored.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid ciphertext format (expected iv:tag:ct).');
  }
  const [ivB64, tagB64, ctB64] = parts;
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const ct = Buffer.from(ctB64, 'base64');
  if (iv.length !== IV_BYTES) throw new Error('Invalid IV length.');
  if (tag.length !== TAG_BYTES) throw new Error('Invalid tag length.');
  const key = deriveKey();
  const decipher = crypto.createDecipheriv(ALG, key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf8');
}

module.exports = { encryptSecret, decryptSecret };
