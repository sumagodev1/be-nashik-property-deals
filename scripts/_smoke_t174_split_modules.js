/**
 * T-2026-174 -- Inventory module split smoke.
 *
 * Verifies that:
 *   (T1) A legacy pre-T-174 sub-admin holding ONLY the umbrella
 *        `inventory_management` grant (either in the JWT payload as a
 *        legacy string entry OR as an { module_key, access_level } object)
 *        still passes hasGrant() checks against ALL FIVE new discrete
 *        keys -- INVENTORY_DASHBOARD, INVENTORY_PROPERTIES,
 *        ENQUIRY_DASHBOARD, ENQUIRY_PROPERTIES, AGREEMENT_REMINDERS --
 *        via the LEGACY_UMBRELLA_ALIASES compat table in
 *        middleware/auth.js. (Sanity-checks the fan-out is transparent
 *        for in-flight JWTs.)
 *
 *   (T2) A NEW T-174 sub-admin granted ONLY ENQUIRY_DASHBOARD:
 *        - PASSES requireModule(ENQUIRY_DASHBOARD) on GET
 *        - 403s on requireModule(INVENTORY_PROPERTIES) on GET/POST/DELETE
 *          (proving the split is a real enforcement boundary, not just a
 *          UI label change).
 *
 *   (T3) A NEW T-174 sub-admin granted ONLY INVENTORY_PROPERTIES with
 *        access_level='read' can hit GET but not POST/PUT/DELETE via the
 *        end-to-end auth chain that inventory-properties.js sets up.
 *
 *   (T4) An Administrator bypasses every check for every one of the 5
 *        new keys on every HTTP verb.
 *
 *   (T5) A NEW sub-admin granted the umbrella AGREEMENT_REMINDERS via
 *        the new-shape object is treated exactly like they had been
 *        granted it directly (no aliasing weirdness for direct-grant
 *        paths).
 *
 *   (T6) The umbrella INVENTORY_MANAGEMENT key still resolves as itself
 *        when explicitly checked (backward compat for any callsite that
 *        still references the umbrella key by name -- e.g. legacy
 *        audit-log queries or smoke tests).
 */

require('dotenv').config();

const jwt = require('jsonwebtoken');
const {
  requireAuth,
  requireModule,
  requireModuleWriteOnMutation,
  hasGrant,
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
    MODULES.INVENTORY_DASHBOARD,
    MODULES.INVENTORY_PROPERTIES,
    MODULES.ENQUIRY_DASHBOARD,
    MODULES.ENQUIRY_PROPERTIES,
    MODULES.AGREEMENT_REMINDERS,
  ];

  // -----------------------------------------------------------------
  // T1: LEGACY umbrella grant (both shapes) implies all 5 new keys.
  // -----------------------------------------------------------------
  {
    const legacyStringModules = [MODULES.INVENTORY_MANAGEMENT];
    const legacyObjectWriteModules = [
      { module_key: MODULES.INVENTORY_MANAGEMENT, access_level: 'write' },
    ];
    const legacyObjectReadModules = [
      { module_key: MODULES.INVENTORY_MANAGEMENT, access_level: 'read' },
    ];
    for (const key of NEW_KEYS) {
      assert(
        `T1a legacy string umbrella -> new key ${key} READ`,
        hasGrant(legacyStringModules, key, 'read') === true,
      );
      assert(
        `T1b legacy string umbrella -> new key ${key} WRITE (legacy string is implicit write)`,
        hasGrant(legacyStringModules, key, 'write') === true,
      );
      assert(
        `T1c legacy object write umbrella -> new key ${key} READ`,
        hasGrant(legacyObjectWriteModules, key, 'read') === true,
      );
      assert(
        `T1d legacy object write umbrella -> new key ${key} WRITE`,
        hasGrant(legacyObjectWriteModules, key, 'write') === true,
      );
      assert(
        `T1e legacy object read umbrella -> new key ${key} READ`,
        hasGrant(legacyObjectReadModules, key, 'read') === true,
      );
      assert(
        `T1f legacy object read umbrella -> new key ${key} WRITE denied`,
        hasGrant(legacyObjectReadModules, key, 'write') === false,
      );
    }
  }

  // -----------------------------------------------------------------
  // T2: NEW sub-admin granted ONLY ENQUIRY_DASHBOARD.
  // Must PASS ENQUIRY_DASHBOARD read and FAIL INVENTORY_PROPERTIES.
  // -----------------------------------------------------------------
  {
    const grants = [{ module_key: MODULES.ENQUIRY_DASHBOARD, access_level: 'read' }];
    const enqReadToken = jwt.sign(
      { sub: 100, role: 'sub_admin', modules: grants },
      secret, { expiresIn: '5m' },
    );
    const dashChain = [requireAuth, requireModule(MODULES.ENQUIRY_DASHBOARD)];
    const invChain = [
      requireAuth,
      requireModule(MODULES.INVENTORY_PROPERTIES),
      requireModuleWriteOnMutation(MODULES.INVENTORY_PROPERTIES),
    ];
    // (a) ENQUIRY_DASHBOARD GET -> pass
    const r1 = await runChain(dashChain, makeReq({ token: enqReadToken, method: 'GET' }));
    assert('T2a enquiry-dashboard-only GET enquiry dashboard passes', r1 === null);
    // (b) INVENTORY_PROPERTIES GET -> 403 FORBIDDEN (no grant on that key)
    const r2 = await runChain(invChain, makeReq({ token: enqReadToken, method: 'GET' }));
    assert('T2b enquiry-dashboard-only GET inventory properties -> 403',
      r2 && r2.status === 403 && r2.code === 'FORBIDDEN');
    // (c) INVENTORY_PROPERTIES POST -> 403 (short-circuits at read gate)
    const r3 = await runChain(invChain, makeReq({ token: enqReadToken, method: 'POST' }));
    assert('T2c enquiry-dashboard-only POST inventory properties -> 403', r3 && r3.status === 403);
    // (d) INVENTORY_PROPERTIES DELETE -> 403
    const r4 = await runChain(invChain, makeReq({ token: enqReadToken, method: 'DELETE' }));
    assert('T2d enquiry-dashboard-only DELETE inventory properties -> 403', r4 && r4.status === 403);
  }

  // -----------------------------------------------------------------
  // T3: NEW sub-admin granted INVENTORY_PROPERTIES read-only -- GET
  // passes, mutations 403 FORBIDDEN_WRITE. (Regression guard on the
  // same chain used by inventory-properties.js router.use.)
  // -----------------------------------------------------------------
  {
    const grants = [{ module_key: MODULES.INVENTORY_PROPERTIES, access_level: 'read' }];
    const invReadToken = jwt.sign(
      { sub: 101, role: 'sub_admin', modules: grants },
      secret, { expiresIn: '5m' },
    );
    const chain = [
      requireAuth,
      requireModule(MODULES.INVENTORY_PROPERTIES),
      requireModuleWriteOnMutation(MODULES.INVENTORY_PROPERTIES),
    ];
    const rGet = await runChain(chain, makeReq({ token: invReadToken, method: 'GET' }));
    assert('T3a inv-properties read GET passes', rGet === null);
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const r = await runChain(chain, makeReq({ token: invReadToken, method: m }));
      assert(`T3b inv-properties read ${m} -> 403 FORBIDDEN_WRITE`,
        r && r.status === 403 && r.code === 'FORBIDDEN_WRITE');
    }
  }

  // -----------------------------------------------------------------
  // T4: Administrator bypasses every check across every new key.
  // -----------------------------------------------------------------
  {
    const adminToken = jwt.sign({ sub: 1, role: 'admin', modules: [] }, secret, { expiresIn: '5m' });
    for (const key of NEW_KEYS) {
      const chain = [
        requireAuth,
        requireModule(key),
        requireModuleWriteOnMutation(key),
      ];
      for (const m of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
        const r = await runChain(chain, makeReq({ token: adminToken, method: m }));
        assert(`T4 admin ${m} ${key} passes`, r === null);
      }
    }
  }

  // -----------------------------------------------------------------
  // T5: Direct grant on AGREEMENT_REMINDERS works identically to any
  // other module (no aliasing surprises on non-legacy paths).
  // -----------------------------------------------------------------
  {
    const grants = [
      { module_key: MODULES.AGREEMENT_REMINDERS, access_level: 'write' },
    ];
    const arWriteToken = jwt.sign(
      { sub: 102, role: 'sub_admin', modules: grants },
      secret, { expiresIn: '5m' },
    );
    const chain = [
      requireAuth,
      requireModule(MODULES.AGREEMENT_REMINDERS),
      requireModuleWriteOnMutation(MODULES.AGREEMENT_REMINDERS),
    ];
    for (const m of ['GET', 'POST', 'DELETE']) {
      const r = await runChain(chain, makeReq({ token: arWriteToken, method: m }));
      assert(`T5 agreement-reminders write ${m} passes`, r === null);
    }
    // And a sub-admin with AR grant CANNOT hit inventory-properties.
    const invChain = [
      requireAuth,
      requireModule(MODULES.INVENTORY_PROPERTIES),
    ];
    const rDenied = await runChain(invChain, makeReq({ token: arWriteToken, method: 'GET' }));
    assert('T5b agreement-reminders-only cannot hit inventory-properties',
      rDenied && rDenied.status === 403 && rDenied.code === 'FORBIDDEN');
  }

  // -----------------------------------------------------------------
  // T6: The umbrella INVENTORY_MANAGEMENT key still resolves as itself.
  // This matters for pre-T-174 code paths / audit-log queries that
  // reference the umbrella key by name.
  // -----------------------------------------------------------------
  {
    const umbrellaWrite = [{ module_key: MODULES.INVENTORY_MANAGEMENT, access_level: 'write' }];
    assert('T6a umbrella grant self-check READ',
      hasGrant(umbrellaWrite, MODULES.INVENTORY_MANAGEMENT, 'read') === true);
    assert('T6b umbrella grant self-check WRITE',
      hasGrant(umbrellaWrite, MODULES.INVENTORY_MANAGEMENT, 'write') === true);
    // And an unrelated grant should NOT resolve to the umbrella key.
    const unrelated = [{ module_key: MODULES.CMS_MANAGEMENT, access_level: 'write' }];
    assert('T6c unrelated grant does not resolve umbrella',
      hasGrant(unrelated, MODULES.INVENTORY_MANAGEMENT, 'read') === false);
  }

  console.log(`\nT-2026-174 split-module smoke: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(2);
});
