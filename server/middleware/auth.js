const jwt = require('jsonwebtoken');
const { HttpError } = require('./errors');

function extractBearer(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length).trim();
}

function requireAuth(req, res, next) {
  const token = extractBearer(req);
  if (!token) return next(new HttpError(401, 'UNAUTHENTICATED', 'Authentication required'));

  try {
    const payload = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
    req.auth = payload;
    next();
  } catch (err) {
    next(new HttpError(401, 'INVALID_TOKEN', 'Invalid or expired token'));
  }
}

function requireRole(...allowed) {
  return (req, res, next) => {
    if (!req.auth) return next(new HttpError(401, 'UNAUTHENTICATED', 'Authentication required'));
    if (!allowed.includes(req.auth.role)) return next(new HttpError(403, 'FORBIDDEN', 'Insufficient permissions'));
    next();
  };
}

// T-2026-173: sub-admin module grants are now { module_key, access_level }
// objects instead of plain strings. Middleware supports both shapes so a
// stale JWT issued before Phase 1 deploy (plain string array in payload) is
// treated as 'write' grants for backward compat — matches the migration 110
// DEFAULT 'write' behavior for legacy rows.
//
// T-2026-174: the INVENTORY_MANAGEMENT umbrella key was split into five
// discrete keys (INVENTORY_DASHBOARD, INVENTORY_PROPERTIES,
// ENQUIRY_DASHBOARD, ENQUIRY_PROPERTIES, AGREEMENT_REMINDERS). Existing
// SQL rows are fanned out into all five via migration 111 — so a re-login
// after deploy mints a JWT that carries the discrete keys directly. But
// JWTs already in flight (issued BEFORE the deploy) still carry the
// umbrella 'inventory_management' key, and would fail per-key hasGrant()
// checks against the five new keys. To avoid logging every in-flight
// sub-admin out mid-session, hasGrant() now honours the legacy umbrella
// key as an implicit grant on all five new keys. This mirrors the same
// non-regression pattern T-173 used for legacy plain-string arrays.
const LEGACY_UMBRELLA_ALIASES = Object.freeze({
  inventory_management: [
    'inventory_dashboard',
    'inventory_properties',
    'enquiry_dashboard',
    'enquiry_properties',
    'agreement_reminders',
  ],
});

function entryImpliesKey(entryKey, key) {
  if (entryKey === key) return true;
  const aliased = LEGACY_UMBRELLA_ALIASES[entryKey];
  if (aliased && aliased.includes(key)) return true;
  return false;
}

// hasGrant(modules, key, requiredLevel) — returns true when:
//   - modules is an array,
//   - AND some entry matches `key` (either exactly OR via a legacy
//     umbrella alias per LEGACY_UMBRELLA_ALIASES above),
//   - AND (requiredLevel === 'read'  → any entry passes: read OR write),
//   - AND (requiredLevel === 'write' → only 'write' entries pass).
//
// Legacy plain-string entries (e.g. 'inventory_management') are treated as
// implicit 'write' — they pass both read and write checks.
function hasGrant(modules, key, requiredLevel) {
  if (!Array.isArray(modules)) return false;
  for (const entry of modules) {
    // Legacy shape: plain string module key. Implicit write per compat rule.
    if (typeof entry === 'string') {
      if (entryImpliesKey(entry, key)) return true;
      continue;
    }
    // New shape: { module_key, access_level }.
    if (entry && entryImpliesKey(entry.module_key, key)) {
      if (requiredLevel === 'write') return entry.access_level === 'write';
      // 'read' — either level satisfies (write implies read).
      return entry.access_level === 'read' || entry.access_level === 'write';
    }
  }
  return false;
}

// Backward-compat signature:
//   requireModule(moduleKey)
//     → old callers get default access='read'.
//   requireModule(moduleKey, 'read' | 'write')
//     → new callers ask for the exact level.
// Admin role always bypasses. Sub-admin role checks the grant shape above.
function requireModule(moduleKey, access = 'read') {
  const requiredLevel = access === 'write' ? 'write' : 'read';
  return (req, res, next) => {
    if (!req.auth) return next(new HttpError(401, 'UNAUTHENTICATED', 'Authentication required'));
    // Administrator role bypasses all module + access checks — T-173 §10.
    if (req.auth.role === 'admin') return next();
    if (req.auth.role !== 'sub_admin') {
      return next(new HttpError(403, 'FORBIDDEN', 'Module access denied'));
    }
    if (!hasGrant(req.auth.modules, moduleKey, requiredLevel)) {
      const code = requiredLevel === 'write' ? 'FORBIDDEN_WRITE' : 'FORBIDDEN';
      const msg = requiredLevel === 'write'
        ? 'Module write access denied'
        : 'Module access denied';
      return next(new HttpError(403, code, msg));
    }
    next();
  };
}

// Sugar helpers so route wiring reads clearly. Both admin routes and
// per-endpoint gating in Phase 2 use these instead of the raw two-arg form.
function requireModuleRead(moduleKey) {
  return requireModule(moduleKey, 'read');
}

function requireModuleWrite(moduleKey) {
  return requireModule(moduleKey, 'write');
}

// T-2026-173 Phase 2: per-router method-scoped write gate.
//
// Every existing per-module router.use(requireAuth, requireModule(KEY)) is
// preserved unchanged — it now gates the router at the READ level (default).
// Adding requireModuleWriteOnMutation(KEY) as the SECOND router.use() call
// tightens the gate: every POST/PUT/PATCH/DELETE additionally requires a
// 'write' grant, while GET/HEAD/OPTIONS pass through untouched.
//
// This is intentionally applied at the router.use level (not per-handler)
// so a new endpoint added to a router is gated by default and cannot
// accidentally slip through. Adding a NEW read-only mutation-verb endpoint
// requires an explicit exception (rare — most POST/PUT/DELETE really do
// modify data).
//
// Admin bypass and legacy JWT compat inherit from requireModule.
function requireModuleWriteOnMutation(moduleKey) {
  const gate = requireModuleWrite(moduleKey);
  return (req, res, next) => {
    const m = (req.method || '').toUpperCase();
    if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return next();
    return gate(req, res, next);
  };
}

module.exports = {
  requireAuth,
  requireRole,
  requireModule,
  requireModuleRead,
  requireModuleWrite,
  requireModuleWriteOnMutation,
  // Exported for tests + for any service that needs to check a grant
  // without going through the middleware chain (rare — most consumers use
  // requireModule at the route boundary instead).
  hasGrant,
};
