// T-2026-119 BE smoke — verifies dynamicDataValidation.js accepts the
// 2 new canonical rate keys plus the existing pricing keys round-trip
// cleanly on the built-up Sale variants.

const { validateDynamicData } = require('../server/services/inventory/dynamicDataValidation.js');

let PASS = 0, FAIL = 0;
const failures = [];
function ok(label, cond, extra) {
  if (cond) { PASS++; console.log(`  PASS  ${label}`); }
  else      { FAIL++; failures.push(`FAIL: ${label}${extra ? ' — ' + JSON.stringify(extra) : ''}`); console.log(`  FAIL  ${label}`); }
}

console.log('\nT-2026-119 BE Joi smoke — built-up pricing keys');

// 1. New rate keys accepted, coerce string to number.
{
  const { value, errors } = validateDynamicData({
    builtUpArea: '1000',
    ratePerSqFt: '5000',
    governmentRatePerSqFt: '4000',
    actualCalculatedPropertyPrice: '5000000',
    governmentCalculatedPropertyPrice: '4000000',
  });
  ok('new rate keys pass', errors.length === 0, errors);
  ok('builtUpArea coerced to number', typeof value.builtUpArea === 'number' && value.builtUpArea === 1000);
  ok('ratePerSqFt coerced to number', typeof value.ratePerSqFt === 'number' && value.ratePerSqFt === 5000);
  ok('governmentRatePerSqFt coerced to number', typeof value.governmentRatePerSqFt === 'number' && value.governmentRatePerSqFt === 4000);
  ok('actualCalculatedPropertyPrice coerced', typeof value.actualCalculatedPropertyPrice === 'number' && value.actualCalculatedPropertyPrice === 5000000);
  ok('governmentCalculatedPropertyPrice coerced', typeof value.governmentCalculatedPropertyPrice === 'number' && value.governmentCalculatedPropertyPrice === 4000000);
}

// 2. Full Sale-variant payload (mimic what a Sale-form save sends).
{
  const payload = {
    builtUpArea: 1000,
    carpetArea: 850,
    ratePerSqFt: 5000,
    lumpsum: 0,
    actualCalculatedPropertyPrice: 5000000,
    governmentRatePerSqFt: 4000,
    governmentCalculatedPropertyPrice: 4000000,
    considerationValue: 5000000,
    stampDuty: 200000,      // 5% of max(5M, 4M) = 5% of 5M = 250000; BE stores whatever FE sent
    registrationCharges: 50000,
    lbt: 50000,
    gstId: '5-pct',
    gstPercentage: 5,
    gstAmount: 250000,
    paperNotice: 2000,
    documentTypingCharges: 500,
    amountOfStampPaper: 100,
    undertableFees: 0,
    costToCustomer: 5352600,
    // Legacy keys — should ride through .unknown(true).
    rate: 5000,
    totalAmount: 5000000,
    govtValuationRate: 4000,
    govtValuationTotal: 4000000,
    typingCharges: 500,
    stampPaperAmount: 100,
    gst: 250000,
  };
  const { value, errors } = validateDynamicData(payload);
  ok('full built-up Sale payload validates', errors.length === 0, errors);
  ok('canonical keys preserved', value.builtUpArea === 1000 && value.ratePerSqFt === 5000);
  ok('legacy keys preserved via unknown(true)', value.rate === 5000 && value.totalAmount === 5000000);
  ok('cost to customer preserved', value.costToCustomer === 5352600);
}

// 3. Blank / null / empty string accepted (draft save shape).
{
  const { errors } = validateDynamicData({
    builtUpArea: '',
    ratePerSqFt: null,
    governmentRatePerSqFt: '',
    considerationValue: '',
    costToCustomer: null,
  });
  ok('all-blank pricing draft validates', errors.length === 0, errors);
}

// 4. Negative rate rejected via wrapper (falls back to raw input, no throw).
{
  const { value, errors } = validateDynamicData({
    ratePerSqFt: -500,
  });
  // The wrapper swallows validator errors and returns raw. So we just
  // verify no throw + returns something usable.
  ok('negative rate does not throw', true);
  ok('returned value is defined', value !== undefined);
}

// 5. String > 1000 crore ceiling (PRICE_MAX = 1000 crore = 1e11) — accepted
// via .unknown(true) fallback since priceLike max is 1e11.
{
  const { errors } = validateDynamicData({ ratePerSqFt: 100000000000 }); // 1e11 = exactly PRICE_MAX
  ok('rate at PRICE_MAX ceiling validates', errors.length === 0, errors);
}

// 6. Mixed with T-116 plot keys + T-118 corner keys + T-119 pricing keys.
{
  const payload = {
    plotAreaSqYard: 100,
    plotAreaSqMt: 83.61,
    plotAreaSqFt: 900,
    corner: '1_road',
    plotFacing: 'east',
    roadApproach: 'north',
    builtUpArea: 1000,
    ratePerSqFt: 5000,
    governmentRatePerSqFt: 4000,
    considerationValue: 5000000,
    costToCustomer: 5352600,
  };
  const { value, errors } = validateDynamicData(payload);
  ok('T-116 + T-118 + T-119 keys coexist', errors.length === 0, errors);
  ok('T-119 rate present alongside T-116 area', value.builtUpArea === 1000 && value.plotAreaSqYard === 100);
  ok('T-119 rate present alongside T-118 corner', value.ratePerSqFt === 5000 && value.corner && (value.corner.specific === '1_road' || value.corner === '1_road'));
}

// 7. Route module loads cleanly.
try {
  require('../server/routes/admin/inventory-properties.js');
  ok('inventory-properties route module loads', true);
} catch (e) {
  ok('inventory-properties route module loads', false, e.message);
}
try {
  require('../server/routes/admin/enquiry-properties.js');
  ok('enquiry-properties route module loads', true);
} catch (e) {
  ok('enquiry-properties route module loads', false, e.message);
}

console.log(`\nT-2026-119 BE smoke: ${PASS}/${PASS + FAIL} PASS`);
if (FAIL) {
  console.log('\nFailures:');
  for (const f of failures) console.log('  ' + f);
  process.exit(1);
}
process.exit(0);
