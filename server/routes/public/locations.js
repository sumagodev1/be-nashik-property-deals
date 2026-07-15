const express = require('express');
const Joi = require('joi');
const rateLimit = require('express-rate-limit');

const { validate } = require('../../middleware/validate');
const locationsRepo = require('../../db/queries/locations');

const router = express.Router();

// Per Nominatim's usage policy: max ~1 req/sec, must set a custom User-Agent.
// We cap typed-search at 30/min per IP — covers a normal typeahead session and
// stops a single client from hammering the upstream.
const searchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many location lookups. Slow down.' } },
});

// Tiny in-memory LRU cache: (query → { results, expiresAt }). Reset on process
// restart. Good enough for a small site; production should swap in Redis.
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const CACHE_MAX = 500;
const cache = new Map();

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    cache.delete(key);
    return null;
  }
  // Bump to most-recently-used.
  cache.delete(key);
  cache.set(key, hit);
  return hit.results;
}

function cacheSet(key, results) {
  // Don't cache empty results — a fresh query later might succeed (e.g. if a
  // different transliteration unlocks a match, or upstream had a hiccup).
  // Caching empties was poisoning the LRU and making fallback chains fail.
  if (!Array.isArray(results) || results.length === 0) return;
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { results, expiresAt: Date.now() + CACHE_TTL_MS });
}

const searchQuery = Joi.object({
  q: Joi.string().trim().min(2).max(120).required(),
  limit: Joi.number().integer().min(1).max(15).default(8),
});

// Display name we show in the dropdown: "Area City (Pincode)" when pincode is
// known, else "Area City (State)" — the fallback you specified.
function formatLabel(item) {
  const a = item.address || {};
  // Nominatim returns the locality piece under different keys depending on
  // what kind of place it matched — prefer the most specific available.
  const area =
    a.suburb ||
    a.neighbourhood ||
    a.quarter ||
    a.hamlet ||
    a.village ||
    a.town ||
    a.city_district ||
    a.locality ||
    a.road ||
    item.name ||
    '';

  const city =
    a.city ||
    a.town ||
    a.municipality ||
    a.county ||
    a.state_district ||
    '';

  const trailer = a.postcode || a.state || '';
  const head = [area, city].filter(Boolean).filter((v, i, arr) => arr.indexOf(v) === i).join(' ').trim();
  if (!head) {
    // Last-ditch: use Nominatim's full display_name truncated, plus state.
    return item.display_name?.split(',').slice(0, 2).join(',').trim() + (trailer ? ` (${trailer})` : '');
  }
  return trailer ? `${head} (${trailer})` : head;
}

function adapt(item) {
  const a = item.address || {};
  return {
    label: formatLabel(item),
    area:
      a.suburb || a.neighbourhood || a.quarter || a.hamlet || a.village ||
      a.town || a.city_district || a.locality || a.road || item.name || null,
    city: a.city || a.town || a.municipality || a.county || null,
    state: a.state || null,
    pincode: a.postcode || null,
    latitude: item.lat ? Number(item.lat) : null,
    longitude: item.lon ? Number(item.lon) : null,
  };
}

// Pincode lookup — returns the list of post-office areas that fall under a
// 6-digit Indian pincode. Free API (api.postalpincode.in), no key needed.
async function lookupByPincode(pincode, limit) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  let res;
  try {
    res = await fetch(`https://api.postalpincode.in/pincode/${pincode}`, {
      signal: ctrl.signal,
      headers: { Accept: 'application/json' },
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) return [];
  const body = await res.json();
  const entry = Array.isArray(body) ? body[0] : null;
  if (!entry || entry.Status !== 'Success' || !Array.isArray(entry.PostOffice)) return [];
  return entry.PostOffice.slice(0, limit).map((po) => ({
    label: `${po.Name} ${po.District} (${po.Pincode})`,
    area: po.Name,
    city: po.District,
    state: po.State,
    pincode: po.Pincode,
    // India Post doesn't return coords. Leaving null is fine — the embedded
    // map on the property detail page falls back to text-based search.
    latitude: null,
    longitude: null,
  }));
}

router.get('/search', searchLimiter, validate(searchQuery, 'query'), async (req, res, next) => {
  try {
    const { q, limit } = req.query;
    const cacheKey = `${q.toLowerCase()}|${limit}`;
    const cached = cacheGet(cacheKey);
    if (cached) {
      return res.json({ data: cached, cached: true });
    }

    // 6-digit pincode: route to India Post so we list every post-office area
    // under that pincode. This is what users expect when they paste in a code.
    if (/^\d{6}$/.test(q)) {
      try {
        const data = await lookupByPincode(q, limit);
        cacheSet(cacheKey, data);
        return res.json({ data, cached: false, source: 'india-post' });
      } catch (err) {
        // Soft-fail: fall through to Nominatim so the user still sees
        // *something* matching their input.
        if (err.name !== 'AbortError') {
          // eslint-disable-next-line no-console
          console.warn('[locations] India Post lookup failed:', err.message);
        }
      }
    }

    // Free-form text → Nominatim place search. Country filter `in` keeps us
    // inside India which is what the PRD targets — Nasik-first but allows
    // free-form input across the country.
    const url = new URL('https://nominatim.openstreetmap.org/search');
    url.searchParams.set('q', q);
    url.searchParams.set('countrycodes', 'in');
    url.searchParams.set('format', 'json');
    url.searchParams.set('addressdetails', '1');
    url.searchParams.set('limit', String(limit));

    // 4-second budget — Nominatim is usually < 800ms, but the network can be flaky.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);

    let upstream;
    try {
      upstream = await fetch(url.toString(), {
        signal: ctrl.signal,
        headers: {
          // Nominatim policy: identify your app + contact channel.
          'User-Agent': 'NasikPropertyDeals/1.0 (admin@nashikpropertydeals.local)',
          'Accept': 'application/json',
          'Accept-Language': 'en-IN,en',
        },
      });
    } finally {
      clearTimeout(timer);
    }

    if (!upstream.ok) {
      return res.json({ data: [], upstreamStatus: upstream.status });
    }
    const raw = await upstream.json();
    const data = Array.isArray(raw) ? raw.map(adapt).filter((r) => r.label) : [];
    cacheSet(cacheKey, data);
    res.json({ data, cached: false, source: 'nominatim' });
  } catch (err) {
    // Don't fail the user's typeahead just because upstream had a hiccup.
    // The frontend falls back to the curated list anyway.
    if (err.name === 'AbortError') {
      return res.json({ data: [], error: 'timeout' });
    }
    next(err);
  }
});

// ─── Maharashtra district → taluka → village cascade ────────────────────────
//
// These endpoints back the LocationCascade component used in every property
// / inventory / enquiry form. All three tiers read from `master_lookups`
// under the pre-existing `district` / `taluka` / `shivar` keys (see the
// dedicated queries module for the SQL). Nothing here reads the CSV — the
// CSV is imported once via scripts/import-locations.js.
//
// Path shape: /public/locations/{districts,talukas,villages}. IDs and
// government codes are both returned so a form can persist either one
// (existing code stores the govt code in inventory_properties.district
// etc; new forms should prefer the id column when we add it).

const districtRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many location lookups.' } },
});

router.get('/districts', districtRateLimiter, async (_req, res, next) => {
  try {
    const rows = await locationsRepo.listDistricts();
    res.json({
      data: rows.map((r) => ({
        id:         r.id,
        code:       r.code,
        label:      r.label,
        stateCode:  r.state_code,
        stateName:  r.state_name,
      })),
    });
  } catch (err) { next(err); }
});

const talukasQuery = Joi.object({
  districtCode: Joi.string().trim().max(20).optional(),
  districtId:   Joi.number().integer().min(1).optional(),
}).or('districtCode', 'districtId');

router.get('/talukas',
  districtRateLimiter,
  validate(talukasQuery, 'query'),
  async (req, res, next) => {
    try {
      let districtCode = req.query.districtCode;
      // If only an id was provided, resolve the district's code first
      // (single indexed lookup) so the cascade query stays a single
      // index-range scan.
      if (!districtCode && req.query.districtId) {
        const { pool } = require('../../db/pool');
        const [rows] = await pool.query(
          `SELECT code FROM master_lookups
            WHERE id = ? AND master_key = ? AND deleted_at IS NULL LIMIT 1`,
          [req.query.districtId, locationsRepo.KEYS.DISTRICT],
        );
        if (!rows[0]) return res.json({ data: [] });
        districtCode = rows[0].code;
      }
      const rows = await locationsRepo.listTalukasByDistrict(districtCode);
      res.json({
        data: rows.map((r) => ({
          id:           r.id,
          code:         r.code,
          label:        r.label,
          districtCode: r.parent_code,
        })),
      });
    } catch (err) { next(err); }
  },
);

// Villages-by-taluka: NO pagination. A single taluka is bounded (Maharashtra
// tops out under ~500 villages even for the largest urban talukas), so we
// return every village for the taluka in one shot. Search is still server-
// side (label prefix match) but does not truncate. Legacy `page` / `pageSize`
// query params from older clients are accepted and ignored to avoid a
// breaking change.
const villagesQuery = Joi.object({
  talukaCode: Joi.string().trim().max(20).optional(),
  talukaId:   Joi.number().integer().min(1).optional(),
  q:          Joi.string().trim().max(100).allow('').default(''),
  page:       Joi.any().optional(),      // ignored — kept for back-compat
  pageSize:   Joi.any().optional(),      // ignored — kept for back-compat
}).or('talukaCode', 'talukaId');

router.get('/villages',
  districtRateLimiter,
  validate(villagesQuery, 'query'),
  async (req, res, next) => {
    try {
      let talukaCode = req.query.talukaCode;
      if (!talukaCode && req.query.talukaId) {
        const { pool } = require('../../db/pool');
        const [rows] = await pool.query(
          `SELECT code FROM master_lookups
            WHERE id = ? AND master_key = ? AND deleted_at IS NULL LIMIT 1`,
          [req.query.talukaId, locationsRepo.KEYS.TALUKA],
        );
        if (!rows[0]) return res.json({ data: [], total: 0 });
        talukaCode = rows[0].code;
      }
      const { rows, total } = await locationsRepo.listVillagesByTaluka(
        talukaCode,
        { search: req.query.q },
      );
      res.json({
        data: rows.map((r) => ({
          id:         r.id,
          code:       r.code,
          label:      r.label,
          talukaCode: r.parent_code,
          pincode:    r.pincode,
        })),
        total,
      });
    } catch (err) { next(err); }
  },
);

const pincodeParams = Joi.object({
  pincode: Joi.string().pattern(/^\d{6}$/).required(),
});

router.get('/by-pincode/:pincode',
  districtRateLimiter,
  validate(pincodeParams, 'params'),
  async (req, res, next) => {
    try {
      const rows = await locationsRepo.findVillagesByPincode(req.params.pincode);
      res.json({
        data: rows.map((r) => ({
          villageId:     r.id,
          villageCode:   r.code,
          villageLabel:  r.label,
          talukaCode:    r.taluka_code,
          talukaLabel:   r.taluka_label,
          districtCode:  r.district_code,
          districtLabel: r.district_label,
          pincode:       r.pincode,
        })),
      });
    } catch (err) { next(err); }
  },
);

const labelsQuery = Joi.object({
  key:   Joi.string().valid('district', 'taluka', 'shivar').required(),
  codes: Joi.string().allow('').default(''),
});

router.get('/labels',
  districtRateLimiter,
  validate(labelsQuery, 'query'),
  async (req, res, next) => {
    try {
      const codes = req.query.codes
        ? req.query.codes.split(',').map((c) => c.trim()).filter(Boolean)
        : [];
      const rows = await locationsRepo.labelsForCodes(req.query.key, codes);
      const map = {};
      for (const r of rows) map[r.code] = r.label;
      res.json({ data: map });
    } catch (err) { next(err); }
  },
);

const villageContextParams = Joi.object({
  code: Joi.string().trim().max(20).required(),
});

router.get('/villages/:code/context',
  districtRateLimiter,
  validate(villageContextParams, 'params'),
  async (req, res, next) => {
    try {
      const row = await locationsRepo.resolveVillageContext(req.params.code);
      if (!row) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Village not found' } });
      res.json({
        village: {
          id: row.village_id, code: row.village_code, label: row.village_label, pincode: row.pincode,
        },
        taluka: {
          id: row.taluka_id, code: row.taluka_code, label: row.taluka_label,
        },
        district: {
          id: row.district_id, code: row.district_code, label: row.district_label,
          stateCode: row.state_code, stateName: row.state_name,
        },
      });
    } catch (err) { next(err); }
  },
);

// Taluka → parent district resolver. Same shape as the village-context
// endpoint but sans the village leaf. Backs the LocationCascade Edit-mode
// backfill for the rare "record has talukaCode but no districtCode" case.
const talukaContextParams = Joi.object({
  code: Joi.string().trim().max(20).required(),
});

router.get('/talukas/:code/context',
  districtRateLimiter,
  validate(talukaContextParams, 'params'),
  async (req, res, next) => {
    try {
      const row = await locationsRepo.resolveTalukaContext(req.params.code);
      if (!row) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Taluka not found' } });
      res.json({
        taluka: {
          id: row.taluka_id, code: row.taluka_code, label: row.taluka_label,
        },
        district: {
          id: row.district_id, code: row.district_code, label: row.district_label,
          stateCode: row.state_code, stateName: row.state_name,
        },
      });
    } catch (err) { next(err); }
  },
);

module.exports = router;
