/**
 * T-2026-121 Parking Facility/Type dependency BE smoke test.
 *
 * Covers:
 *   1. Affirmative facility (Available/Essential/Required) + populated
 *      parkingType -> preserved (round-trip).
 *   2. Non-affirmative facility (Not Available/Not Essential/Not
 *      Required/blank/missing) + populated parkingType -> STRIPPED.
 *   3. Legacy non-canonical parkingType values (Open, Covered, Basement)
 *      allowed through when facility is affirmative (backward compat).
 *   4. Coexistence with T-2026-118 corner keys / T-2026-119 pricing
 *      keys / T-2026-120 EMI keys / T-2026-116 plot area keys.
 *   5. Empty draft pass-through / null pass-through.
 *   6. Route module load smoke (inventory + enquiry both use the
 *      shared validator).
 *   7. Legacy 'yes'/'no' facility strings + JV outlier 'Allotted' as
 *      facility -> parkingType STRIPPED (non-affirmative).
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

console.log('T-2026-121 Parking dependency BE smoke');
console.log('======================================');

// ---- Case 1a: Available + Allotted -> preserved ----
{
  const input = { parkingFacility: 'Available', parkingType: 'Allotted' };
  const { value, errors } = validateDynamicData(input);
  asrt('C1a no errors', errors.length === 0, errors);
  asrt('C1a parkingFacility preserved', value.parkingFacility === 'Available', value.parkingFacility);
  asrt('C1a parkingType preserved (Allotted)', value.parkingType === 'Allotted', value.parkingType);
}

// ---- Case 1b: Available + Common -> preserved ----
{
  const input = { parkingFacility: 'Available', parkingType: 'Common' };
  const { value } = validateDynamicData(input);
  asrt('C1b parkingType preserved (Common)', value.parkingType === 'Common', value.parkingType);
}

// ---- Case 1c: Essential + Allotted -> preserved (rent/lease variant) ----
{
  const input = { parkingFacility: 'Essential', parkingType: 'Allotted' };
  const { value } = validateDynamicData(input);
  asrt('C1c Essential + Allotted preserved', value.parkingFacility === 'Essential' && value.parkingType === 'Allotted', value);
}

// ---- Case 1d: Required + Common -> preserved (hostel semantic) ----
{
  const input = { parkingFacility: 'Required', parkingType: 'Common' };
  const { value } = validateDynamicData(input);
  asrt('C1d Required + Common preserved', value.parkingFacility === 'Required' && value.parkingType === 'Common', value);
}

// ---- Case 2a: Not Available + populated -> STRIPPED ----
{
  const input = { parkingFacility: 'Not Available', parkingType: 'Allotted' };
  const { value } = validateDynamicData(input);
  asrt('C2a parkingFacility preserved', value.parkingFacility === 'Not Available', value.parkingFacility);
  asrt('C2a parkingType STRIPPED', !('parkingType' in value), Object.keys(value));
}

// ---- Case 2b: Not Essential + populated -> STRIPPED ----
{
  const input = { parkingFacility: 'Not Essential', parkingType: 'Common' };
  const { value } = validateDynamicData(input);
  asrt('C2b parkingType STRIPPED on Not Essential', !('parkingType' in value), Object.keys(value));
}

// ---- Case 2c: Not Required + populated -> STRIPPED ----
{
  const input = { parkingFacility: 'Not Required', parkingType: 'Allotted' };
  const { value } = validateDynamicData(input);
  asrt('C2c parkingType STRIPPED on Not Required', !('parkingType' in value), Object.keys(value));
}

// ---- Case 2d: missing facility -> STRIPPED ----
{
  const input = { parkingType: 'Allotted' };
  const { value } = validateDynamicData(input);
  asrt('C2d parkingType STRIPPED when facility missing', !('parkingType' in value), Object.keys(value));
}

// ---- Case 2e: blank facility -> STRIPPED ----
{
  const input = { parkingFacility: '', parkingType: 'Allotted' };
  const { value } = validateDynamicData(input);
  asrt('C2e parkingType STRIPPED when facility blank', !('parkingType' in value), Object.keys(value));
}

// ---- Case 2f: null facility -> STRIPPED (any() catches) ----
{
  const input = { parkingFacility: null, parkingType: 'Allotted' };
  const { value } = validateDynamicData(input);
  asrt('C2f parkingType STRIPPED when facility null', !('parkingType' in value), Object.keys(value));
}

// ---- Case 3: legacy non-canonical parkingType values allowed through ----
{
  const input = { parkingFacility: 'Available', parkingType: 'Open' };
  const { value } = validateDynamicData(input);
  asrt('C3a legacy "Open" allowed when Available', value.parkingType === 'Open', value.parkingType);
}
{
  const input = { parkingFacility: 'Available', parkingType: 'Covered' };
  const { value } = validateDynamicData(input);
  asrt('C3b legacy "Covered" allowed when Available', value.parkingType === 'Covered', value.parkingType);
}
{
  const input = { parkingFacility: 'Available', parkingType: 'Basement' };
  const { value } = validateDynamicData(input);
  asrt('C3c legacy "Basement" allowed when Available', value.parkingType === 'Basement', value.parkingType);
}

// ---- Case 4: coexistence with prior tasks ----
{
  const input = {
    // T-116 plot area
    plotAreaSqMt: '100', plotAreaSqFt: '1076.39', plotAreaSqYd: '119.60',
    // T-118 corners + Facing pairs
    corners: '3', plotFront3Facing: 'North', plotFront3RoadWidth: '10',
    // T-119 built-up pricing
    ratePerSqFt: '5000', governmentRatePerSqFt: '4500',
    // T-120 EMI
    emiOption: 'Available', emiCount: '6', emiAmount: 50000,
    // T-121 parking
    parkingFacility: 'Available', parkingType: 'Allotted',
  };
  const { value, errors } = validateDynamicData(input);
  asrt('C4 mixed no errors', errors.length === 0, errors);
  asrt('C4 T-116 plotAreaSqMt kept', value.plotAreaSqMt === 100 || value.plotAreaSqMt === '100', value.plotAreaSqMt);
  asrt('C4 T-118 corners kept', value.corners === '3', value.corners);
  asrt('C4 T-118 plotFront3Facing kept', value.plotFront3Facing === 'North', value.plotFront3Facing);
  asrt('C4 T-119 ratePerSqFt kept', value.ratePerSqFt === 5000 || value.ratePerSqFt === '5000', value.ratePerSqFt);
  asrt('C4 T-120 emiCount kept', value.emiCount === '6', value.emiCount);
  asrt('C4 T-121 parkingType kept', value.parkingType === 'Allotted', value.parkingType);
}

// ---- Case 4b: mixed T-120 + T-121 both strip on negative ----
{
  const input = {
    emiOption: 'Not Available', emiCount: '6', emiAmount: 50000,
    parkingFacility: 'Not Available', parkingType: 'Allotted',
  };
  const { value } = validateDynamicData(input);
  asrt('C4b T-120 emiCount STRIPPED', !('emiCount' in value), Object.keys(value));
  asrt('C4b T-120 emiAmount STRIPPED', !('emiAmount' in value), Object.keys(value));
  asrt('C4b T-121 parkingType STRIPPED', !('parkingType' in value), Object.keys(value));
  asrt('C4b emiOption preserved', value.emiOption === 'Not Available', value.emiOption);
  asrt('C4b parkingFacility preserved', value.parkingFacility === 'Not Available', value.parkingFacility);
}

// ---- Case 5a: empty payload ----
{
  const input = {};
  const { value, errors } = validateDynamicData(input);
  asrt('C5a empty no errors', errors.length === 0, errors);
  asrt('C5a empty stays empty', Object.keys(value).length === 0, Object.keys(value));
}

// ---- Case 5b: null ----
{
  const { value, errors } = validateDynamicData(null);
  asrt('C5b null no errors', errors.length === 0, errors);
  asrt('C5b null stays null', value === null, value);
}

// ---- Case 6: route module load ----
{
  try {
    require(path.join(__dirname, '..', 'server', 'routes', 'admin', 'inventory-properties'));
    asrt('C6a inventory-properties route loads', true);
  } catch (e) {
    asrt('C6a inventory-properties route loads', false, String(e));
  }
  try {
    require(path.join(__dirname, '..', 'server', 'routes', 'admin', 'enquiry-properties'));
    asrt('C6b enquiry-properties route loads', true);
  } catch (e) {
    asrt('C6b enquiry-properties route loads', false, String(e));
  }
}

// ---- Case 7a: legacy 'yes' facility -> STRIPPED (non-affirmative) ----
{
  const input = { parkingFacility: 'yes', parkingType: 'Allotted' };
  const { value } = validateDynamicData(input);
  asrt('C7a legacy "yes" (lowercase) treated as non-affirmative -> parkingType STRIPPED', !('parkingType' in value), Object.keys(value));
}

// ---- Case 7b: legacy 'no' facility -> STRIPPED ----
{
  const input = { parkingFacility: 'no', parkingType: 'Allotted' };
  const { value } = validateDynamicData(input);
  asrt('C7b legacy "no" -> parkingType STRIPPED', !('parkingType' in value), Object.keys(value));
}

// ---- Case 7c: JV outlier facility='Allotted' (flat L1352 MD-verbatim) -> STRIPPED ----
{
  const input = { parkingFacility: 'Allotted', parkingType: 'Common' };
  const { value } = validateDynamicData(input);
  asrt('C7c JV outlier facility=Allotted -> parkingType STRIPPED (intentional MD quirk)', !('parkingType' in value), Object.keys(value));
  asrt('C7c facility preserved verbatim (Allotted)', value.parkingFacility === 'Allotted', value.parkingFacility);
}

// ---- Case 8: parkingType='' + Available -> preserved as blank draft ----
{
  const input = { parkingFacility: 'Available', parkingType: '' };
  const { value } = validateDynamicData(input);
  asrt('C8a blank parkingType kept when Available', value.parkingType === '', value.parkingType);
}

// ---- Case 8b: parkingType null + Available -> preserved as null ----
{
  const input = { parkingFacility: 'Available', parkingType: null };
  const { value } = validateDynamicData(input);
  asrt('C8b null parkingType kept when Available', value.parkingType === null, value.parkingType);
}

// ---- Summary ----
console.log('\n----------------------------------------------------');
console.log(`T-2026-121 BE smoke: ${pass} PASS / ${fail} FAIL (${pass + fail} total)`);
if (fail > 0) process.exit(1);
