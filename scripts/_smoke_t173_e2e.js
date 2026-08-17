/**
 * T-2026-173 end-to-end BE integration smoke.
 *
 * Simulates the full auth chain that a signed-in sub-admin would go through:
 *   1. login.js#login builds a JWT payload with the new modules shape
 *      { module_key, access_level }.
 *   2. requireAuth verifies the JWT and puts it on req.auth.
 *   3. Per-router requireModule + requireModuleWriteOnMutation chain gates
 *      the request based on the grant.
 *
 * Verifies:
 *   - A read-only sub-admin can hit any GET on a granted module.
 *   - The same sub-admin gets 403 FORBIDDEN_WRITE on POST/PUT/DELETE.
 *   - A write sub-admin passes both.
 *   - An admin bypasses both regardless of grants.
 *   - Legacy pre-T-173 JWT (plain string modules array) still passes both.
 */

require('dotenv').config();

const jwt = require('jsonwebtoken');
const {
  requireAuth,
  requireModule,
  requireModuleWriteOnMutation,
} = require('../server/middleware/auth');
const { MODULES } = require('../server/constants/modules');

let pass = 0;
let fail = 0;

function assert(name, cond) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.error('FAIL ' + name); }
}

function makeReq({ token, method = 'GET' }) {
  return {
    method,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  };
}

async function runChain(middlewares, req) {
  for (const mw of middlewares) {
    const err = await new Promise((resolve) => mw(req, {}, (e) => resolve(e || null)));
    if (err) return err;
  }
  return null;
}

(async () => {
  const secret = process.env.JWT_ACCESS_SECRET || 'test-secret-do-not-use-in-prod';
  process.env.JWT_ACCESS_SECRET = secret;

  const KEY = MODULES.INVENTORY_MANAGEMENT;

  // Fake JWTs for the four subject profiles we care about.
  const adminToken = jwt.sign({ sub: 1, role: 'admin', modules: [] }, secret, { expiresIn: '5m' });
  const subWriteToken = jwt.sign(
    { sub: 2, role: 'sub_admin', modules: [{ module_key: KEY, access_level: 'write' }] },
    secret, { expiresIn: '5m' },
  );
  const subReadToken = jwt.sign(
    { sub: 3, role: 'sub_admin', modules: [{ module_key: KEY, access_level: 'read' }] },
    secret, { expiresIn: '5m' },
  );
  const subNoneToken = jwt.sign(
    { sub: 4, role: 'sub_admin', modules: [] },
    secret, { expiresIn: '5m' },
  );
  const subLegacyToken = jwt.sign(
    { sub: 5, role: 'sub_admin', modules: [KEY] }, // pre-T-173 string array
    secret, { expiresIn: '5m' },
  );

  // Simulate the router.use chain that inventory-properties.js sets up:
  //   requireAuth + requireModule(KEY) + requireModuleWriteOnMutation(KEY)
  const chain = [
    requireAuth,
    requireModule(KEY),
    requireModuleWriteOnMutation(KEY),
  ];

  // (1) admin — all verbs pass.
  for (const m of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
    const r = await runChain(chain, makeReq({ token: adminToken, method: m }));
    assert(`admin ${m} allowed`, r === null);
  }

  // (2) sub_admin with WRITE — all verbs pass.
  for (const m of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
    const r = await runChain(chain, makeReq({ token: subWriteToken, method: m }));
    assert(`sub_admin write ${m} allowed`, r === null);
  }

  // (3) sub_admin with READ — GET passes, mutations 403.
  const rGetR = await runChain(chain, makeReq({ token: subReadToken, method: 'GET' }));
  assert('sub_admin read GET allowed', rGetR === null);
  for (const m of ['POST', 'PUT', 'DELETE']) {
    const r = await runChain(chain, makeReq({ token: subReadToken, method: m }));
    assert(`sub_admin read ${m} rejected 403`, r && r.status === 403 && r.code === 'FORBIDDEN_WRITE');
  }

  // (4) sub_admin with NO grant — GET 403 (via router.use requireModule),
  // mutations also 403 (short-circuits at read-gate).
  for (const m of ['GET', 'POST', 'DELETE']) {
    const r = await runChain(chain, makeReq({ token: subNoneToken, method: m }));
    assert(`sub_admin no-grant ${m} rejected 403`, r && r.status === 403 && r.code === 'FORBIDDEN');
  }

  // (5) LEGACY pre-T-173 JWT — plain string modules. Should still work.
  for (const m of ['GET', 'POST', 'DELETE']) {
    const r = await runChain(chain, makeReq({ token: subLegacyToken, method: m }));
    assert(`legacy string-array JWT ${m} allowed`, r === null);
  }

  // (6) No token — 401.
  const rNoToken = await runChain(chain, makeReq({ method: 'GET' }));
  assert('no token -> 401', rNoToken && rNoToken.status === 401);

  console.log('\nT-173 end-to-end smoke: ' + pass + ' pass / ' + fail + ' fail');
  process.exit(fail === 0 ? 0 : 1);
})();
