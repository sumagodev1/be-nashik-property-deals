// T-2026-119 BE mirror smoke — verifies computeLandPricing under the
// Maharashtra rule for Land + SEZ-Land + built-up families.

const { computeLandPricing, detectFamily, parseGstPercentage } =
  require('../server/services/inventory/landPricingCompute.js');

let PASS = 0, FAIL = 0;
const failures = [];
function ok(label, cond, extra) {
  if (cond) { PASS++; console.log(`  PASS  ${label}`); }
  else      { FAIL++; failures.push(`FAIL: ${label}${extra !== undefined ? ' — ' + JSON.stringify(extra) : ''}`); console.log(`  FAIL  ${label}${extra !== undefined ? ' — ' + JSON.stringify(extra) : ''}`); }
}

console.log('\nT-2026-119 BE mirror smoke');

// ─── detectFamily ─────────────────────────────────────────────────────

ok('detectFamily(land-sale) → land', detectFamily('land-sale') === 'land');
ok('detectFamily(land-purchase) → land', detectFamily('land-purchase') === 'land');
ok('detectFamily(land-lease-in) → null (out of scope)', detectFamily('land-lease-in') === null);
ok('detectFamily(sez-land-sale) → sez-land', detectFamily('sez-land-sale') === 'sez-land');
ok('detectFamily(sez-land-purchase) → sez-land', detectFamily('sez-land-purchase') === 'sez-land');
ok('detectFamily(sez-plot-sale) → null (out of scope)', detectFamily('sez-plot-sale') === null);
// T-119 built-up.
ok('detectFamily(flat-resale) → built-up', detectFamily('flat-resale') === 'built-up');
ok('detectFamily(flat-new-sale) → built-up', detectFamily('flat-new-sale') === 'built-up');
ok('detectFamily(bunglow-resale) → built-up', detectFamily('bunglow-resale') === 'built-up');
ok('detectFamily(bunglow-new-sale) → built-up', detectFamily('bunglow-new-sale') === 'built-up');
ok('detectFamily(rowhouse-resale) → built-up', detectFamily('rowhouse-resale') === 'built-up');
ok('detectFamily(rowhouse-new-sale) → built-up', detectFamily('rowhouse-new-sale') === 'built-up');
ok('detectFamily(commercial-resale) → built-up', detectFamily('commercial-resale') === 'built-up');
ok('detectFamily(commercial-new-sale) → built-up', detectFamily('commercial-new-sale') === 'built-up');
ok('detectFamily(shop-resale) → built-up', detectFamily('shop-resale') === 'built-up');
ok('detectFamily(shop-new-sale) → built-up', detectFamily('shop-new-sale') === 'built-up');
ok('detectFamily(project-resale) → built-up', detectFamily('project-resale') === 'built-up');
// Non-Sale on built-up types must NOT match.
ok('detectFamily(flat-purchase) → null', detectFamily('flat-purchase') === null);
ok('detectFamily(flat-lease-in) → null', detectFamily('flat-lease-in') === null);
ok('detectFamily(bunglow-rent-out) → null', detectFamily('bunglow-rent-out') === null);
ok('detectFamily(commercial-purchase) → null', detectFamily('commercial-purchase') === null);
ok('detectFamily(shop-new-lease-in) → null', detectFamily('shop-new-lease-in') === null);
// Legacy label-style property types (with spaces).
ok('detectFamily("Land Registration Form[Sale]") → land',
  detectFamily('Land Registration Form[Sale]') === 'land');
ok('detectFamily("Flat Registration Form [Re-Sale]") → built-up',
  detectFamily('Flat Registration Form [Re-Sale]') === 'built-up');
// Empty / null.
ok('detectFamily(null) → null', detectFamily(null) === null);
ok('detectFamily("") → null', detectFamily('') === null);

// ─── computeLandPricing — Built-up family ────────────────────────────

// Case 1: full built-up Sale save, consideration > gov.
{
  const out = computeLandPricing({
    builtUpArea: 1000,
    ratePerSqFt: 5000,
    governmentRatePerSqFt: 4000,
    considerationValue: 10000000,   // 1 Cr
    gstId: '5-pct',
    paperNotice: 2000,
    documentTypingCharges: 500,
    amountOfStampPaper: 100,
    undertableFees: 1000,
  }, 'flat-resale');
  ok('flat-resale actual price = 1000×5000 = 5,000,000',
    out.actualCalculatedPropertyPrice === '5000000', out.actualCalculatedPropertyPrice);
  ok('flat-resale gov price = 1000×4000 = 4,000,000',
    out.governmentCalculatedPropertyPrice === '4000000', out.governmentCalculatedPropertyPrice);
  // base = max(1cr, 40L) = 1cr; stampDuty = 5% of 1cr = 5L
  ok('flat-resale stampDuty (base=consideration): 500000',
    out.stampDuty === '500000', out.stampDuty);
  ok('flat-resale registrationCharges: 100000',
    out.registrationCharges === '100000', out.registrationCharges);
  ok('flat-resale gstAmount: 500000', out.gstAmount === '500000', out.gstAmount);
  ok('flat-resale gstPercentage: 5', out.gstPercentage === '5', out.gstPercentage);
  // cost = 1cr + 5L + 1L + 1L + 5L + 2000 + 500 + 100 + 1000 = 11,203,600
  ok('flat-resale costToCustomer: 11203600',
    out.costToCustomer === '11203600', out.costToCustomer);
}

// Case 2: THE MAHARASHTRA CASE — gov > consideration.
{
  const out = computeLandPricing({
    builtUpArea: 1000,
    ratePerSqFt: 4000,               // actual: 40L
    governmentRatePerSqFt: 5000,     // gov:    50L
    considerationValue: 3000000,     // 30L consideration
    gstId: '5-pct',
  }, 'bunglow-resale');
  ok('bunglow-resale actual = 40L',
    out.actualCalculatedPropertyPrice === '4000000', out.actualCalculatedPropertyPrice);
  ok('bunglow-resale gov = 50L',
    out.governmentCalculatedPropertyPrice === '5000000', out.governmentCalculatedPropertyPrice);
  // MAHARASHTRA: base = max(30L, 50L) = 50L; stampDuty = 5% of 50L = 250000
  ok('MAHARASHTRA bunglow: stampDuty = 5% of gov (50L), NOT of consideration (30L)',
    out.stampDuty === '250000', out.stampDuty);
  ok('MAHARASHTRA bunglow: registrationCharges = 50000',
    out.registrationCharges === '50000', out.registrationCharges);
  ok('MAHARASHTRA bunglow: gstAmount = 250000 (5% of 50L)',
    out.gstAmount === '250000', out.gstAmount);
  // cost = 50L + 250000 + 50000 + 50000 + 250000 = 5600000
  ok('MAHARASHTRA bunglow: costToCustomer = 5600000',
    out.costToCustomer === '5600000', out.costToCustomer);
}

// Case 3: rowhouse — only gov set, no consideration.
{
  const out = computeLandPricing({
    builtUpArea: 800,
    governmentRatePerSqFt: 6000,
    gstId: '1-pct',
  }, 'rowhouse-new-sale');
  ok('rowhouse-new-sale gov = 4,800,000',
    out.governmentCalculatedPropertyPrice === '4800000', out.governmentCalculatedPropertyPrice);
  // base = max(null, 48L) = 48L; stampDuty = 5% of 48L = 240000
  ok('rowhouse only-gov: stampDuty from base=48L → 240000',
    out.stampDuty === '240000', out.stampDuty);
  ok('rowhouse only-gov: costToCustomer = 48L + 240000 + 48000 + 48000 + 48000 = 5184000',
    out.costToCustomer === '5184000', out.costToCustomer);
}

// Case 4: built-up all blank → all derived blank.
{
  const out = computeLandPricing({}, 'flat-new-sale');
  ok('empty flat-new-sale: actualCalcPrice blank',
    out.actualCalculatedPropertyPrice === '', out.actualCalculatedPropertyPrice);
  ok('empty flat-new-sale: govCalcPrice blank',
    out.governmentCalculatedPropertyPrice === '', out.governmentCalculatedPropertyPrice);
  ok('empty flat-new-sale: stampDuty blank',
    out.stampDuty === '', out.stampDuty);
  ok('empty flat-new-sale: costToCustomer blank',
    out.costToCustomer === '', out.costToCustomer);
}

// ─── computeLandPricing — Land family (Maharashtra rule now applies) ──

// Case 5: Land Sale with consideration < gov — Maharashtra rule kicks in.
{
  const out = computeLandPricing({
    areaGuntha: 7,
    rateGuntha: 20,
    lastEditedRateUnit: 'guntha',
    govRateGuntha: 30,
    lastEditedGovRateUnit: 'guntha',
    considerationValue: 100,
    gstId: '5-pct',
  }, 'land-sale');
  ok('land-sale actual = 7 × 20 = 140',
    out.actualCalculatedPropertyPrice === '140', out.actualCalculatedPropertyPrice);
  ok('land-sale gov = 7 × 30 = 210',
    out.governmentCalculatedPropertyPrice === '210', out.governmentCalculatedPropertyPrice);
  // base = max(100, 210) = 210; stampDuty = 5% of 210 = 10.5
  ok('MAHARASHTRA land-sale: stampDuty = 5% of gov (210) = 10.5',
    out.stampDuty === '10.5', out.stampDuty);
  ok('MAHARASHTRA land-sale: registrationCharges = 1% of 210 = 2.1',
    out.registrationCharges === '2.1', out.registrationCharges);
  ok('MAHARASHTRA land-sale: gstAmount = 5% of 210 = 10.5',
    out.gstAmount === '10.5', out.gstAmount);
}

// Case 6: SEZ Land Sale.
{
  const out = computeLandPricing({
    areaAcre: 1,
    budgetPerAcre: 5000000,
    lastEditedRateUnit: 'acre',
    considerationValue: 5000000,
  }, 'sez-land-sale');
  ok('sez-land-sale actual = 1 × 5000000 = 5000000',
    out.actualCalculatedPropertyPrice === '5000000', out.actualCalculatedPropertyPrice);
  ok('sez-land-sale base=consideration; stampDuty = 250000',
    out.stampDuty === '250000', out.stampDuty);
}

// ─── Passthrough — non-matching property types unchanged ──────────────

{
  const input = {
    builtUpArea: 1000,
    ratePerSqFt: 5000,
    considerationValue: 10000000,
  };
  const out = computeLandPricing(input, 'flat-purchase'); // Purchase not Sale
  ok('flat-purchase: pass-through (unchanged)',
    out === input, 'reference equality expected');
}
{
  const input = { builtUpArea: 1000 };
  const out = computeLandPricing(input, 'plot-sale'); // plot not in built-up set
  ok('plot-sale: pass-through',
    out === input, 'reference equality expected');
}
{
  const input = { areaAcre: 5 };
  const out = computeLandPricing(input, 'land-lease-in'); // Lease not Sale/Purchase
  ok('land-lease-in: pass-through',
    out === input);
}

// ─── Idempotence ──────────────────────────────────────────────────────

{
  const seed = {
    builtUpArea: 1000,
    ratePerSqFt: 5000,
    governmentRatePerSqFt: 4000,
    considerationValue: 6000000,
    gstId: '5-pct',
  };
  const once  = computeLandPricing(seed, 'flat-resale');
  const twice = computeLandPricing(once, 'flat-resale');
  ok('idempotent: run once vs twice → same output',
    JSON.stringify(once) === JSON.stringify(twice));
}

// ─── parseGstPercentage sanity ────────────────────────────────────────

ok('parseGstPercentage(5-pct) = 5', parseGstPercentage('5-pct') === 5);
ok('parseGstPercentage(12) = 12', parseGstPercentage('12') === 12);
ok('parseGstPercentage(blank) = null', parseGstPercentage('') === null);

console.log(`\nT-2026-119 BE mirror smoke: ${PASS}/${PASS + FAIL} PASS`);
if (FAIL) {
  console.log('\nFailures:');
  for (const f of failures) console.log('  ' + f);
  process.exit(1);
}
process.exit(0);
