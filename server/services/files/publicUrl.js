// Centralized helper for converting stored relative paths (e.g.
// "/uploads/public/website/abc.png") into absolute URLs that the browser can
// hit directly on the backend origin. PUBLIC_BASE_URL is the deployed backend
// origin (no trailing slash); when unset, paths stay relative, which is fine
// for same-origin dev or behind a single-domain reverse proxy.

const BASE = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');

const PUBLIC_URL_PREFIX = `${BASE}/uploads/public`;

function toAbsolutePublicUrl(maybeRelative) {
  if (!maybeRelative) return maybeRelative;
  if (/^https?:\/\//i.test(maybeRelative)) return maybeRelative;
  if (maybeRelative.startsWith('/')) return `${BASE}${maybeRelative}`;
  return `${BASE}/${maybeRelative}`;
}

module.exports = { PUBLIC_URL_PREFIX, toAbsolutePublicUrl };
