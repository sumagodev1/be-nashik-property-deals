/**
 * Service layer for the four master vocabularies. The repo handles SQL with a
 * whitelisted table name; this layer adds:
 *   - the masterKey → table mapping (so the route layer never sees raw table
 *     names)
 *   - duplicate-code prevention with a user-friendly error
 *   - DTO shaping for the API response (camelCase, boolean isActive)
 *   - guard against deleting the last remaining row referenced by inventory
 *     or website properties (best-effort — DB has no FK because the column
 *     stores a code string, not an id)
 */

const { HttpError } = require('../../middleware/errors');
const repo = require('../../db/queries/masters');
const { pool } = require('../../db/pool');

// Inventory / form lookup vocabularies that live inside the generic
// `master_lookups` table (one row per option, scoped by master_key). The key
// itself is the only thing that distinguishes them from the four legacy
// single-vocabulary tables below — everything else (CRUD, validation, public
// dropdown endpoint, frontend MasterListPage) is shared.
//
// Adding a new vocabulary is a one-line change here + a seed in migrations.
const LOOKUP_KEYS = Object.freeze([
  // property-spec
  'floor_level', 'facing', 'lease_period',
  'plot_type', 'plot_sub_industrial', 'plot_shape', 'road_width', 'road_front_type',
  // land
  'land_type', 'land_zone', 'land_variety', 'defect_land',
  // financial / sale terms
  'bank_name', 'payment_mode', 'payment_period', 'payment_white_percent',
  'token_amount', 'booking_amount_percent', 'yearly_hike_percent', 'bunglow_age_range',
  // construction / project
  'phase', 'wing', 'possession_month', 'possession_year', 'tdr_floor',
  // amenities
  'amenities_residential', 'amenities_bunglow_furniture', 'amenities_plot',
  'amenities_commercial', 'amenities_hostel',
  // tenant / hostel
  'tenant_preference', 'shop_expected_tenant', 'commercial_expected_tenant',
  'hostel_residence',
  // new property-type vocabularies
  'hospital_type', 'industrial_shed_type', 'allotted_area_to_owner',
  // contacts
  'contact_relation', 'contact_type', 'lead_source',
  // hierarchical location (parent_code drives the cascade)
  'district', 'taluka', 'shivar',
  // Phase-2 — added in migration 029. Each gets a sub-section in the new
  // property-type forms (Land sub-types, SEZ, TDR, Pre-Leased, Bank Auction).
  'land_sub_type_res', 'land_sub_type_ind', 'land_reservation',
  'sez_type', 'tdr_zone', 'pre_leased_project_type', 'bank_auction_pending_dues',
  // Bunglow MD-driven masters — added in migration 030. The Bunglow inventory
  // forms (bungalow-forms.md) drive every multi-option field through these.
  'bunglow_size', 'bunglow_facing_specific', 'bunglow_facing_any',
  'bunglow_age_specific', 'bunglow_condition', 'bunglow_status',
  'bunglow_defect_built', 'bunglow_defect_community',
  'bunglow_lease_monthly_budget', 'bunglow_lease_yearly_budget',
  'bunglow_deposit_budget', 'bunglow_rent_monthly_budget',
  'bunglow_rent_deposit_budget', 'bunglow_tenant_preference',
  'bunglow_booking_amount_fixed', 'bunglow_possession_after',
  // Commercial Space MD-driven masters — added in migration 031. Sourced
  // from `reference of forms/Commercial Space Registration Forms.md`.
  'commercial_facing_specific', 'commercial_facing_any',
  'commercial_age_specific', 'commercial_condition', 'commercial_status',
  'commercial_defect_built', 'commercial_defect_community',
  'commercial_lease_monthly_budget', 'commercial_lease_yearly_budget',
  'commercial_deposit_budget', 'commercial_rent_budget',
  'commercial_booking_amount_fixed',
  // Flat MD-driven masters — added in migration 032. Sourced from
  // `reference of forms/Flat Registration Forms.md`.
  'flat_type', 'flat_size', 'flat_facing_specific', 'flat_facing_any',
  'flat_age_specific', 'flat_condition', 'flat_status', 'flat_nature',
  'flat_parking_type', 'flat_no_of_car_parking',
  'flat_defect_built', 'flat_defect_community',
  'flat_lease_monthly_budget', 'flat_lease_yearly_budget',
  'flat_deposit_budget', 'flat_development_ratio', 'flat_tdr_purchase',
  'flat_booking_amount_fixed', 'flat_possession_after',
  'flat_indoor_amenities', 'flat_outdoor_amenities',
  // Hostel MD-driven masters — added in migration 033. Sourced from
  // `reference of forms/Hostel Registration Form.md`.
  'hostel_category', 'hostel_rooms_count', 'hostel_facing',
  'hostel_condition', 'hostel_status', 'hostel_amount_budget',
  // Land MD-driven masters — added in migration 034. Sourced from
  // `reference of forms/Land Registration Forms.md`.
  'land_sub_type', 'land_category_residential', 'land_category_commercial',
  'land_category_industrial', 'land_facing', 'land_status',
  'land_area_unit', 'land_lease_monthly_budget', 'land_lease_yearly_budget',
  'land_deposit_budget',
  // Paying Guest MD-driven masters — added in migration 035. Sourced from
  // `reference of forms/Paying Guest Registration Forms.md`.
  'paying_guest_size', 'paying_guest_floor', 'paying_guest_facing',
  'paying_guest_condition', 'paying_guest_status', 'paying_guest_defect_built',
  // Plot MD-driven masters — added in migration 036. Sourced from
  // `reference of forms/Plot Registration Form.md`.
  'plot_sub_residential', 'plot_sub_commercial', 'plot_facing',
  'plot_corner', 'plot_layout_status', 'plot_status', 'plot_area_unit',
  'plot_rate_unit', 'plot_amenities', 'plot_emi_count',
  'plot_emi_booking_percent', 'plot_lease_monthly_budget',
  'plot_lease_yearly_budget', 'plot_deposit_budget',
  // SEZ MD-driven masters — added in migration 037. Sourced from
  // `reference of forms/SEZ Registration Form.md`. (`sez_type` is legacy.)
  'sez_infrastructural_facilities', 'sez_fiscal_incentives',
  // Shop MD-driven masters — added in migration 038. Sourced from
  // `reference of forms/Shop Registration Forms.md`. (`shop_expected_tenant`
  // is a legacy key — only its seed gets topped up.)
  'shop_facing_specific', 'shop_facing_any', 'shop_age_specific',
  'shop_condition', 'shop_status', 'shop_defect_built', 'shop_defect_community',
  'shop_lease_monthly_budget', 'shop_lease_yearly_budget', 'shop_deposit_budget',
  'shop_booking_amount_fixed',
  // TDR MD-driven masters — added in migration 039. Sourced from
  // `reference of forms/TDR Registration Form.md`. (`tdr_zone` and
  // `tdr_floor` are legacy keys — only their seeds get topped up.)
  'tdr_plot_facing', 'tdr_development_ratio', 'tdr_purchase', 'tdr_status',
  // Bank Auction MD-driven masters — added in migration 040. Sourced from
  // `reference of forms/Bank Auction Registration Form.md`.
  // (`bank_auction_pending_dues` is a legacy key — only its seed gets
  //  topped up.)
  'bank_auction_project_type',
  // Industrial Plot MD-driven masters — added in migration 042. Sourced
  // from `reference of forms/Industrial Plot Registration Form.md`.
  'industrial_plot_status', 'industrial_permitted_industry',
  'industrial_previous_transfer_order', 'industrial_bank_statement_period',
  // Project MD-driven masters — added in migration 044. Sourced from
  // `reference of forms/Project Registration Form.md`.
  'project_facing', 'project_condition', 'project_defect_built',
  'project_sale_status',
]);

const MASTER_TABLES = Object.freeze({
  property_type:    'master_property_types',
  transaction_type: 'master_transaction_types',
  flat_type:        'master_flat_types',
  status_type:      'master_status_types',
  ...Object.fromEntries(LOOKUP_KEYS.map((k) => [k, 'master_lookups'])),
});

const MASTER_LABELS = Object.freeze({
  // Global — used across all forms (system top-level selectors, location cascade,
  // contact/lead fields rendered by the shared inventory shell).
  property_type:    'Global / Property Type',
  transaction_type: 'Global / Transaction Type',
  status_type:      'Global / Status',
  contact_relation: 'Global / Contact Relation',
  contact_type:     'Global / Contact Type',
  lead_source:      'Global / Lead Source',
  district:         'Global / District',
  taluka:           'Global / Taluka',
  shivar:           'Global / Village',
  facing:           'Global / Facing (legacy)',
  // Global / Sale Forms — rendered on every sale-transaction form via the
  // shared inventory shell (isPriceBased / TXN_SALE_LIKE guard).
  bank_name:              'Global / Sale Forms / Bank Name',
  token_amount:           'Global / Sale Forms / Token Amount',
  payment_mode:           'Global / Sale Forms / Payment Mode',
  payment_period:         'Global / Sale Forms / Payment Period',
  payment_white_percent:  'Global / Sale Forms / Payment (White) %',
  booking_amount_percent: 'Global / Sale Forms / Booking Amount %',
  possession_month:       'Global / Sale Forms / Possession Month',
  possession_year:        'Global / Sale Forms / Possession Year',
  phase:                  'Global / Sale Forms / Phase',
  wing:                   'Global / Sale Forms / Wing',
  // Global / Lease Forms — rendered on every lease-transaction form.
  lease_period:        'Global / Lease Forms / Lease Period',
  yearly_hike_percent: 'Global / Lease Forms / Yearly Hike %',
  // Global / <family list> — shared across a specific set of families.
  floor_level:            'Global / Flat / Bunglow / Hostel / Floor Level',
  amenities_residential:  'Global / Flat / Bunglow / Residential Amenities',
  amenities_commercial:   'Global / Shop / Commercial Space / Amenities',
  amenities_plot:         'Global / Plot / Land / Amenities',
  amenities_hostel:       'Global / Hostel / Paying Guest / Amenities',
  road_width:             'Global / Plot / Land / Flat / Industrial Plot / TDR / Road Width',
  road_front_type:        'Global / Plot / Land / Road Front Type',
  tenant_preference:      'Global / Flat / Bunglow / Tenant Preference',
  allotted_area_to_owner: 'Global / Flat / TDR / Allotted Area to Owner',
  // Single-family lookup keys — labels surface in the admin sidebar + page titles.
  plot_type:                   'Plot type',
  plot_sub_industrial:         'Plot sub-type (industrial)',
  plot_shape:                  'Plot shape',
  land_type:                   'Land type',
  land_zone:                   'Land zone',
  land_variety:                'Land variety',
  defect_land:                 'Land defect',
  bunglow_age_range:           'Bunglow age range',
  tdr_floor:                   'TDR floor',
  amenities_bunglow_furniture: 'Bunglow furniture',
  shop_expected_tenant:        'Shop expected tenant',
  commercial_expected_tenant:  'Commercial expected tenant',
  hostel_residence:            'Hostel residence',
  hospital_type:               'Hospital / Hospital Type',
  industrial_shed_type:        'Industrial shed type',
  land_sub_type_res:           'Land Sub-Type (Residential)',
  land_sub_type_ind:           'Land Sub-Type (Industrial)',
  land_reservation:            'Land Reservation',
  sez_type:                    'SEZ / Type of SEZ',
  tdr_zone:                    'TDR Zone',
  pre_leased_project_type:     'Global / Pre-Leased / Bank Auction / Project Type',
  bank_auction_pending_dues:   'Bank Auction Pending Dues',
  // Bunglow / X — hierarchical labels so they group in the Admin sidebar.
  bunglow_size:                 'Bunglow / Size',
  bunglow_facing_specific:      'Bunglow / Facing (Specific)',
  bunglow_facing_any:           'Bunglow / Facing (Any)',
  bunglow_age_specific:         'Bunglow / Age (Specific)',
  bunglow_condition:            'Bunglow / Condition',
  bunglow_status:               'Bunglow / Status',
  bunglow_defect_built:         'Bunglow / Defect (Built)',
  bunglow_defect_community:     'Bunglow / Defect (Community)',
  bunglow_lease_monthly_budget: 'Bunglow / Lease Budget (Monthly)',
  bunglow_lease_yearly_budget:  'Bunglow / Lease Budget (Yearly)',
  bunglow_deposit_budget:       'Bunglow / Deposit Budget',
  bunglow_rent_monthly_budget:  'Bunglow / Rent Budget (Monthly)',
  bunglow_rent_deposit_budget:  'Bunglow / Rent Deposit Budget',
  bunglow_tenant_preference:    'Bunglow / Tenant Preference',
  bunglow_booking_amount_fixed: 'Bunglow / Booking Amount (Fixed)',
  bunglow_possession_after:     'Bunglow / Possession After',
  // Commercial Space / X
  commercial_facing_specific:      'Commercial Space / Facing (Specific)',
  commercial_facing_any:           'Commercial Space / Facing (Any)',
  commercial_age_specific:         'Commercial Space / Age (Specific)',
  commercial_condition:            'Commercial Space / Condition',
  commercial_status:               'Commercial Space / Status',
  commercial_defect_built:         'Commercial Space / Defect (Built)',
  commercial_defect_community:     'Commercial Space / Defect (Community)',
  commercial_lease_monthly_budget: 'Commercial Space / Lease Budget (Monthly)',
  commercial_lease_yearly_budget:  'Commercial Space / Lease Budget (Yearly)',
  commercial_deposit_budget:       'Commercial Space / Deposit Budget',
  commercial_rent_budget:          'Commercial Space / Rent Budget',
  commercial_booking_amount_fixed: 'Commercial Space / Booking Amount (Fixed)',
  // Re-namespace the existing key so it groups under Commercial Space.
  commercial_expected_tenant:      'Commercial Space / Expected Tenant',
  // Flat / X
  flat_type:                       'Global / Flat / Bunglow / Flat Type',
  flat_size:                       'Flat / Flat Size',
  flat_facing_specific:            'Flat / Facing (Specific)',
  flat_facing_any:                 'Flat / Facing (Any)',
  flat_age_specific:               'Flat / Age (Specific)',
  flat_condition:                  'Flat / Condition',
  flat_status:                     'Flat / Status',
  flat_nature:                     'Flat / Nature',
  flat_parking_type:               'Flat / Parking Type',
  flat_no_of_car_parking:          'Flat / No. of Car Parking',
  flat_defect_built:               'Flat / Defect (Built)',
  flat_defect_community:           'Flat / Defect (Community)',
  flat_lease_monthly_budget:       'Flat / Lease Budget (Monthly)',
  flat_lease_yearly_budget:        'Flat / Lease Budget (Yearly)',
  flat_deposit_budget:             'Flat / Deposit Budget',
  flat_development_ratio:          'Flat / Development Ratio',
  flat_tdr_purchase:               'Flat / TDR Purchase',
  flat_booking_amount_fixed:       'Flat / Booking Amount (Fixed)',
  flat_possession_after:           'Flat / Possession After',
  flat_indoor_amenities:           'Flat / Indoor Amenities',
  flat_outdoor_amenities:          'Flat / Outdoor Amenities',
  // Hostel / X
  hostel_category:                 'Hostel / Category',
  hostel_rooms_count:              'Hostel / Rooms Count',
  hostel_facing:                   'Hostel / Facing',
  hostel_condition:                'Hostel / Condition',
  hostel_status:                   'Hostel / Status',
  hostel_amount_budget:            'Hostel / Amount Budget',
  // Re-namespace pre-existing legacy key.
  hostel_residence:                'Hostel / Residence',
  // Land / X — re-namespace several legacy keys to group in sidebar.
  land_type:                       'Land / Land Type',
  land_zone:                       'Land / Zoning',
  land_variety:                    'Land / Variety',
  defect_land:                     'Land / Defect',
  land_sub_type:                   'Land / Sub-Type',
  land_sub_type_res:               'Land / Sub-Type (Residential)',
  land_sub_type_ind:               'Land / Sub-Type (Industrial)',
  land_reservation:                'Land / Reservation',
  land_category_residential:       'Land / Category (Residential)',
  land_category_commercial:        'Land / Category (Commercial)',
  land_category_industrial:        'Land / Category (Industrial)',
  land_facing:                     'Land / Facing',
  land_status:                     'Land / Status',
  land_area_unit:                  'Land / Area Unit',
  land_lease_monthly_budget:       'Land / Lease Budget (Monthly)',
  land_lease_yearly_budget:        'Land / Lease Budget (Yearly)',
  land_deposit_budget:             'Land / Deposit Budget',
  // Paying Guest / X
  paying_guest_size:               'Paying Guest / Size',
  paying_guest_floor:              'Paying Guest / Floor',
  paying_guest_facing:             'Paying Guest / Facing',
  paying_guest_condition:          'Paying Guest / Condition',
  paying_guest_status:             'Paying Guest / Status',
  paying_guest_defect_built:       'Paying Guest / Defect (Built)',
  // Plot / X — re-namespaces several legacy keys.
  plot_type:                       'Plot / Plot Type',
  plot_sub_residential:            'Plot / Sub-Type (Residential)',
  plot_sub_commercial:             'Plot / Sub-Type (Commercial)',
  plot_sub_industrial:             'Plot / Sub-Type (Industrial)',
  plot_facing:                     'Plot / Facing',
  plot_corner:                     'Plot / Corner',
  plot_layout_status:              'Plot / Layout Status',
  plot_status:                     'Plot / Status',
  plot_area_unit:                  'Plot / Area Unit',
  plot_rate_unit:                  'Plot / Rate Unit',
  plot_amenities:                  'Plot / Amenities',
  plot_emi_count:                  'Plot / No. of EMIs',
  plot_emi_booking_percent:        'Plot / EMI Booking Amount %',
  plot_lease_monthly_budget:       'Plot / Lease Budget (Monthly)',
  plot_lease_yearly_budget:        'Plot / Lease Budget (Yearly)',
  plot_deposit_budget:             'Plot / Deposit Budget',
  plot_shape:                      'Global / Plot / Land / Shape',
  // SEZ / X
  sez_infrastructural_facilities:  'SEZ / Infrastructural Facilities',
  sez_fiscal_incentives:           'SEZ / Fiscal Incentives',
  // Shop / X
  shop_facing_specific:            'Shop / Facing (Specific)',
  shop_facing_any:                 'Shop / Facing (Any)',
  shop_age_specific:               'Shop / Age (Specific)',
  shop_condition:                  'Shop / Condition',
  shop_status:                     'Shop / Status',
  shop_defect_built:               'Shop / Defect (Built)',
  shop_defect_community:           'Shop / Defect (Community)',
  shop_lease_monthly_budget:       'Shop / Lease Budget (Monthly)',
  shop_lease_yearly_budget:        'Shop / Lease Budget (Yearly)',
  shop_deposit_budget:             'Shop / Deposit Budget',
  shop_booking_amount_fixed:       'Shop / Booking Amount (Fixed)',
  shop_expected_tenant:            'Shop / Expected Tenant',
  // TDR / X — re-namespaces legacy `tdr_zone` and `tdr_floor`.
  tdr_zone:                        'TDR / Zoning of TDR',
  tdr_floor:                       'TDR / Total Floors',
  tdr_plot_facing:                 'TDR / Plot Facing',
  tdr_development_ratio:           'TDR / Development Ratio',
  tdr_purchase:                    'TDR / TDR Purchase',
  tdr_status:                      'TDR / Status',
  // Bank Auction / X — re-namespaces legacy `bank_auction_pending_dues`.
  bank_auction_project_type:       'Bank Auction / Project Type',
  bank_auction_pending_dues:       'Bank Auction / Pending Dues',
  // Industrial Plot / X
  industrial_plot_status:              'Industrial Plot / Plot Status (Land Condition)',
  industrial_permitted_industry:       'Industrial Plot / Permitted Industry Type',
  industrial_previous_transfer_order:  'Industrial Plot / Previous Transfer Order',
  industrial_bank_statement_period:    'Industrial Plot / Bank Statement Period',
  industrial_shed_type:                'Industrial Plot / Shed Type',
  // Project / X
  project_facing:                  'Project / Facing',
  project_condition:               'Project / Condition',
  project_defect_built:            'Project / Defect (Built)',
  project_sale_status:             'Project / Sale Status',
});

// True for keys that live in master_lookups — drives the discriminator
// (the `master_key` column filter). The four legacy keys (property_type,
// transaction_type, flat_type, status_type) live in their own tables and
// don't need a discriminator.
function isLookupKey(masterKey) {
  return LOOKUP_KEYS.includes(masterKey);
}

function discriminatorFor(masterKey) {
  return isLookupKey(masterKey) ? { masterKey } : undefined;
}

// Fixed-vocabulary masters: the admin can toggle active/inactive on existing
// rows but cannot add, rename or delete them. The seeded list is the contract
// downstream filters and reports rely on.
const FIXED_MASTERS = new Set(['status_type']);
function assertNotFixed(masterKey, action) {
  if (FIXED_MASTERS.has(masterKey)) {
    throw new HttpError(
      403,
      'MASTER_FIXED',
      `${MASTER_LABELS[masterKey]} is a fixed vocabulary — ${action} is disabled. You can toggle individual rows active/inactive instead.`,
    );
  }
}

// Where each master is referenced. Used by the delete-safety check.
// Most `master_lookups` vocabularies (floor_level, facing, amenities_*, …)
// only appear inside `inventory_properties.details JSON`, which we don't
// usage-check because JSON traversal is expensive at scale. For those, the
// admin should `Deactivate` instead of `Delete` — same effect on dropdowns,
// no risk to historical rows. Hierarchical child-parent refs are checked
// inside `remove()` directly (see master_lookups.parent_code logic).
const USAGE_REFS = Object.freeze({
  property_type: [
    { table: 'inventory_properties', column: 'property_type' },
    { table: 'website_properties',   column: 'property_type' },
  ],
  transaction_type: [
    { table: 'inventory_properties', column: 'transaction_type' },
    { table: 'website_properties',   column: 'transaction_type' },
  ],
  flat_type: [
    { table: 'inventory_properties', column: 'bhk' },
    { table: 'website_properties',   column: 'bhk' },
  ],
  status_type: [
    { table: 'inventory_properties', column: 'status' },
  ],
  // Promoted-to-column lookups: tracked because they have a fast index.
  district: [{ table: 'inventory_properties', column: 'district' }],
  taluka:   [{ table: 'inventory_properties', column: 'taluka' }],
  shivar:   [{ table: 'inventory_properties', column: 'shivar' }],
});

function tableFor(masterKey) {
  const t = MASTER_TABLES[masterKey];
  if (!t) throw new HttpError(404, 'UNKNOWN_MASTER', `Unknown master "${masterKey}"`);
  return t;
}

function toDto(row) {
  if (!row) return null;
  const dto = {
    id: row.id,
    code: row.code,
    label: row.label,
    sortOrder: row.sort_order,
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  // master_lookups rows additionally carry parent_code for hierarchical
  // vocabularies (district → taluka → shivar). Expose it on the DTO so the
  // admin UI can render the parent + cascade dropdowns can filter children
  // by parentCode.
  if (Object.prototype.hasOwnProperty.call(row, 'parent_code')) {
    dto.parentCode = row.parent_code || null;
  }
  return dto;
}

function masterKeys() {
  return Object.keys(MASTER_TABLES);
}

function masterMeta(key) {
  return { key, label: MASTER_LABELS[key] || key };
}

async function list(masterKey, filters = {}) {
  const table = tableFor(masterKey);
  const discriminator = discriminatorFor(masterKey);
  const page = Math.max(1, Number(filters.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(filters.pageSize) || 10));
  const { rows, total } = await repo.list(table, { ...filters, page, pageSize, discriminator });
  return {
    master: masterMeta(masterKey),
    data: rows.map(toDto),
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

async function listAll(masterKey, filters = {}) {
  const rows = await repo.listAll(tableFor(masterKey), {
    ...filters,
    discriminator: discriminatorFor(masterKey),
  });
  return { master: masterMeta(masterKey), data: rows.map(toDto) };
}

async function getOne(masterKey, id) {
  const row = await repo.findById(tableFor(masterKey), id, { discriminator: discriminatorFor(masterKey) });
  if (!row) throw new HttpError(404, 'NOT_FOUND', `${MASTER_LABELS[masterKey]} not found`);
  return toDto(row);
}

async function activeCodes(masterKey) {
  return repo.activeCodes(tableFor(masterKey), { discriminator: discriminatorFor(masterKey) });
}

// Label rules vary per master. The strict masters accept letters + spaces
// only and cap at 30 chars (these are human category names — short and
// alphabetic, no numbers or punctuation). The lenient default still
// requires at least one letter but allows digits + a handful of punctuation
// because rows like "2 BHK" or "Showroom / Office" need them.
const LABEL_RULES = {
  property_type:    { maxLen: 30, pattern: 'alpha' },          // letters + spaces only
  transaction_type: { maxLen: 30, pattern: 'alpha' },          // letters + spaces only
  flat_type:        { maxLen: 30, pattern: 'alphanumeric' },   // letters + digits + spaces only
  status_type:      { maxLen: 64, pattern: 'lenient' },        // fixed master; rule unused
};
// Lookup-table keys all share the same lenient label rule — values like
// "5%" / "20-25 Years" / "Rs. 1,00,000" / "Generator / Battery Backup" all
// need digits + punctuation. Default applies if no per-key override is set.
const LOOKUP_LABEL_RULE = { maxLen: 100, pattern: 'lookup' };
const PATTERNS = {
  alpha:        /^[A-Za-z ]+$/,
  alphanumeric: /^[A-Za-z0-9 ]+$/,
  lenient:      /^[A-Za-z0-9 /()&,.\-]+$/,
  // Lookup labels see digit/percent/colon/Rs.-style values from registration
  // forms. Expanded set still excludes shell-meta and HTML-meta characters.
  lookup:       /^[A-Za-z0-9 /()&,.:%+\-]+$/,
};
const PATTERN_MESSAGES = {
  alpha:        'may only contain letters and spaces — digits and special characters are not allowed',
  alphanumeric: 'may only contain letters, digits, and spaces — special characters are not allowed',
  lenient:      'contains an unsupported character. Allowed: letters, digits, spaces, and / ( ) & , . -',
  lookup:       'contains an unsupported character. Allowed: letters, digits, spaces, and / ( ) & , . : % + -',
};

function assertValidLabel(masterKey, label) {
  const v = String(label || '').trim();
  if (!v) throw new HttpError(400, 'VALIDATION_ERROR', `${MASTER_LABELS[masterKey]} name is required`);

  const rule = LABEL_RULES[masterKey] || (isLookupKey(masterKey) ? LOOKUP_LABEL_RULE : { maxLen: 255, pattern: 'lenient' });
  if (v.length > rule.maxLen) {
    throw new HttpError(400, 'VALIDATION_ERROR', `${MASTER_LABELS[masterKey]} name must be at most ${rule.maxLen} characters`);
  }
  if (!/[A-Za-z]/.test(v)) {
    throw new HttpError(400, 'VALIDATION_ERROR', `${MASTER_LABELS[masterKey]} name must contain at least one letter`);
  }
  const regex = PATTERNS[rule.pattern] || PATTERNS.lenient;
  if (!regex.test(v)) {
    throw new HttpError(400, 'VALIDATION_ERROR', `${MASTER_LABELS[masterKey]} name ${PATTERN_MESSAGES[rule.pattern]}`);
  }
  return v;
}

async function create(masterKey, payload) {
  assertNotFixed(masterKey, 'creating new entries');
  const table = tableFor(masterKey);
  const discriminator = discriminatorFor(masterKey);
  const label = assertValidLabel(masterKey, payload.label);
  const code = String(payload.code || '').trim().toLowerCase();
  const parentCode = isLookupKey(masterKey)
    ? (payload.parentCode ? String(payload.parentCode).trim().toLowerCase() : null)
    : null;

  // Helpful duplicate errors — include the existing row's id + status so
  // the admin knows *where to find it* (often on a later pagination page
  // they didn't think to check) and whether it just needs reactivating.
  const existingByCode = await repo.findByCode(table, code, { discriminator });
  if (existingByCode) {
    const status = existingByCode.is_active ? 'currently active' : 'currently inactive — you can reactivate it';
    throw new HttpError(
      409,
      'CODE_TAKEN',
      `A ${MASTER_LABELS[masterKey].toLowerCase()} with code "${code}" already exists (#${existingByCode.id}, ${status}). Search the list for "${existingByCode.label}" to find it.`,
      { existingId: existingByCode.id, existingLabel: existingByCode.label, isActive: Boolean(existingByCode.is_active) },
    );
  }
  const existingByLabel = await repo.findByLabel(table, label, null, { discriminator });
  if (existingByLabel) {
    const status = existingByLabel.is_active ? 'currently active' : 'currently inactive — you can reactivate it';
    throw new HttpError(
      409,
      'LABEL_TAKEN',
      `A ${MASTER_LABELS[masterKey].toLowerCase()} named "${existingByLabel.label}" already exists (#${existingByLabel.id}, ${status}). Search the list for "${existingByLabel.label}" to find it.`,
      { existingId: existingByLabel.id, existingLabel: existingByLabel.label, isActive: Boolean(existingByLabel.is_active) },
    );
  }
  // Revive a soft-deleted twin if the admin is re-adding a previously-
  // deleted entry with the same code or label. The DB unique key on
  // (master_key, code) still covers deleted rows, so a fresh INSERT
  // hits ER_DUP_ENTRY. Reviving preserves the id + audit history and
  // gives the admin the "add worked" outcome they expected.
  const deletedByCode = await repo.findDeletedByCode(table, code, { discriminator });
  const deletedByLabel = deletedByCode
    ? null
    : await repo.findDeletedByLabel(table, label, { discriminator });
  const dead = deletedByCode || deletedByLabel;
  if (dead) {
    await repo.revive(table, dead.id, {
      code,
      label,
      sortOrder: Number(payload.sortOrder) || 0,
      isActive: payload.isActive !== false,
      parentCode,
    });
    return getOne(masterKey, dead.id);
  }
  const id = await repo.create(table, {
    code,
    label,
    sortOrder: Number(payload.sortOrder) || 0,
    isActive: payload.isActive !== false,
    masterKey: isLookupKey(masterKey) ? masterKey : undefined,
    parentCode,
  });
  return getOne(masterKey, id);
}

async function update(masterKey, id, payload) {
  const table = tableFor(masterKey);
  const discriminator = discriminatorFor(masterKey);
  const existing = await repo.findById(table, id, { discriminator });
  if (!existing) throw new HttpError(404, 'NOT_FOUND', `${MASTER_LABELS[masterKey]} not found`);
  // For fixed masters the admin may still flip is_active but cannot change
  // code or label. Strip those out of the payload before validation/persist.
  if (FIXED_MASTERS.has(masterKey)) {
    payload = { isActive: payload.isActive, sortOrder: payload.sortOrder };
  }
  // Label is only validated if it's actually being changed.
  const label = payload.label !== undefined
    ? assertValidLabel(masterKey, payload.label)
    : existing.label;
  const code = String(payload.code ?? existing.code).trim().toLowerCase();
  if (code !== existing.code && await repo.codeTaken(table, code, id, { discriminator })) {
    throw new HttpError(409, 'CODE_TAKEN', `A ${MASTER_LABELS[masterKey].toLowerCase()} with code "${code}" already exists`);
  }
  if (label.toLowerCase() !== String(existing.label).toLowerCase() && await repo.labelTaken(table, label, id, { discriminator })) {
    throw new HttpError(409, 'LABEL_TAKEN', `A ${MASTER_LABELS[masterKey].toLowerCase()} named "${label}" already exists`);
  }
  const parentCode = isLookupKey(masterKey)
    ? (payload.parentCode !== undefined
        ? (payload.parentCode ? String(payload.parentCode).trim().toLowerCase() : null)
        : (existing.parent_code || null))
    : null;
  await repo.update(table, id, {
    code,
    label,
    sortOrder: payload.sortOrder !== undefined ? Number(payload.sortOrder) : existing.sort_order,
    isActive: payload.isActive !== undefined ? Boolean(payload.isActive) : Boolean(existing.is_active),
    parentCode,
  }, { discriminator });
  return getOne(masterKey, id);
}

async function remove(masterKey, id) {
  assertNotFixed(masterKey, 'deleting entries');
  const table = tableFor(masterKey);
  const discriminator = discriminatorFor(masterKey);
  const existing = await repo.findById(table, id, { discriminator });
  if (!existing) throw new HttpError(404, 'NOT_FOUND', `${MASTER_LABELS[masterKey]} not found`);

  // Best-effort safety: if any non-deleted property row still references this
  // code, refuse the delete and ask the admin to reassign. Deactivating
  // (is_active = 0) is offered as an alternative since it doesn't break old
  // rows but hides the option from new-property dropdowns.
  const refs = USAGE_REFS[masterKey] || [];
  let inUse = 0;
  for (const ref of refs) {
    const [[{ n }]] = await pool.query(
      `SELECT COUNT(*) AS n FROM ${ref.table} WHERE ${ref.column} = ? AND deleted_at IS NULL`,
      [existing.code],
    );
    inUse += Number(n);
  }
  // Hierarchical masters: refuse delete if a child master row references the
  // code as its parent_code. e.g. cannot delete district "nashik" while any
  // taluka has parent_code = "nashik".
  if (isLookupKey(masterKey)) {
    const [[{ n }]] = await pool.query(
      `SELECT COUNT(*) AS n FROM master_lookups WHERE parent_code = ? AND deleted_at IS NULL`,
      [existing.code],
    );
    if (Number(n) > 0) {
      throw new HttpError(
        409,
        'IN_USE',
        `Cannot delete — ${n} child master row${n === 1 ? '' : 's'} reference${n === 1 ? 's' : ''} this ${MASTER_LABELS[masterKey].toLowerCase()} as its parent. Deactivate it instead.`,
      );
    }
  }
  if (inUse > 0) {
    throw new HttpError(
      409,
      'IN_USE',
      `Cannot delete — ${inUse} property record${inUse === 1 ? ' references' : 's reference'} this ${MASTER_LABELS[masterKey].toLowerCase()}. Deactivate it instead.`,
    );
  }
  await repo.softDelete(table, id, { discriminator });
}

// Used by inventory/website-property/seller-property services to validate
// that a code coming in from a form still corresponds to an active master row.
// Throws HttpError 400 with a friendly message if not.
async function assertActiveCode(masterKey, code) {
  if (code === undefined || code === null || code === '') return;
  const row = await repo.findByCode(tableFor(masterKey), code, { discriminator: discriminatorFor(masterKey) });
  if (!row || !row.is_active) {
    throw new HttpError(
      400,
      'INVALID_MASTER_CODE',
      `Unknown or inactive ${MASTER_LABELS[masterKey].toLowerCase()}: "${code}"`,
    );
  }
}

module.exports = {
  masterKeys,
  masterMeta,
  list,
  listAll,
  getOne,
  activeCodes,
  assertActiveCode,
  create,
  update,
  remove,
};
