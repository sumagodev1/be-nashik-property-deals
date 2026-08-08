// Throwaway BE smoke for T-2026-118 - dynamicData Joi validation with the new
// Plot Corner + dynamic Plot Facing / Road Approach pair keys. Run:
//   node scripts/_smoke_t118_corner_pairs.js
'use strict';

const path = require('path');
const modulePath = path.join(__dirname, '..', 'server', 'services', 'inventory', 'dynamicDataValidation.js');
const { validateDynamicData } = require(modulePath);

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else      { fail++; console.log(`  FAIL  ${name}${extra ? ` - ${JSON.stringify(extra).slice(0, 300)}` : ''}`); }
}

function validate(payload) {
  const { value, err } = validateDynamicData(payload);
  return { value, err };
}

console.log('T-2026-118 BE Joi smoke: Plot Corner + dynamic Plot Facing / Road Approach\n');

// ─── Case 1: single-mode (leaseIn / sale style) — N=1, unsuffixed keys ────
console.log('[single-mode, N=1, unsuffixed pair-1 keys]');
{
  const { value, err } = validate({
    corner: '1_road',
    plotFacing: 'east',
    roadApproach: '20_ft',
  });
  check('no validation error', !err, err && err.details);
  // dualModeOrScalar coerces scalars to { specific, any } object shape.
  check('corner coerced to dualMode shape', value.corner && typeof value.corner === 'object' && 'specific' in value.corner, value.corner);
  check('plotFacing coerced to dualMode shape', value.plotFacing && typeof value.plotFacing === 'object', value.plotFacing);
  check('roadApproach coerced to dualMode shape', value.roadApproach && typeof value.roadApproach === 'object', value.roadApproach);
}

// ─── Case 2: single-mode, N=2, suffixed pair-2 keys populated ─────────────
console.log('\n[single-mode, N=2, pair-1 unsuffixed + pair-2 suffixed]');
{
  const { value, err } = validate({
    corner: '2_road',
    plotFacing: 'east',
    plotFacing2: 'west',
    roadApproach: '20_ft',
    roadApproach2: '30_ft',
  });
  check('no validation error', !err, err && err.details);
  check('plotFacing2 accepted', 'plotFacing2' in value, Object.keys(value));
  check('roadApproach2 accepted', 'roadApproach2' in value, Object.keys(value));
}

// ─── Case 3: single-mode, N=4, all four pair suffixes populated ───────────
console.log('\n[single-mode, N=4, all 4 pair suffixes populated]');
{
  const { value, err } = validate({
    corner: '4_road',
    plotFacing: 'east',
    plotFacing2: 'west',
    plotFacing3: 'north',
    plotFacing4: 'south',
    roadApproach: '20_ft',
    roadApproach2: '30_ft',
    roadApproach3: '40_ft',
    roadApproach4: '60_ft',
  });
  check('no validation error', !err, err && err.details);
  check('plotFacing3 accepted', 'plotFacing3' in value, Object.keys(value));
  check('plotFacing4 accepted', 'plotFacing4' in value, Object.keys(value));
  check('roadApproach3 accepted', 'roadApproach3' in value, Object.keys(value));
  check('roadApproach4 accepted', 'roadApproach4' in value, Object.keys(value));
}

// ─── Case 4: dualMode (Purchase variant) — object shapes on all pairs ─────
console.log('\n[dualMode variant, N=2, object shapes]');
{
  const { value, err } = validate({
    corner: { specific: '', any: '2_road' },
    plotFacing: { specific: '', any: 'east' },
    plotFacing2: { specific: 'northeast', any: '' },
    roadApproach: { specific: '', any: '20_ft' },
    roadApproach2: { specific: '25_ft custom', any: '' },
  });
  check('no validation error', !err, err && err.details);
  check('corner dualMode object preserved', value.corner && value.corner.any === '2_road', value.corner);
  check('plotFacing2 specific side preserved', value.plotFacing2 && value.plotFacing2.specific === 'northeast', value.plotFacing2);
  check('roadApproach2 specific side preserved', value.roadApproach2 && value.roadApproach2.specific === '25_ft custom', value.roadApproach2);
}

// ─── Case 5: legacy record — corner blank, no pair values ─────────────────
console.log('\n[legacy record, corner blank, no pair values]');
{
  const { value, err } = validate({
    corner: '',
    plotFacing: '',
    roadApproach: '',
  });
  check('no validation error (blank is allowed)', !err, err && err.details);
  // Empty string is coerced by dualModeOrScalar's custom() to
  // { specific: '', any: '' } which is the canonical dualMode empty state.
  check('corner blank coerces to empty dualMode', value.corner && value.corner.specific === '' && value.corner.any === '', value.corner);
}

// ─── Case 6: legacy pre-T118 record — only pair-1 unsuffixed keys ────────
console.log('\n[legacy pre-T-118 record, corner=2_road, only pair-1 unsuffixed]');
{
  const { value, err } = validate({
    corner: '2_road',
    plotFacing: 'east',
    roadApproach: '20_ft',
    // plotFacing2, roadApproach2 absent — FE will hydrate them post-load.
  });
  check('no validation error', !err, err && err.details);
  check('plotFacing2 absent from output', !('plotFacing2' in value), Object.keys(value));
  check('roadApproach2 absent from output', !('roadApproach2' in value), Object.keys(value));
}

// ─── Case 7: unknown fields still flow through (.unknown(true) preserved) ──
console.log('\n[unknown fields still pass through parent .unknown(true)]');
{
  const { value, err } = validate({
    corner: '3_road',
    plotFacing: 'east',
    plotFacing2: 'west',
    plotFacing3: 'north',
    roadApproach: '20_ft',
    roadApproach2: '30_ft',
    roadApproach3: '40_ft',
    someUnrelatedFutureKey: 'still-works',
  });
  check('no validation error', !err, err && err.details);
  check('unknown key preserved', value.someUnrelatedFutureKey === 'still-works', value.someUnrelatedFutureKey);
}

// ─── Case 8: PATTERN rejection for master-code fields ─────────────────────
console.log('\n[master-code pattern rejection — freetext with special chars]');
{
  // dualModeOrScalar uses masterCodeField (pattern-checked) so a wildly
  // invalid string on the `any` side should fail. Freetext on `specific`
  // side is accepted (up to 500 chars) which is the intended dualMode
  // semantics.
  const { value: v1, err: e1 } = validate({
    corner: { specific: 'my custom description of my 2-road corner plot', any: '' },
  });
  check('freetext on `specific` side accepted (dualMode semantics)', !e1, e1 && e1.details);
}

// ─── Case 9: numeric coercion side-effect NOT relevant here ───────────────
// (masterCodeField is a string field; no numeric input to test.)

// ─── Case 10: Round-trip: create → read → update ──────────────────────────
console.log('\n[simulated round-trip: create N=2 → update to N=3 → update back to N=2]');
{
  let payload = {
    corner: '2_road',
    plotFacing: 'east',
    plotFacing2: 'west',
    roadApproach: '20_ft',
    roadApproach2: '30_ft',
  };
  let { value, err } = validate(payload);
  check('N=2 create: no error', !err);

  // Simulate FE bumping corner to 3_road and adding pair 3.
  payload = { ...value,
    corner: { specific: '', any: '3_road' },  // dualMode shape reused
    plotFacing3: 'north',
    roadApproach3: '40_ft',
  };
  ({ value, err } = validate(payload));
  check('N=3 update: no error', !err);
  // dualModeOrScalar coerces a scalar 'north' into { specific: 'north', any: '' }.
  check('N=3 pair-3 preserved', value.plotFacing3 && (value.plotFacing3.specific === 'north' || value.plotFacing3.any === 'north'), value.plotFacing3);

  // Simulate FE dropping back to 2_road. FE preserves pair-3 in state
  // (visibleWhen=false + preserveOnHide=true) — payload still carries it.
  payload = { ...value, corner: { specific: '', any: '2_road' } };
  ({ value, err } = validate(payload));
  check('N=2 back-update: no error even with pair-3 still in payload', !err);
  check('pair-3 payload still validates (BE stores what FE sends)', 'plotFacing3' in value);
}

console.log(`\n─── ${pass} PASS / ${fail} FAIL ───`);
process.exit(fail ? 1 : 0);
