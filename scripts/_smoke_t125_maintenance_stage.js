/**
 * T-2026-125 Monthly Maintenance <- Stage of Construction dependency BE smoke.
 *
 * Covers:
 *   1. stageOfConstruction === 'Under Construction' + populated
 *      maintenanceMonthly -> STRIPPED (belt-and-suspenders with FE).
 *   2. stageOfConstruction === 'Ready Possession' + populated
 *      maintenanceMonthly -> preserved.
 *   3. stageOfConstruction ABSENT (Resale / Rent / Lease variants) +
 *      populated maintenanceMonthly -> preserved (predicate defaults to
 *      "show" per FE, BE mirrors via `otherwise: priceLike.allow`).
 *   4. stageOfConstruction === '' / null (draft state) + populated
 *      maintenanceMonthly -> preserved.
 *   5. maintenanceYearly NEVER stripped regardless of stage (task rule).
 *   6. oneTimeMaintenance NEVER stripped regardless of stage (task rule
 *      + rides through .unknown(true) since no explicit schema entry).
 *   7. Coexistence with T-2026-116 (plotAreaSqMt), T-2026-118 (corner
 *      pairs via .unknown), T-2026-119 (ratePerSqFt), T-2026-120 (EMI),
 *      T-2026-121 (parking) — all still work in a single combined payload.
 *   8. Legacy payload without stageOfConstruction pass-through (pre-T-125
 *      records read verbatim).
 *   9. Route module load smoke (inventory + enquiry both use the shared
 *      validator).
 *  10. Blank / null / string-number coerce cases for maintenanceMonthly.
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

console.log('T-2026-125 Monthly Maintenance <- Stage of Construction BE smoke');
console.log('================================================================');

// ---- Case 1a: Under Construction + populated -> STRIPPED ----
{
  const input = { stageOfConstruction: 'Under Construction', maintenanceMonthly: 5000 };
  const { value, errors } = validateDynamicData(input);
  asrt('C1a no errors', errors.length === 0, errors);
  asrt('C1a stageOfConstruction preserved', value.stageOfConstruction === 'Under Construction', value.stageOfConstruction);
  asrt('C1a maintenanceMonthly STRIPPED', !('maintenanceMonthly' in value), Object.keys(value));
}

// ---- Case 1b: Under Construction + string-number populated -> STRIPPED ----
{
  const input = { stageOfConstruction: 'Under Construction', maintenanceMonthly: '5000' };
  const { value } = validateDynamicData(input);
  asrt('C1b string-number maintenanceMonthly STRIPPED', !('maintenanceMonthly' in value), Object.keys(value));
}

// ---- Case 1c: Under Construction + 0 -> STRIPPED ----
{
  const input = { stageOfConstruction: 'Under Construction', maintenanceMonthly: 0 };
  const { value } = validateDynamicData(input);
  asrt('C1c zero maintenanceMonthly STRIPPED', !('maintenanceMonthly' in value), Object.keys(value));
}

// ---- Case 2a: Ready Possession + populated -> preserved ----
{
  const input = { stageOfConstruction: 'Ready Possession', maintenanceMonthly: 5000 };
  const { value, errors } = validateDynamicData(input);
  asrt('C2a no errors', errors.length === 0, errors);
  asrt('C2a stageOfConstruction preserved', value.stageOfConstruction === 'Ready Possession', value.stageOfConstruction);
  asrt('C2a maintenanceMonthly preserved (5000)', value.maintenanceMonthly === 5000, value.maintenanceMonthly);
}

// ---- Case 2b: Ready Possession + string-number -> coerced + preserved ----
{
  const input = { stageOfConstruction: 'Ready Possession', maintenanceMonthly: '7500' };
  const { value, errors } = validateDynamicData(input);
  asrt('C2b string-number coerced', errors.length === 0 && value.maintenanceMonthly === 7500, { value, errors });
}

// ---- Case 3a: stageOfConstruction ABSENT + populated -> preserved ----
{
  const input = { maintenanceMonthly: 3500 };
  const { value, errors } = validateDynamicData(input);
  asrt('C3a no errors on missing stage', errors.length === 0, errors);
  asrt('C3a maintenanceMonthly preserved without stage', value.maintenanceMonthly === 3500, value.maintenanceMonthly);
}

// ---- Case 3b: stageOfConstruction ABSENT + string-number -> preserved ----
{
  const input = { maintenanceMonthly: '3500' };
  const { value } = validateDynamicData(input);
  asrt('C3b string-number without stage preserved', value.maintenanceMonthly === 3500, value.maintenanceMonthly);
}

// ---- Case 4a: Blank stage + populated -> preserved (draft state) ----
{
  const input = { stageOfConstruction: '', maintenanceMonthly: 4000 };
  const { value } = validateDynamicData(input);
  asrt('C4a blank stage preserves maintenanceMonthly', value.maintenanceMonthly === 4000, value.maintenanceMonthly);
}

// ---- Case 4b: null stage + populated -> preserved ----
{
  const input = { stageOfConstruction: null, maintenanceMonthly: 4000 };
  const { value } = validateDynamicData(input);
  asrt('C4b null stage preserves maintenanceMonthly', value.maintenanceMonthly === 4000, value.maintenanceMonthly);
}

// ---- Case 4c: Unknown/other stage value + populated -> preserved (matches FE default show) ----
{
  const input = { stageOfConstruction: 'Some Other Value', maintenanceMonthly: 4000 };
  const { value } = validateDynamicData(input);
  asrt('C4c unknown stage preserves maintenanceMonthly (not exactly Under Construction)', value.maintenanceMonthly === 4000, value.maintenanceMonthly);
}

// ---- Case 5a: maintenanceYearly preserved regardless of stage ----
{
  const inputs = [
    { stageOfConstruction: 'Under Construction', maintenanceYearly: 60000 },
    { stageOfConstruction: 'Ready Possession', maintenanceYearly: 60000 },
    { maintenanceYearly: 60000 },
    { stageOfConstruction: '', maintenanceYearly: 60000 },
    { stageOfConstruction: null, maintenanceYearly: 60000 },
  ];
  inputs.forEach((input, i) => {
    const { value } = validateDynamicData(input);
    asrt(`C5a[${i}] maintenanceYearly preserved`, value.maintenanceYearly === 60000, value.maintenanceYearly);
  });
}

// ---- Case 5b: maintenanceYearly + maintenanceMonthly together (Under Construction) ----
{
  const input = {
    stageOfConstruction: 'Under Construction',
    maintenanceMonthly: 5000,
    maintenanceYearly: 60000,
  };
  const { value } = validateDynamicData(input);
  asrt('C5b maintenanceMonthly STRIPPED', !('maintenanceMonthly' in value), Object.keys(value));
  asrt('C5b maintenanceYearly preserved', value.maintenanceYearly === 60000, value.maintenanceYearly);
}

// ---- Case 6: oneTimeMaintenance NEVER stripped (rides through .unknown) ----
{
  const inputs = [
    { stageOfConstruction: 'Under Construction', oneTimeMaintenance: 25000 },
    { stageOfConstruction: 'Ready Possession', oneTimeMaintenance: 25000 },
    { oneTimeMaintenance: 25000 },
  ];
  inputs.forEach((input, i) => {
    const { value } = validateDynamicData(input);
    asrt(`C6[${i}] oneTimeMaintenance preserved (rides .unknown)`, value.oneTimeMaintenance === 25000, value.oneTimeMaintenance);
  });
}

// ---- Case 7: Coexistence with T-2026-116/118/119/120/121 ----
{
  const input = {
    // T-116 area
    plotAreaSqMt: 500,
    plotAreaSqYard: 598.1,
    // T-118 corner pair (rides .unknown)
    corner: '3_road',
    plotFacing_pair2: 'North',
    roadApproach_pair2: '12m',
    // T-119 pricing
    ratePerSqFt: 5500,
    governmentRatePerSqFt: 4000,
    // T-120 EMI (Available -> preserved)
    emiOption: 'Available',
    emiCount: '10_emis',
    emiAmount: 15000,
    // T-121 parking (Available -> preserved)
    parkingFacility: 'Available',
    parkingType: 'Allotted',
    // T-125: Under Construction -> maintenanceMonthly STRIPPED
    stageOfConstruction: 'Under Construction',
    maintenanceMonthly: 8000,
    maintenanceYearly: 96000,
    oneTimeMaintenance: 30000,
  };
  const { value, errors } = validateDynamicData(input);
  asrt('C7 combined payload no errors', errors.length === 0, errors);
  asrt('C7 T-116 plotAreaSqMt preserved', value.plotAreaSqMt === 500, value.plotAreaSqMt);
  asrt('C7 T-119 ratePerSqFt preserved', value.ratePerSqFt === 5500, value.ratePerSqFt);
  asrt('C7 T-120 emiCount preserved (Available)', value.emiCount === '10_emis', value.emiCount);
  asrt('C7 T-121 parkingType preserved (Available)', value.parkingType === 'Allotted', value.parkingType);
  asrt('C7 T-125 maintenanceMonthly STRIPPED (Under Construction)', !('maintenanceMonthly' in value), Object.keys(value));
  asrt('C7 T-125 maintenanceYearly preserved', value.maintenanceYearly === 96000, value.maintenanceYearly);
  asrt('C7 T-125 oneTimeMaintenance preserved', value.oneTimeMaintenance === 30000, value.oneTimeMaintenance);
}

// ---- Case 8a: Dual-strip T-120 (Not Available) + T-125 (Under Construction) ----
{
  const input = {
    stageOfConstruction: 'Under Construction',
    maintenanceMonthly: 5000,
    maintenanceYearly: 60000,
    emiOption: 'Not Available',
    emiCount: '5_emis',
    emiAmount: 25000,
  };
  const { value } = validateDynamicData(input);
  asrt('C8a maintenanceMonthly stripped', !('maintenanceMonthly' in value), Object.keys(value));
  asrt('C8a emiCount stripped', !('emiCount' in value), Object.keys(value));
  asrt('C8a emiAmount stripped', !('emiAmount' in value), Object.keys(value));
  asrt('C8a maintenanceYearly preserved', value.maintenanceYearly === 60000, value.maintenanceYearly);
}

// ---- Case 9a: Legacy pre-T-125 payload (Under Construction with ghost) ----
{
  const input = {
    stageOfConstruction: 'Under Construction',
    maintenanceMonthly: 4500,
  };
  const { value } = validateDynamicData(input);
  asrt('C9a legacy ghost stripped at BE boundary', !('maintenanceMonthly' in value), Object.keys(value));
}

// ---- Case 9b: Pre-T-125 payload without stage (Resale) ----
{
  const input = {
    maintenanceMonthly: 4500,
    maintenanceYearly: 54000,
  };
  const { value } = validateDynamicData(input);
  asrt('C9b pre-T-125 resale payload preserved', value.maintenanceMonthly === 4500 && value.maintenanceYearly === 54000, value);
}

// ---- Case 10a: Blank maintenanceMonthly preserved (draft) when Ready Possession ----
{
  const input = { stageOfConstruction: 'Ready Possession', maintenanceMonthly: '' };
  const { value, errors } = validateDynamicData(input);
  asrt('C10a blank draft accepted', errors.length === 0, errors);
  asrt('C10a blank maintenanceMonthly preserved', value.maintenanceMonthly === '', value.maintenanceMonthly);
}

// ---- Case 10b: null maintenanceMonthly preserved (draft) when absent stage ----
{
  const input = { maintenanceMonthly: null };
  const { value, errors } = validateDynamicData(input);
  asrt('C10b null accepted without stage', errors.length === 0, errors);
  asrt('C10b null maintenanceMonthly preserved', value.maintenanceMonthly === null, value.maintenanceMonthly);
}

// ---- Case 10c: Blank + Under Construction -> STRIPPED ----
{
  const input = { stageOfConstruction: 'Under Construction', maintenanceMonthly: '' };
  const { value } = validateDynamicData(input);
  asrt('C10c blank + Under Construction stripped', !('maintenanceMonthly' in value), Object.keys(value));
}

// ---- Case 10d: null + Under Construction -> STRIPPED ----
{
  const input = { stageOfConstruction: 'Under Construction', maintenanceMonthly: null };
  const { value } = validateDynamicData(input);
  asrt('C10d null + Under Construction stripped', !('maintenanceMonthly' in value), Object.keys(value));
}

// ---- Case 11: Route module load smoke ----
try {
  require(path.join(__dirname, '..', 'server', 'routes', 'admin', 'inventory-properties'));
  asrt('C11a inventory-properties route loads', true);
} catch (e) {
  asrt('C11a inventory-properties route loads', false, e.message);
}
try {
  require(path.join(__dirname, '..', 'server', 'routes', 'admin', 'enquiry-properties'));
  asrt('C11b enquiry-properties route loads', true);
} catch (e) {
  asrt('C11b enquiry-properties route loads', false, e.message);
}

// ---- Summary ----
console.log('');
console.log(`T-2026-125 BE smoke: ${pass} PASS / ${fail} FAIL of ${pass + fail} total`);
process.exit(fail === 0 ? 0 : 1);
