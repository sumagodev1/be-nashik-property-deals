/**
 * T-2026-173 Phase 1 smoke test.
 *
 * Verifies:
 *   1. requireModule(key) with only auth.role='admin' -> passes regardless of modules.
 *   2. sub_admin with { module_key:'crm_management', access_level:'write' }
 *      passes requireModule('crm_management', 'read') AND
 *      requireModule('crm_management', 'write').
 *   3. sub_admin with { module_key:'crm_management', access_level:'read' }
 *      passes requireModule('crm_management', 'read') BUT is REJECTED by
 *      requireModule('crm_management', 'write') with 403 FORBIDDEN_WRITE.
 *   4. sub_admin with NO grant for 'crm_management' is REJECTED by both
 *      requireModule('crm_management', 'read') and 'write' with 403 FORBIDDEN.
 *   5. sub_admin with LEGACY plain-string grants (pre-T-173 JWT) still passes
 *      both read and write (backward-compat).
 *   6. Unauthenticated request (no req.auth) is REJECTED with 401.
 *   7. non-admin, non-sub_admin role is REJECTED with 403.
 *   8. hasGrant('read') for a write-grant returns true (write implies read).
 */

const { requireModule, hasGrant } = require('../server/middleware/auth');

let pass = 0;
let fail = 0;

function assert(name, cond) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.error('FAIL ' + name); }
}

function run(mw, req) {
  return new Promise((resolve) => {
    mw(req, {}, (err) => resolve(err || null));
  });
}

(async () => {
  // (1) admin bypass — grants irrelevant
  const r1 = await run(requireModule('crm_management'), { auth: { role: 'admin', modules: [] } });
  assert('T1  admin bypasses requireModule read', r1 === null);
  const r1w = await run(requireModule('crm_management', 'write'), { auth: { role: 'admin', modules: [] } });
  assert('T1w admin bypasses requireModule write', r1w === null);

  // (2) sub_admin with write grant passes both read + write
  const writeAuth = { auth: { role: 'sub_admin', modules: [{ module_key: 'crm_management', access_level: 'write' }] } };
  const r2r = await run(requireModule('crm_management', 'read'), writeAuth);
  assert('T2r sub_admin write-grant satisfies read', r2r === null);
  const r2w = await run(requireModule('crm_management', 'write'), writeAuth);
  assert('T2w sub_admin write-grant satisfies write', r2w === null);

  // (3) sub_admin with read-only grant: read passes, write rejected
  const readAuth = { auth: { role: 'sub_admin', modules: [{ module_key: 'crm_management', access_level: 'read' }] } };
  const r3r = await run(requireModule('crm_management', 'read'), readAuth);
  assert('T3r sub_admin read-grant satisfies read', r3r === null);
  const r3w = await run(requireModule('crm_management', 'write'), readAuth);
  assert('T3w sub_admin read-grant REJECTED on write', r3w && r3w.status === 403 && r3w.code === 'FORBIDDEN_WRITE');

  // (4) sub_admin with NO grant for module: both rejected
  const noneAuth = { auth: { role: 'sub_admin', modules: [{ module_key: 'inventory_management', access_level: 'write' }] } };
  const r4r = await run(requireModule('crm_management', 'read'), noneAuth);
  assert('T4r sub_admin without grant REJECTED on read', r4r && r4r.status === 403 && r4r.code === 'FORBIDDEN');
  const r4w = await run(requireModule('crm_management', 'write'), noneAuth);
  assert('T4w sub_admin without grant REJECTED on write', r4w && r4w.status === 403 && r4w.code === 'FORBIDDEN_WRITE');

  // (5) legacy plain-string JWT (pre-T-173) works
  const legacyAuth = { auth: { role: 'sub_admin', modules: ['crm_management', 'inventory_management'] } };
  const r5r = await run(requireModule('crm_management', 'read'), legacyAuth);
  assert('T5r legacy plain-string satisfies read', r5r === null);
  const r5w = await run(requireModule('crm_management', 'write'), legacyAuth);
  assert('T5w legacy plain-string implicit-write satisfies write', r5w === null);

  // (6) unauthenticated
  const r6 = await run(requireModule('crm_management'), {});
  assert('T6  no req.auth -> 401', r6 && r6.status === 401);

  // (7) seller role — rejected
  const sellerAuth = { auth: { role: 'seller', modules: [] } };
  const r7 = await run(requireModule('crm_management'), sellerAuth);
  assert('T7  seller role -> 403 FORBIDDEN', r7 && r7.status === 403);

  // (8) hasGrant direct tests
  assert('T8a hasGrant write for write-grant', hasGrant([{ module_key: 'x', access_level: 'write' }], 'x', 'write') === true);
  assert('T8b hasGrant read  for write-grant', hasGrant([{ module_key: 'x', access_level: 'write' }], 'x', 'read')  === true);
  assert('T8c hasGrant read  for read-grant',  hasGrant([{ module_key: 'x', access_level: 'read'  }], 'x', 'read')  === true);
  assert('T8d hasGrant write for read-grant REJECT', hasGrant([{ module_key: 'x', access_level: 'read' }], 'x', 'write') === false);
  assert('T8e hasGrant returns false for missing key', hasGrant([{ module_key: 'y', access_level: 'write' }], 'x', 'read') === false);
  assert('T8f hasGrant with non-array returns false', hasGrant(null, 'x', 'read') === false);
  assert('T8g hasGrant mixed shape (legacy string + object)', hasGrant(['a', { module_key: 'b', access_level: 'read' }], 'a', 'write') === true);
  assert('T8h hasGrant mixed shape read on object read-grant', hasGrant(['a', { module_key: 'b', access_level: 'read' }], 'b', 'read') === true);
  assert('T8i hasGrant mixed shape write on object read-grant REJECT', hasGrant(['a', { module_key: 'b', access_level: 'read' }], 'b', 'write') === false);

  console.log('\nT-173 Phase 1 middleware smoke: ' + pass + ' pass / ' + fail + ' fail');
  process.exit(fail === 0 ? 0 : 1);
})();
