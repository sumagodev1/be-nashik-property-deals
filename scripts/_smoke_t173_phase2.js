/**
 * T-2026-173 Phase 2 smoke test.
 *
 * Verifies requireModuleWriteOnMutation:
 *   - GET / HEAD / OPTIONS pass through without a write check.
 *   - POST / PUT / PATCH / DELETE require write access.
 *   - Admin bypasses both.
 *   - Sub-admin with write grant passes both.
 *   - Sub-admin with read grant passes GET but is 403'd on POST/PUT/DELETE.
 *   - Sub-admin without any grant is 403'd on all mutation verbs.
 *   - Unauthenticated (no req.auth) is 401'd.
 */

const { requireModuleWriteOnMutation } = require('../server/middleware/auth');

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
  const key = 'inventory_management';
  const gate = requireModuleWriteOnMutation(key);

  // Admin bypass — all verbs pass.
  for (const m of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
    const r = await run(gate, { method: m, auth: { role: 'admin', modules: [] } });
    assert(`admin bypass ${m}`, r === null);
  }

  // Sub-admin with WRITE grant — all verbs pass.
  const writeAuth = { role: 'sub_admin', modules: [{ module_key: key, access_level: 'write' }] };
  for (const m of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
    const r = await run(gate, { method: m, auth: writeAuth });
    assert(`sub_admin write-grant ${m}`, r === null);
  }

  // Sub-admin with READ grant — GET passes, mutations 403.
  const readAuth = { role: 'sub_admin', modules: [{ module_key: key, access_level: 'read' }] };
  const rGetRead = await run(gate, { method: 'GET', auth: readAuth });
  assert('sub_admin read-grant GET (pass)', rGetRead === null);
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const r = await run(gate, { method: m, auth: readAuth });
    assert(`sub_admin read-grant ${m} (403)`, r && r.status === 403 && r.code === 'FORBIDDEN_WRITE');
  }

  // Sub-admin without grant — GET 403 (this gate is write-only; the sibling
  // requireModule read-gate at the router.use above catches the GET separately
  // in real usage. In isolation here, the write-only gate lets GET through so
  // the compound gate = read-gate + write-only gate correctly 403s GET via
  // the read-gate, then 403s POST via the write-only gate).
  const noneAuth = { role: 'sub_admin', modules: [] };
  const rGetNone = await run(gate, { method: 'GET', auth: noneAuth });
  assert('sub_admin no-grant GET passes through write-only gate (read-gate catches upstream)', rGetNone === null);
  for (const m of ['POST', 'PUT', 'DELETE']) {
    const r = await run(gate, { method: m, auth: noneAuth });
    assert(`sub_admin no-grant ${m} (403)`, r && r.status === 403 && r.code === 'FORBIDDEN_WRITE');
  }

  // HEAD + OPTIONS — always pass through write-only gate.
  for (const m of ['HEAD', 'OPTIONS']) {
    const r = await run(gate, { method: m, auth: readAuth });
    assert(`${m} passes through`, r === null);
  }

  // Unauthenticated on mutation — 401 via requireModule's own auth check.
  const rUn = await run(gate, { method: 'POST' });
  assert('POST without req.auth -> 401', rUn && rUn.status === 401);

  console.log('\nT-173 Phase 2 write-gate smoke: ' + pass + ' pass / ' + fail + ' fail');
  process.exit(fail === 0 ? 0 : 1);
})();
