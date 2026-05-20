const { HttpError } = require('../../middleware/errors');

const SITEVERIFY_URL = 'https://www.google.com/recaptcha/api/siteverify';
const TIMEOUT_MS = 5000;

let bypassWarned = false;

function tokenPrefix(token) {
  if (!token) return '(none)';
  return `${String(token).slice(0, 8)}…`;
}

async function verifyCaptcha(token, remoteIp) {
  const secret = process.env.RECAPTCHA_SECRET_KEY || '';
  const required = process.env.RECAPTCHA_REQUIRED === 'true';

  if (!required || !secret) {
    if (!bypassWarned) {
      bypassWarned = true;
      // eslint-disable-next-line no-console
      console.warn(
        '[captcha] verification BYPASSED — set RECAPTCHA_REQUIRED=true and RECAPTCHA_SECRET_KEY to enforce.',
      );
    }
    return true;
  }

  if (!token) {
    throw new HttpError(400, 'CAPTCHA_REQUIRED', 'Captcha is required.');
  }

  const body = new URLSearchParams({ secret, response: token });
  if (remoteIp) body.append('remoteip', remoteIp);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let data;
  try {
    const res = await fetch(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: controller.signal,
    });
    data = await res.json();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[captcha] siteverify unreachable', { token: tokenPrefix(token), err: err.message });
    throw new HttpError(503, 'CAPTCHA_UNAVAILABLE', 'Captcha service is unreachable. Please retry.');
  } finally {
    clearTimeout(timer);
  }

  if (data && data.success === true) return true;

  // eslint-disable-next-line no-console
  console.warn('[captcha] siteverify rejected', {
    token: tokenPrefix(token),
    codes: (data && data['error-codes']) || [],
  });
  throw new HttpError(403, 'CAPTCHA_INVALID', 'Captcha verification failed. Please try again.');
}

module.exports = { verifyCaptcha };
