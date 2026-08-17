/**
 * T-2026-173-B smoke: previously admin-only surfaces promoted to sub-admin-
 * grantable modules.
 *
 * The four keys under test:
 *   - MODULES.SUB_ADMIN_MANAGEMENT (was requireRole('admin') on
 *     server/routes/admin/sub-admins.js)
 *   - MODULES.AUDIT_LOG (was requireRole('admin') on audit-log.js)
 *   - MODULES.REPORTS (FE-only surface; key exists so FE guard works)
 *   - MODULES.CONVERSION_TABLE (FE-only surface; key exists so FE guard works)
 *
 * Verifies:
 *   T1 -- Administrator bypasses even without an explicit grant (the whole
 *        point of the requireModule role==='admin' short-circuit -- this is
 *        the guarantee the user called out in item #10 of the original spec).
 *   T2 -- Sub-admin without the grant is rejected on GET (403 FORBIDDEN).
 *   T3 -- Sub-admin with the grant at read-level passes GET but is rejected
 *        on POST/PUT/DELETE (403 FORBIDDEN_WRITE).
 *   T4 -- Sub-admin with the grant at write-level passes both GET + POST.
 *   T5 -- No sub-admin previously in the system has these grants -- pre-T-B
 *        JWTs in flight (whose modules array excludes these 4 keys entirely)
 *        continue to work for all their OTHER grants (regression guard) and
 *        continue to be rejected on the new keys (no silent escalation).
 *
 * Uses the same in-process middleware runner as _smoke_t173_e2e.js so no
 * HTTP server is needed.
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

  const NEW_KEYS = [
    MODULES.SUB_ADMIN_MANAGEMENT,
    MODULES.AUDIT_LOG,
    MODULES.REPORTS,
    MODULES.CONVERSION_TABLE,
  ];

  // Sanity check -- the four keys must be defined (regression guard against
  // the FE registry drifting out of sync with the BE registry).
  for (const k of NEW_KEYS) {
    assert(`REG key ${k} defined`, typeof k === 'string' && k.length > 0);
  }

  const adminToken = jwt.sign({ sub: 1, role: 'admin', modules: [] }, secret, { expiresIn: '5m' });
  // Pre-T-B sub-admin token: modules array of previously granted keys ONLY,
  // NO entry for the 4 new keys. Simulates the migration state -- every
  // existing sub-admin has zero grants on the new keys.
  const legacySubToken = jwt.sign(
    {
      sub: 42,
      role: 'sub_admin',
      modules: [
        { module_key: MODULES.INVENTORY_MANAGEMENT, access_level: 'write' },
        { module_key: MODULES.WEBSITE_PROPERTY_MANAGEMENT, access_level: 'read' },
      ],
    },
    secret,
    { expiresIn: '5m' },
  );

  // Sub-admin with each of the 4 new keys granted at read + write.
  function subWithGrant(key, level) {
    return jwt.sign(
      {
        sub: 43,
        role: 'sub_admin',
        modules: [{ module_key: key, access_level: level }],
      },
      secret,
      { expiresIn: '5m' },
    );
  }

  for (const KEY of NEW_KEYS) {
    // T1 -- admin bypass (GET + POST).
    {
      const chain = [requireAuth, requireModule(KEY), requireModuleWriteOnMutation(KEY)];
      const r1 = await runChain(chain, makeReq({ token: adminToken, method: 'GET' }));
      assert(`T1 admin bypass GET ${KEY}`, r1 === null);
      const r2 = await runChain(chain, makeReq({ token: adminToken, method: 'POST' }));
      assert(`T1 admin bypass POST ${KEY}`, r2 === null);
    }

    // T2 -- sub-admin without any grant (legacy pre-T-B JWT, only holds
    // inventory + website grants) is rejected on GET AND on POST.
    {
      const chain = [requireAuth, requireModule(KEY), requireModuleWriteOnMutation(KEY)];
      const r1 = await runChain(chain, makeReq({ token: legacySubToken, method: 'GET' }));
      assert(`T2 legacy sub-admin no-grant GET ${KEY} rejected`, r1 && r1.status === 403);
      const r2 = await runChain(chain, makeReq({ token: legacySubToken, method: 'POST' }));
      assert(`T2 legacy sub-admin no-grant POST ${KEY} rejected`, r2 && r2.status === 403);
    }

    // T3 -- sub-admin with the key granted at read-level passes GET but
    // is rejected on POST/PUT/DELETE.
    {
      const readToken = subWithGrant(KEY, 'read');
      const chain = [requireAuth, requireModule(KEY), requireModuleWriteOnMutation(KEY)];
      const r1 = await runChain(chain, makeReq({ token: readToken, method: 'GET' }));
      assert(`T3 sub-admin read-grant GET ${KEY} passes`, r1 === null);
      const r2 = await runChain(chain, makeReq({ token: readToken, method: 'POST' }));
      assert(`T3 sub-admin read-grant POST ${KEY} rejected`, r2 && r2.status === 403);
      const r3 = await runChain(chain, makeReq({ token: readToken, method: 'DELETE' }));
      assert(`T3 sub-admin read-grant DELETE ${KEY} rejected`, r3 && r3.status === 403);
    }

    // T4 -- sub-admin with the key granted at write-level passes both.
    {
      const writeToken = subWithGrant(KEY, 'write');
      const chain = [requireAuth, requireModule(KEY), requireModuleWriteOnMutation(KEY)];
      const r1 = await runChain(chain, makeReq({ token: writeToken, method: 'GET' }));
      assert(`T4 sub-admin write-grant GET ${KEY} passes`, r1 === null);
      const r2 = await runChain(chain, makeReq({ token: writeToken, method: 'POST' }));
      assert(`T4 sub-admin write-grant POST ${KEY} passes`, r2 === null);
      const r3 = await runChain(chain, makeReq({ token: writeToken, method: 'DELETE' }));
      assert(`T4 sub-admin write-grant DELETE ${KEY} passes`, r3 === null);
    }
  }

  // T5 -- regression guard: the legacy JWT still passes on its EXISTING
  // grants (inventory + website), proving no unrelated permissions were
  // broken by adding the 4 new keys.
  {
    const chain = [
      requireAuth,
      requireModule(MODULES.INVENTORY_MANAGEMENT),
      requireModuleWriteOnMutation(MODULES.INVENTORY_MANAGEMENT),
    ];
    const rGet = await runChain(chain, makeReq({ token: legacySubToken, method: 'GET' }));
    assert('T5 legacy JWT still passes GET inventory (regression)', rGet === null);
    const rPost = await runChain(chain, makeReq({ token: legacySubToken, method: 'POST' }));
    assert('T5 legacy JWT still passes POST inventory (write grant intact)', rPost === null);
  }
  {
    // Website is read-level only in the legacy JWT -- GET passes, POST rejected.
    const chain = [
      requireAuth,
      requireModule(MODULES.WEBSITE_PROPERTY_MANAGEMENT),
      requireModuleWriteOnMutation(MODULES.WEBSITE_PROPERTY_MANAGEMENT),
    ];
    const rGet = await runChain(chain, makeReq({ token: legacySubToken, method: 'GET' }));
    assert('T5 legacy JWT read website GET passes (regression)', rGet === null);
    const rPost = await runChain(chain, makeReq({ token: legacySubToken, method: 'POST' }));
    assert('T5 legacy JWT read website POST rejected (regression)', rPost && rPost.status === 403);
  }

  console.log(`\nT-173-B admin-only-promoted smoke: ${pass} pass / ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
})();
