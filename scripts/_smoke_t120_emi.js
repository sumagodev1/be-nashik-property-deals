/**
 * T-2026-120 EMI dependency BE smoke test.
 *
 * Covers:
 *   1. emiOption='Available' + populated deps -> deps preserved (round-trip).
 *   2. emiOption='Not Available' + populated deps -> deps STRIPPED.
 *   3. emiOption missing/'' -> deps stripped (Joi.when 'Not Available' branch).
 *   4. Legacy `numberOfEmis` on payload -> unchanged (rides .unknown(true)).
 *   5. Empty draft -> pass-through.
 *   6. Route module load smoke (inventory + enquiry both use the shared validator).
 */

const path = require('path');
const { validateDynamicData } = require(path.join(__dirname, '..', 'server', 'services', 'inventory', 'dynamicDataValidation'));

let pass = 0;
let fail = 0;
const asrt = (name, cond, extra) => {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}${extra !== undefined ? '  ->  ' + JSON.stringify(extra) : ''}`);
  }
};

console.log('T-2026-120 EMI dependency BE smoke');
console.log('==================================');

// ---- Case 1: Available + populated ----
{
  const input = { emiOption: 'Available', emiCount: '6', emiAmount: 50000 };
  const { value, errors } = validateDynamicData(input);
  asrt('C1 no errors', errors.length === 0, errors);
  asrt('C1 emiOption preserved', value.emiOption === 'Available', value.emiOption);
  asrt('C1 emiCount preserved', value.emiCount === '6', value.emiCount);
  asrt('C1 emiAmount preserved', value.emiAmount === 50000, value.emiAmount);
}

// ---- Case 2: Not Available + populated deps -> stripped ----
{
  const input = { emiOption: 'Not Available', emiCount: '6', emiAmount: 50000 };
  const { value } = validateDynamicData(input);
  asrt('C2 emiOption preserved', value.emiOption === 'Not Available', value.emiOption);
  asrt('C2 emiCount STRIPPED', !('emiCount' in value), Object.keys(value));
  asrt('C2 emiAmount STRIPPED', !('emiAmount' in value), Object.keys(value));
}

// ---- Case 3a: emiOption missing entirely -> deps stripped ----
{
  const input = { emiCount: '3', emiAmount: 10000 };
  const { value } = validateDynamicData(input);
  asrt('C3a emiCount STRIPPED when emiOption missing', !('emiCount' in value), Object.keys(value));
  asrt('C3a emiAmount STRIPPED when emiOption missing', !('emiAmount' in value), Object.keys(value));
}

// ---- Case 3b: emiOption = '' -> deps stripped ----
{
  const input = { emiOption: '', emiCount: '3', emiAmount: 10000 };
  const { value } = validateDynamicData(input);
  asrt('C3b emiCount STRIPPED when emiOption blank', !('emiCount' in value), Object.keys(value));
  asrt('C3b emiAmount STRIPPED when emiOption blank', !('emiAmount' in value), Object.keys(value));
}

// ---- Case 3c: emiOption = 'no' (legacy) -> deps stripped ----
{
  const input = { emiOption: 'no', emiCount: '3', emiAmount: 10000 };
  const { value } = validateDynamicData(input);
  asrt('C3c emiCount STRIPPED for legacy "no"', !('emiCount' in value), Object.keys(value));
  asrt('C3c emiAmount STRIPPED for legacy "no"', !('emiAmount' in value), Object.keys(value));
}

// ---- Case 4: Legacy numberOfEmis rides .unknown(true) ----
{
  const input = { emiOption: 'Available', emiCount: '6', emiAmount: 50000, numberOfEmis: 4 };
  const { value } = validateDynamicData(input);
  asrt('C4 legacy numberOfEmis preserved', value.numberOfEmis === 4, value.numberOfEmis);
  asrt('C4 canonical emiCount preserved', value.emiCount === '6', value.emiCount);
}

// ---- Case 5: Empty payload -> pass-through ----
{
  const input = {};
  const { value, errors } = validateDynamicData(input);
  asrt('C5 empty no errors', errors.length === 0, errors);
  asrt('C5 empty stays empty', Object.keys(value).length === 0, Object.keys(value));
}

// ---- Case 5b: null -> pass-through ----
{
  const { value, errors } = validateDynamicData(null);
  asrt('C5b null no errors', errors.length === 0, errors);
  asrt('C5b null stays null', value === null, value);
}

// ---- Case 6: Coexistence with T-116/T-118/T-119 keys ----
{
  const input = {
    emiOption: 'Available',
    emiCount: '12',
    emiAmount: 100000,
    // T-116 plot area canonical keys
    plotAreaSqMt: 100,
    plotAreaSqFt: '1076.39',
    // T-118 corner
    corner: '3_road',
    plotFacing: 'north',
    plotFacing2: 'east',
    plotFacing3: 'south',
    // T-119 built-up rate
    ratePerSqFt: 5000,
    governmentRatePerSqFt: 4500,
    // Other keys
    emiBookingPercent: 'ten',
  };
  const { value, errors } = validateDynamicData(input);
  asrt('C6 no errors on coexistence', errors.length === 0, errors);
  asrt('C6 emiOption preserved', value.emiOption === 'Available');
  asrt('C6 emiCount preserved', value.emiCount === '12');
  asrt('C6 emiAmount preserved', value.emiAmount === 100000);
  asrt('C6 emiBookingPercent preserved (sibling, not dependent)', value.emiBookingPercent === 'ten');
  asrt('C6 T-116 plotAreaSqMt preserved', value.plotAreaSqMt === 100);
  // T-118 corner uses dualModeOrScalar -> coerces to { specific, any } shape.
  const cornerOk = (value.corner === '3_road')
    || (value.corner && typeof value.corner === 'object'
        && (value.corner.specific === '3_road' || value.corner.any === '3_road'));
  asrt('C6 T-118 corner preserved (raw or coerced dualMode)', cornerOk, value.corner);
  asrt('C6 T-119 ratePerSqFt preserved', value.ratePerSqFt === 5000);
}

// ---- Case 7: Not Available + emiBookingPercent preserved (sibling, independent) ----
{
  const input = { emiOption: 'Not Available', emiBookingPercent: 'ten', emiCount: 6, emiAmount: 50000 };
  const { value } = validateDynamicData(input);
  asrt('C7 emiBookingPercent PRESERVED when Not Available', value.emiBookingPercent === 'ten', value.emiBookingPercent);
  asrt('C7 emiCount STRIPPED', !('emiCount' in value));
  asrt('C7 emiAmount STRIPPED', !('emiAmount' in value));
}

// ---- Case 8: Route module load smoke ----
try {
  require(path.join(__dirname, '..', 'server', 'routes', 'admin', 'inventory-properties'));
  asrt('C8 inventory-properties route loads', true);
} catch (e) {
  asrt('C8 inventory-properties route loads', false, e.message);
}
try {
  require(path.join(__dirname, '..', 'server', 'routes', 'admin', 'enquiry-properties'));
  asrt('C8 enquiry-properties route loads', true);
} catch (e) {
  asrt('C8 enquiry-properties route loads', false, e.message);
}

console.log('----------------------------------');
console.log(`Total: ${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
