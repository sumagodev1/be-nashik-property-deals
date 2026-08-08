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
// T-2026-045: uniform audit trail for master CRUD (create / update /
// activate / deactivate / delete). Emitted after the mutation is persisted
// so an audit-log failure never rolls back the user-visible change.
const audit = require('../admin/audit');

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
  // Global / Sale Forms / GST — added for the Advanced Land Pricing module
  // (migration 094). Populates the master-backed GST dropdown in the Financial
  // subsection of Land + SEZ Land Sale / Purchase forms. Codes encode the
  // numeric percentage (`5-pct`, `1-pct`, `0-pct`); labels are user-friendly
  // ("5%", "1%", "0%"). Admins extend the vocabulary inline via the standard
  // "Other → Save → Refresh" flow.
  'gst',
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
  // Enquiry / Relation — dedicated vocabulary for the Relation dropdown on
  // Enquiry forms (Owner Details + Key Person Details). Fully separate from
  // `contact_relation` (Inventory) so the two workflows evolve independently.
  // Seeded in migration 087.
  'enquiry_relation',
  // hierarchical location (parent_code drives the cascade)
  'district', 'taluka', 'shivar',
  // Phase-2 — added in migration 029. Each gets a sub-section in the new
  // property-type forms (Land sub-types, SEZ, TDR, Pre-Leased, Bank Auction).
  'land_sub_type_res', 'land_sub_type_ind', 'land_reservation',
  'sez_type', 'tdr_zone', 'pre_leased_project_type', 'bank_auction_pending_dues',
  // Bunglow MD-driven masters — added in migration 030. The Bunglow inventory
  // forms (bungalow-forms.md) drive every multi-option field through these.
  'bunglow_size', 'bunglow_facing_specific', 'bunglow_facing_any',
  'bunglow_age_specific', 'bunglow_condition', /* 'bunglow_status', — DISABLED (T-2026-081): per-property Status masters retired in favour of the global `status_type` (Inventory) / `enquiry_status` (Enquiry) masters. Rows remain in master_lookups for backward-compat; only the key registration is off. */
  'bunglow_defect_built', 'bunglow_defect_community',
  'bunglow_lease_monthly_budget', 'bunglow_lease_yearly_budget',
  'bunglow_deposit_budget', 'bunglow_rent_monthly_budget',
  'bunglow_rent_deposit_budget', 'bunglow_tenant_preference',
  'bunglow_booking_amount_fixed', 'bunglow_possession_after',
  // Rowhouse MD-driven masters — added in migration 084. Rowhouse is a new
  // Property Type parallel to Bungalow (no Bungalow masters reused). The
  // extra `rowhouse_property_position` key replaces the retired "Bunglow
  // Type" field (Left Corner / Middle / Right Corner).
  // `rowhouse_age_range` mirrors `bunglow_age_range`; `amenities_rowhouse_furniture`
  // mirrors `amenities_bunglow_furniture`.
  'rowhouse_property_position',
  'rowhouse_size', 'rowhouse_facing_specific', 'rowhouse_facing_any',
  'rowhouse_age_specific', 'rowhouse_age_range', 'rowhouse_condition',
  'rowhouse_defect_built', 'rowhouse_defect_community',
  'rowhouse_lease_monthly_budget', 'rowhouse_lease_yearly_budget',
  'rowhouse_deposit_budget', 'rowhouse_rent_monthly_budget',
  'rowhouse_rent_deposit_budget', 'rowhouse_tenant_preference',
  'rowhouse_booking_amount_fixed', 'rowhouse_possession_after',
  'amenities_rowhouse_furniture',
  // Commercial Space MD-driven masters — added in migration 031. Sourced
  // from `reference of forms/Commercial Space Registration Forms.md`.
  'commercial_facing_specific', 'commercial_facing_any',
  'commercial_age_specific', 'commercial_condition', /* 'commercial_status', — DISABLED (T-2026-081): per-property Status masters retired */
  'commercial_defect_built', 'commercial_defect_community',
  'commercial_lease_monthly_budget', 'commercial_lease_yearly_budget',
  'commercial_deposit_budget', 'commercial_rent_budget',
  'commercial_booking_amount_fixed',
  // Flat MD-driven masters — added in migration 032. Sourced from
  // `reference of forms/Flat Registration Forms.md`.
  'flat_type', 'flat_size', 'flat_facing_specific', 'flat_facing_any',
  'flat_age_specific', 'flat_condition', /* 'flat_status', — DISABLED (T-2026-081): per-property Status masters retired */ 'flat_nature',
  'flat_parking_type', 'flat_no_of_car_parking',
  'flat_defect_built', 'flat_defect_community',
  'flat_lease_monthly_budget', 'flat_lease_yearly_budget',
  'flat_deposit_budget', 'flat_development_ratio', 'flat_tdr_purchase',
  'flat_booking_amount_fixed', 'flat_possession_after',
  'flat_indoor_amenities', 'flat_outdoor_amenities',
  // Hostel MD-driven masters — added in migration 033. Sourced from
  // `reference of forms/Hostel Registration Form.md`.
  'hostel_category', 'hostel_rooms_count', 'hostel_facing',
  'hostel_condition', /* 'hostel_status', — DISABLED (T-2026-081): per-property Status masters retired */ 'hostel_amount_budget',
  // Land MD-driven masters — added in migration 034. Sourced from
  // `reference of forms/Land Registration Forms.md`.
  'land_sub_type', 'land_category_residential', 'land_category_commercial',
  'land_category_industrial', 'land_facing', /* 'land_status', — DISABLED (T-2026-081): per-property Status masters retired */
  'land_area_unit', 'land_lease_monthly_budget', 'land_lease_yearly_budget',
  'land_deposit_budget',
  // Paying Guest MD-driven masters — added in migration 035. Sourced from
  // `reference of forms/Paying Guest Registration Forms.md`.
  'paying_guest_size', 'paying_guest_floor', 'paying_guest_facing',
  'paying_guest_condition', /* 'paying_guest_status', — DISABLED (T-2026-081): per-property Status masters retired */ 'paying_guest_defect_built',
  // Plot MD-driven masters — added in migration 036. Sourced from
  // `reference of forms/Plot Registration Form.md`.
  'plot_sub_residential', 'plot_sub_commercial', 'plot_facing',
  'plot_corner', 'plot_layout_status', /* 'plot_status', — DISABLED (T-2026-081): per-property Status masters retired */ 'plot_area_unit',
  'plot_rate_unit', 'plot_amenities', 'plot_emi_count',
  'plot_emi_booking_percent', 'plot_lease_monthly_budget',
  'plot_lease_yearly_budget', 'plot_deposit_budget',
  // T-2026-047: Plot Category (Residential) — new master vocabulary
  // that replaces the legacy inline radio. Cascaded on plotType.
  'plot_category_residential',
  // SEZ MD-driven masters — added in migration 037. Sourced from
  // `reference of forms/SEZ Registration Form.md`. (`sez_type` is legacy.)
  'sez_infrastructural_facilities', 'sez_fiscal_incentives',
  // Shop MD-driven masters — added in migration 038. Sourced from
  // `reference of forms/Shop Registration Forms.md`. (`shop_expected_tenant`
  // is a legacy key — only its seed gets topped up.)
  'shop_facing_specific', 'shop_facing_any', 'shop_age_specific',
  'shop_condition', /* 'shop_status', — DISABLED (T-2026-081): per-property Status masters retired */ 'shop_defect_built', 'shop_defect_community',
  'shop_lease_monthly_budget', 'shop_lease_yearly_budget', 'shop_deposit_budget',
  'shop_booking_amount_fixed',
  // TDR MD-driven masters — added in migration 039. Sourced from
  // `reference of forms/TDR Registration Form.md`. (`tdr_zone` and
  // `tdr_floor` are legacy keys — only their seeds get topped up.)
  'tdr_plot_facing', 'tdr_development_ratio', 'tdr_purchase', /* 'tdr_status', — DISABLED (T-2026-081): per-property Status masters retired */
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
  /* 'project_sale_status', — DISABLED (T-2026-081): per-property Status masters retired */
  // Land Record Management masters — added in migration 047. Sourced from
  // `reference of forms/LandRecordManagement.md`. Only the Paper Notice
  // form contributes masters; the Gaothan + Survey Number forms reuse
  // the global district/taluka/shivar cascade.
  'paper_notice_paper_name',
  'paper_notice_area',
  'paper_notice_pot_kharba',
  'paper_notice_total_area',
  'paper_notice_owners_area',
  'paper_notice_saleable_area',
  // Business Associates directory — added in migration 051. Populates the
  // Designation dropdown on the Admin → Business Associates form. The
  // dropdown UI appends its own "Others" sentinel at the end, so we do not
  // seed a literal "Others" row here.
  'business_associate_designation',
  // Phone Book directory — added in migration 069. Populates the
  // Designation dropdown on the Admin → Phone Book form. Intentionally
  // separate from `business_associate_designation` so the two modules
  // curate their own vocabularies independently.
  'phone_book_designation',
  // Global / Property Variety — added in migration 054. Drives the
  // "By Property Variety" dashboard card + future variety filters. Values
  // are pure category names (Resale, New, Under Construction, etc.), so the
  // default LOOKUP_LABEL_RULE applies (letters/digits/spaces + / ( ) & , . : % + -).
  'property_variety',
  // Global / Project Name — added in migration 072. Single reusable
  // vocabulary for the "Project Name" / "Name of Project" dropdowns across
  // Flat (Inventory + Enquiry), Project, Pre-Leased and Bank Auction forms.
  // Admin-curated + grown via the in-form "Other → Save" flow. Pure category
  // names, so the default LOOKUP_LABEL_RULE applies.
  'project_name',
  // Global / Location — added in migration 073. Single reusable vocabulary
  // for the "Location" field (formerly "Location with Landmark Required") on
  // the Enquiry registration forms — the dualMode "Specific" side. Admin-
  // curated + grown via the in-form "Other → Save" flow. Pure locality names,
  // so the default LOOKUP_LABEL_RULE applies.
  'location',
  // Enquiry / Property Status — added in migration 075. Split out from the
  // shared `status_type` master (which continues to serve Inventory) so the
  // two workflows can evolve independently. Seeds four defaults each with a
  // Description/Meaning; the legacy inventory-style codes (available/sold/
  // rented/inactive) are seeded as INACTIVE so historical enquiry rows still
  // resolve to a human label without offering those codes in new dropdowns.
  'enquiry_status',
  // Website-scoped masters — added in migration 055. Deliberately
  // INDEPENDENT from the Global masters above so the public Seller
  // Registration + Add-Property flow can evolve its vocabulary without
  // affecting Admin Inventory/Enquiry (and vice versa). Same CRUD /
  // validator / dropdown surface — only the master_key differs.
  'website_property_type',
  'website_transaction_type',
  'website_property_variety',
  // Hotel MD-driven masters — added in migration 085. Sourced from
  // `reference of forms/hotel.md`. Only `hotel_type` is expandable
  // (Other → Save flow via TEXT_MASTER_SELECT_CONFIG on the FE); every
  // other key is a fixed Available / Not Available pair and is listed in
  // FIXED_VALUE_MASTERS on the FE so no Other UI renders.
  'hotel_type',
  // Utilities (6)
  'hotel_generator_power_backup', 'hotel_inverter_ups_support',
  'hotel_water_tanks', 'hotel_water_pumps',
  'hotel_lift_facility', 'hotel_parking_facility',
  // Technology Setup (9)
  'hotel_billing_computer', 'hotel_pos_software', 'hotel_online_ordering_system',
  'hotel_receipt_printer', 'hotel_qr_menu', 'hotel_barcode_scanner',
  'hotel_card_payment_machine', 'hotel_inventory_mgmt_software', 'hotel_cctv_monitoring',
  // Essential Licenses (7)
  'hotel_fssai_license', 'hotel_gst_registration', 'hotel_shop_establishment_reg',
  'hotel_trade_license', 'hotel_fire_noc', 'hotel_pollution_approvals',
  'hotel_music_playing_license',
  // Checklist Before Buying (5)
  'hotel_commercial_use_permission', 'hotel_adequate_water_supply',
  'hotel_3phase_electricity', 'hotel_kitchen_exhaust_route',
  'hotel_high_footfall_location',
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
  status_type:      'Inventory / Property Status',
  enquiry_status:   'Enquiry / Property Status',
  enquiry_relation: 'Enquiry / Relation',
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
  gst:                 'Global / Sale Forms / GST',
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
  // bunglow_status:               'Bunglow / Status', — DISABLED (T-2026-081)
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
  // Rowhouse / X — hierarchical labels, parallel to Bungalow.
  rowhouse_property_position:    'Rowhouse / Property Position',
  rowhouse_size:                 'Rowhouse / Size',
  rowhouse_facing_specific:      'Rowhouse / Facing (Specific)',
  rowhouse_facing_any:           'Rowhouse / Facing (Any)',
  rowhouse_age_specific:         'Rowhouse / Age (Specific)',
  rowhouse_age_range:            'Rowhouse / Age Range',
  rowhouse_condition:            'Rowhouse / Condition',
  rowhouse_defect_built:         'Rowhouse / Defect (Built)',
  rowhouse_defect_community:     'Rowhouse / Defect (Community)',
  rowhouse_lease_monthly_budget: 'Rowhouse / Lease Budget (Monthly)',
  rowhouse_lease_yearly_budget:  'Rowhouse / Lease Budget (Yearly)',
  rowhouse_deposit_budget:       'Rowhouse / Deposit Budget',
  rowhouse_rent_monthly_budget:  'Rowhouse / Rent Budget (Monthly)',
  rowhouse_rent_deposit_budget:  'Rowhouse / Rent Deposit Budget',
  rowhouse_tenant_preference:    'Rowhouse / Tenant Preference',
  rowhouse_booking_amount_fixed: 'Rowhouse / Booking Amount (Fixed)',
  rowhouse_possession_after:     'Rowhouse / Possession After',
  amenities_rowhouse_furniture:  'Rowhouse / Furniture',
  // Commercial Space / X
  commercial_facing_specific:      'Commercial Space / Facing (Specific)',
  commercial_facing_any:           'Commercial Space / Facing (Any)',
  commercial_age_specific:         'Commercial Space / Age (Specific)',
  commercial_condition:            'Commercial Space / Condition',
  // commercial_status:               'Commercial Space / Status', — DISABLED (T-2026-081)
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
  // flat_status:                     'Flat / Status', — DISABLED (T-2026-081)
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
  // hostel_status:                   'Hostel / Status', — DISABLED (T-2026-081)
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
  // land_status:                     'Land / Status', — DISABLED (T-2026-081)
  land_area_unit:                  'Land / Area Unit',
  land_lease_monthly_budget:       'Land / Lease Budget (Monthly)',
  land_lease_yearly_budget:        'Land / Lease Budget (Yearly)',
  land_deposit_budget:             'Land / Deposit Budget',
  // Paying Guest / X
  paying_guest_size:               'Paying Guest / Size',
  paying_guest_floor:              'Paying Guest / Floor',
  paying_guest_facing:             'Paying Guest / Facing',
  paying_guest_condition:          'Paying Guest / Condition',
  // paying_guest_status:             'Paying Guest / Status', — DISABLED (T-2026-081)
  paying_guest_defect_built:       'Paying Guest / Defect (Built)',
  // Plot / X — re-namespaces several legacy keys.
  plot_type:                       'Plot / Plot Type',
  plot_sub_residential:            'Plot / Sub-Type (Residential)',
  plot_sub_commercial:             'Plot / Sub-Type (Commercial)',
  plot_sub_industrial:             'Plot / Sub-Type (Industrial)',
  plot_facing:                     'Plot / Facing',
  plot_corner:                     'Plot / Corner',
  plot_layout_status:              'Plot / Layout Status',
  // plot_status:                     'Plot / Status', — DISABLED (T-2026-081)
  plot_area_unit:                  'Plot / Area Unit',
  plot_rate_unit:                  'Plot / Rate Unit',
  plot_amenities:                  'Plot / Amenities',
  plot_emi_count:                  'Plot / No. of EMIs',
  plot_emi_booking_percent:        'Plot / EMI Booking Amount %',
  plot_lease_monthly_budget:       'Plot / Lease Budget (Monthly)',
  plot_lease_yearly_budget:        'Plot / Lease Budget (Yearly)',
  plot_deposit_budget:             'Plot / Deposit Budget',
  plot_category_residential:       'Plot / Category (Residential)',
  plot_shape:                      'Global / Plot / Land / Shape',
  // SEZ / X
  sez_infrastructural_facilities:  'SEZ / Infrastructural Facilities',
  sez_fiscal_incentives:           'SEZ / Fiscal Incentives',
  // Shop / X
  shop_facing_specific:            'Shop / Facing (Specific)',
  shop_facing_any:                 'Shop / Facing (Any)',
  shop_age_specific:               'Shop / Age (Specific)',
  shop_condition:                  'Shop / Condition',
  // shop_status:                     'Shop / Status', — DISABLED (T-2026-081)
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
  // tdr_status:                      'TDR / Status', — DISABLED (T-2026-081)
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
  // project_sale_status:             'Project / Sale Status', — DISABLED (T-2026-081)
  // Paper Notice — six separate masters per source doc naming convention
  // (all six area-unit masters carry the same vocabulary but stay separate
  // so admins can rename any one independently).
  paper_notice_paper_name:     'Paper Notice / Paper Name',
  paper_notice_area:           'Paper Notice / Area',
  paper_notice_pot_kharba:     'Paper Notice / Pot Kharaba',
  paper_notice_total_area:     'Paper Notice / Total Area',
  paper_notice_owners_area:    "Paper Notice / Owner's Area",
  paper_notice_saleable_area:  'Paper Notice / Saleable Area',
  // Business Associates — used by the Designation dropdown on
  // Admin → Business Associates.
  business_associate_designation: 'Global / Business Associate Designation',
  // Phone Book — used by the Designation dropdown on Admin → Phone Book.
  // Label per product spec is intentionally "Phone book designatio".
  phone_book_designation: 'Phone book designatio',
  // Property Variety — Global; drives dashboard analytics + variety filters.
  property_variety: 'Global / Property Variety',
  // Project Name — Global; single source of truth for the Project Name /
  // Name of Project dropdowns across Flat / Project / Pre-Leased / Bank Auction.
  project_name: 'Global / Project Name',
  // Location — Global; single source of truth for the "Location" dropdown
  // (formerly "Location with Landmark Required") on the Enquiry forms.
  location: 'Global / Location',
  // Website-scoped masters — power the public Seller Registration + Add-
  // Property flow. Independent from the Global equivalents above.
  website_property_type:     'Website / Property Type',
  website_transaction_type:  'Website / Transaction Type',
  website_property_variety:  'Website / Property Variety',
  // Hotel / X — hierarchical labels so they group in the Admin sidebar. All
  // seeded by migration 085. `hotel_type` is the only expandable master;
  // every other Hotel master is a fixed Available / Not Available pair.
  hotel_type:                          'Hotel / Hotel Type',
  hotel_generator_power_backup:        'Hotel / Generator or Power Backup',
  hotel_inverter_ups_support:          'Hotel / Inverter or UPS Support',
  hotel_water_tanks:                   'Hotel / Water Tanks',
  hotel_water_pumps:                   'Hotel / Water Pumps',
  hotel_lift_facility:                 'Hotel / Lift Facility',
  hotel_parking_facility:              'Hotel / Parking Facility',
  hotel_billing_computer:              'Hotel / Billing Computer or Tablet',
  hotel_pos_software:                  'Hotel / POS Software',
  hotel_online_ordering_system:        'Hotel / Online Ordering System',
  hotel_receipt_printer:               'Hotel / Receipt Printer',
  hotel_qr_menu:                       'Hotel / QR Menu',
  hotel_barcode_scanner:               'Hotel / Barcode Scanner',
  hotel_card_payment_machine:          'Hotel / Card Payment Machine',
  hotel_inventory_mgmt_software:       'Hotel / Inventory Management Software',
  hotel_cctv_monitoring:               'Hotel / CCTV Monitoring System',
  hotel_fssai_license:                 'Hotel / FSSAI License',
  hotel_gst_registration:              'Hotel / GST Registration',
  hotel_shop_establishment_reg:        'Hotel / Shop & Establishment Registration',
  hotel_trade_license:                 'Hotel / Trade License (Local Authority)',
  hotel_fire_noc:                      'Hotel / Fire NOC',
  hotel_pollution_approvals:           'Hotel / Pollution Related Approvals',
  hotel_music_playing_license:         'Hotel / Music Playing License',
  hotel_commercial_use_permission:     'Hotel / Commercial Use Permission',
  hotel_adequate_water_supply:         'Hotel / Adequate Water Supply',
  hotel_3phase_electricity:            'Hotel / 3-Phase Electricity Connection',
  hotel_kitchen_exhaust_route:         'Hotel / Kitchen Exhaust Route',
  hotel_high_footfall_location:        'Hotel / High Footfall Location',
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

// T-2026-114: masters whose "duplicate name" rule is scoped by parent (not
// global). Village ('shivar') is the canonical case: the same village name
// may legitimately exist under two different Talukas (e.g. "Wadali" appears
// under both Akola/Balapur and Nashik/Nashik-City in the Maharashtra land-
// record vocabulary). Extending duplicate detection to (parent_code, LOWER
// (label)) instead of global LOWER(label) makes the check match reality.
//
// District and Taluka masters are deliberately NOT in this set — the client
// explicitly asked us not to change their behaviour, and their label-under-
// parent semantics are less clearly ambiguous. `code` remains globally
// unique inside master_lookups via the existing UNIQUE(master_key, code)
// index; ONLY the label-duplicate rule changes here.
const PARENT_SCOPED_LABEL_KEYS = new Set(['shivar']);
function isParentScopedLabel(masterKey) {
  return PARENT_SCOPED_LABEL_KEYS.has(masterKey);
}

// T-2026-114: resolve a parent's display label so the "already exists"
// error can name the containing scope (e.g. "under taluka 'Nashik City'").
// Purely cosmetic — the check itself works on codes. Returns the code
// verbatim when the parent row is missing, so the message still reads.
async function resolveParentLabel(masterKey, parentCode) {
  if (!parentCode) return '';
  // The immediate parent for shivar is taluka; parent for taluka is district.
  // Look it up in master_lookups by (parent_master_key, code).
  const parentKey = masterKey === 'shivar' ? 'taluka' : (masterKey === 'taluka' ? 'district' : null);
  if (!parentKey) return String(parentCode);
  try {
    const [rows] = await pool.query(
      `SELECT label FROM master_lookups
        WHERE master_key = ? AND code = ? AND deleted_at IS NULL
        LIMIT 1`,
      [parentKey, String(parentCode)],
    );
    return (rows[0] && rows[0].label) ? String(rows[0].label) : String(parentCode);
  } catch (_err) {
    return String(parentCode);
  }
}

// Fixed-vocabulary masters: the admin can toggle active/inactive on existing
// rows but cannot add, rename or delete them. Currently empty — property
// status was removed in migration 056 so admins can extend the vocabulary
// (e.g. add "Reserved") from the master admin without a code change. Keep
// the constant + guard in place because future masters may need to be
// locked down again.
const FIXED_MASTERS = new Set();
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
    { table: 'inventory_properties', column: 'property_type', friendlyLabel: 'Inventory Properties' },
    { table: 'website_properties',   column: 'property_type', friendlyLabel: 'Website Properties' },
  ],
  transaction_type: [
    { table: 'inventory_properties', column: 'transaction_type', friendlyLabel: 'Inventory Properties' },
    { table: 'website_properties',   column: 'transaction_type', friendlyLabel: 'Website Properties' },
  ],
  flat_type: [
    { table: 'inventory_properties', column: 'bhk', friendlyLabel: 'Inventory Properties' },
    { table: 'website_properties',   column: 'bhk', friendlyLabel: 'Website Properties' },
  ],
  // T-2026-080: Property Status split into two independent masters.
  //   * status_type    → only Inventory Properties (Enquiry moved to
  //                       enquiry_status master).
  //   * enquiry_status → only Enquiry Properties.
  // Website has NO domain-status column (only approval_status) so it is
  // intentionally omitted here.
  status_type: [
    { table: 'inventory_properties', column: 'status', friendlyLabel: 'Inventory Properties' },
  ],
  enquiry_status: [
    { table: 'enquiry_properties',   column: 'status', friendlyLabel: 'Enquiry Properties' },
  ],
  // Promoted-to-column lookups: tracked because they have a fast index.
  district: [{ table: 'inventory_properties', column: 'district', friendlyLabel: 'Inventory Properties' }],
  taluka:   [{ table: 'inventory_properties', column: 'taluka', friendlyLabel: 'Inventory Properties' }],
  shivar:   [{ table: 'inventory_properties', column: 'shivar', friendlyLabel: 'Inventory Properties' }],
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
  // T-2026-045: description is currently only surfaced by master_status_types
  // rows. When present in the row shape, expose it on the DTO so the admin
  // MasterListPage + MasterEntryModal can render + edit the field.
  if (Object.prototype.hasOwnProperty.call(row, 'description')) {
    dto.description = row.description || '';
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
  // T-2026-045: `sort` is a public whitelist key (name|createdAt|status) with
  // optional ':asc'|':desc' suffix; repo.buildOrderBy safely maps to columns.
  const { rows, total } = await repo.list(table, {
    ...filters, page, pageSize, discriminator, sort: filters.sort,
  });
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

// Master vocabularies whose rows are AMOUNTS / PERCENTAGES rather than
// human category names. These are the dropdowns the admin populates on the
// registration forms with values like "₹ 50,000", "1000 to 15000", "10 Lakh",
// or "12.5%". The "at least one letter" rule that guards category masters
// (Facing / Condition / Amenities) makes no sense here — admins legitimately
// need to save "1000", "₹1000", or "1000-15000" verbatim. See the frontend
// mirror in src/shared/constants/numericMasterKeys.js — keep both in sync.
const AMOUNT_MASTER_KEYS = new Set([
  // Bunglow
  'bunglow_lease_monthly_budget',
  'bunglow_lease_yearly_budget',
  'bunglow_deposit_budget',
  'bunglow_rent_monthly_budget',
  'bunglow_rent_deposit_budget',
  'bunglow_booking_amount_fixed',
  // Rowhouse (new property type — mirrors Bungalow bucket set)
  'rowhouse_lease_monthly_budget',
  'rowhouse_lease_yearly_budget',
  'rowhouse_deposit_budget',
  'rowhouse_rent_monthly_budget',
  'rowhouse_rent_deposit_budget',
  'rowhouse_booking_amount_fixed',
  // Commercial Space
  'commercial_lease_monthly_budget',
  'commercial_lease_yearly_budget',
  'commercial_deposit_budget',
  'commercial_rent_budget',
  'commercial_booking_amount_fixed',
  // Flat
  'flat_lease_monthly_budget',
  'flat_lease_yearly_budget',
  'flat_deposit_budget',
  'flat_booking_amount_fixed',
  // Hostel / Paying Guest
  'hostel_amount_budget',
  // Land
  'land_lease_monthly_budget',
  'land_lease_yearly_budget',
  'land_deposit_budget',
  // Plot
  'plot_lease_monthly_budget',
  'plot_lease_yearly_budget',
  'plot_deposit_budget',
  // Shop
  'shop_lease_monthly_budget',
  'shop_lease_yearly_budget',
  'shop_deposit_budget',
  'shop_booking_amount_fixed',
  // Global sale-forms
  'token_amount',
  // Percent vocabularies — "10%", "12.5%", "5 to 10%".
  'booking_amount_percent',
  'payment_white_percent',
  'yearly_hike_percent',
  'plot_emi_booking_percent',
  // GST percentages — seeded 5% / 1% / 0%, admins extend inline.
  'gst',
]);

function isAmountMasterKey(masterKey) {
  return AMOUNT_MASTER_KEYS.has(masterKey);
}

// Label rules vary per master. The strict masters accept letters + spaces
// only and cap at 30 chars (these are human category names — short and
// alphabetic, no numbers or punctuation). The lenient default still
// requires at least one letter but allows digits + a handful of punctuation
// because rows like "2 BHK" or "Showroom / Office" need them. The `amount`
// rule (used only for AMOUNT_MASTER_KEYS) inverts the letter requirement:
// it demands at least one DIGIT and permits currency + range punctuation
// (₹, en/em dash, tilde, comma, decimal, %).
const LABEL_RULES = {
  property_type:    { maxLen: 30, pattern: 'alpha' },          // letters + spaces only
  transaction_type: { maxLen: 30, pattern: 'alpha' },          // letters + spaces only
  flat_type:        { maxLen: 30, pattern: 'alphanumeric' },   // letters + digits + spaces only
  status_type:      { maxLen: 64, pattern: 'lenient' },        // now editable — see migration 056
};
// Lookup-table keys all share the same lenient label rule — values like
// "5%" / "20-25 Years" / "Rs. 1,00,000" / "Generator / Battery Backup" all
// need digits + punctuation. Default applies if no per-key override is set.
const LOOKUP_LABEL_RULE = { maxLen: 100, pattern: 'lookup' };
// Amount vocabularies allow the widened charset (₹, en-dash, em-dash, tilde)
// so admins can type "1000 – 15000", "₹1000", "1000~15000", "₹2.5 Crore".
const AMOUNT_LABEL_RULE = { maxLen: 100, pattern: 'amount' };
const PATTERNS = {
  alpha:        /^[A-Za-z ]+$/,
  alphanumeric: /^[A-Za-z0-9 ]+$/,
  lenient:      /^[A-Za-z0-9 /()&,.\-]+$/,
  // Lookup labels see digit/percent/colon/Rs.-style values from registration
  // forms. Expanded set still excludes shell-meta and HTML-meta characters.
  lookup:       /^[A-Za-z0-9 /()&,.:%+\-]+$/,
  // Amount labels additionally accept the rupee sign and range separators
  // (en-dash U+2013, em-dash U+2014, tilde). Still no shell/HTML meta chars.
  amount:       /^[A-Za-z0-9 ₹/()&,.:%+\-–—~]+$/,
};
const PATTERN_MESSAGES = {
  alpha:        'may only contain letters and spaces — digits and special characters are not allowed',
  alphanumeric: 'may only contain letters, digits, and spaces — special characters are not allowed',
  lenient:      'contains an unsupported character. Allowed: letters, digits, spaces, and / ( ) & , . -',
  lookup:       'contains an unsupported character. Allowed: letters, digits, spaces, and / ( ) & , . : % + -',
  amount:       'contains an unsupported character. Allowed: letters, digits, spaces, ₹, and / ( ) & , . : % + - – — ~',
};

function assertValidLabel(masterKey, label) {
  const v = String(label || '').trim();
  if (!v) throw new HttpError(400, 'VALIDATION_ERROR', `${MASTER_LABELS[masterKey]} name is required`);

  const isAmount = isAmountMasterKey(masterKey);
  const rule = isAmount
    ? AMOUNT_LABEL_RULE
    : (LABEL_RULES[masterKey] || (isLookupKey(masterKey) ? LOOKUP_LABEL_RULE : { maxLen: 255, pattern: 'lenient' }));
  if (v.length > rule.maxLen) {
    throw new HttpError(400, 'VALIDATION_ERROR', `${MASTER_LABELS[masterKey]} name must be at most ${rule.maxLen} characters`);
  }
  if (isAmount) {
    // Amount masters: must have at least one DIGIT (rejects "ABC" / "Hello"
    // / "###"). Letters are still allowed within the value (Lakh, Crore,
    // Rs, INR) but not sufficient on their own.
    if (!/\d/.test(v)) {
      throw new HttpError(400, 'VALIDATION_ERROR', `${MASTER_LABELS[masterKey]} must contain at least one number`);
    }
  } else if (!/[A-Za-z]/.test(v)) {
    throw new HttpError(400, 'VALIDATION_ERROR', `${MASTER_LABELS[masterKey]} name must contain at least one letter`);
  }
  const regex = PATTERNS[rule.pattern] || PATTERNS.lenient;
  if (!regex.test(v)) {
    throw new HttpError(400, 'VALIDATION_ERROR', `${MASTER_LABELS[masterKey]} name ${PATTERN_MESSAGES[rule.pattern]}`);
  }
  return v;
}

// T-2026-045: description is optional and only persisted for masters whose
// backing table has a description column (currently just status_type). All
// other keys silently drop the field.
function normalizeDescriptionForKey(masterKey, description) {
  if (description === undefined || description === null) return null;
  const t = MASTER_TABLES[masterKey];
  if (!repo.hasDescription(t)) return null;
  const s = String(description).trim();
  return s ? s.slice(0, 255) : null;
}

// T-2026-045: uniform audit helper. `req` is optional (backwards-compat for
// internal callers that don't need audit). Silently swallow logging errors
// so an audit outage never fails a successful mutation.
async function safeAudit(req, entry) {
  if (!req) return;
  try { await audit.record(req, entry); }
  catch (err) {
    // eslint-disable-next-line no-console
    console.error('[masters:audit] failed to record entry', entry.action, err && err.message);
  }
}

async function create(masterKey, payload, req) {
  assertNotFixed(masterKey, 'creating new entries');
  const table = tableFor(masterKey);
  const discriminator = discriminatorFor(masterKey);
  const label = assertValidLabel(masterKey, payload.label);
  const code = String(payload.code || '').trim().toLowerCase();
  const parentCode = isLookupKey(masterKey)
    ? (payload.parentCode ? String(payload.parentCode).trim().toLowerCase() : null)
    : null;
  const description = normalizeDescriptionForKey(masterKey, payload.description);

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
  // T-2026-114: for parent-scoped masters (currently just `shivar` /
  // Village), the label-duplicate check runs under the same parent scope,
  // so "Wadali" in Akola/Balapur does NOT collide with "Wadali" in Nashik/
  // Nashik-City. For every other master key the discriminator is unchanged
  // and the check remains global-per-vocabulary as before.
  const labelDiscriminator = (isParentScopedLabel(masterKey) && parentCode)
    ? { ...discriminator, parentCode }
    : discriminator;
  const existingByLabel = await repo.findByLabel(table, label, null, { discriminator: labelDiscriminator });
  if (existingByLabel) {
    const status = existingByLabel.is_active ? 'currently active' : 'currently inactive — you can reactivate it';
    // T-2026-114: name the containing scope in the error so the admin
    // knows why the check fired (e.g. "under taluka 'Nashik City'").
    const scopeSuffix = isParentScopedLabel(masterKey) && parentCode
      ? ` under taluka "${await resolveParentLabel(masterKey, parentCode)}"`
      : '';
    throw new HttpError(
      409,
      'LABEL_TAKEN',
      `A ${MASTER_LABELS[masterKey].toLowerCase()} named "${existingByLabel.label}"${scopeSuffix} already exists (#${existingByLabel.id}, ${status}). Search the list for "${existingByLabel.label}" to find it.`,
      { existingId: existingByLabel.id, existingLabel: existingByLabel.label, isActive: Boolean(existingByLabel.is_active), parentCode: parentCode || null },
    );
  }
  // Revive a soft-deleted twin if the admin is re-adding a previously-
  // deleted entry with the same code or label. The DB unique key on
  // (master_key, code) still covers deleted rows, so a fresh INSERT
  // hits ER_DUP_ENTRY. Reviving preserves the id + audit history and
  // gives the admin the "add worked" outcome they expected.
  //
  // T-2026-114: for parent-scoped masters, deleted-label revive also
  // scopes by parent — so a deleted "Wadali" under Akola/Balapur will
  // NOT be revived when the admin adds "Wadali" under Nashik/Nashik-City;
  // a fresh row is inserted instead. Deleted-code revive stays global
  // because code is globally unique via UNIQUE(master_key, code).
  const deletedByCode = await repo.findDeletedByCode(table, code, { discriminator });
  const deletedByLabel = deletedByCode
    ? null
    : await repo.findDeletedByLabel(table, label, { discriminator: labelDiscriminator });
  const dead = deletedByCode || deletedByLabel;
  if (dead) {
    await repo.revive(table, dead.id, {
      code,
      label,
      sortOrder: Number(payload.sortOrder) || 0,
      isActive: payload.isActive !== false,
      parentCode,
      description,
    });
    const revived = await getOne(masterKey, dead.id);
    // T-2026-045: reviving a soft-deleted row is user-facing 'create'.
    await safeAudit(req, {
      action: 'MASTER_CREATED',
      entityType: `master:${masterKey}`,
      entityId: revived.id,
      summary: `Created ${MASTER_LABELS[masterKey]}: "${revived.label}"`,
      metadata: { after: revived, revivedFromSoftDelete: true },
    });
    return revived;
  }
  const id = await repo.create(table, {
    code,
    label,
    sortOrder: Number(payload.sortOrder) || 0,
    isActive: payload.isActive !== false,
    masterKey: isLookupKey(masterKey) ? masterKey : undefined,
    parentCode,
    description,
  });
  const created = await getOne(masterKey, id);
  await safeAudit(req, {
    action: 'MASTER_CREATED',
    entityType: `master:${masterKey}`,
    entityId: created.id,
    summary: `Created ${MASTER_LABELS[masterKey]}: "${created.label}"`,
    metadata: { after: created },
  });
  return created;
}

async function update(masterKey, id, payload, req) {
  const table = tableFor(masterKey);
  const discriminator = discriminatorFor(masterKey);
  const existing = await repo.findById(table, id, { discriminator });
  if (!existing) throw new HttpError(404, 'NOT_FOUND', `${MASTER_LABELS[masterKey]} not found`);
  // For fixed masters the admin may still flip is_active but cannot change
  // code or label. Strip those out of the payload before validation/persist.
  if (FIXED_MASTERS.has(masterKey)) {
    payload = { isActive: payload.isActive, sortOrder: payload.sortOrder };
  }
  // Snapshot pre-mutation DTO for the audit metadata + activate/deactivate
  // detection. Uses toDto so shape matches what the API returns for `after`.
  const beforeDto = toDto(existing);
  // Label is only validated if it's actually being changed.
  const label = payload.label !== undefined
    ? assertValidLabel(masterKey, payload.label)
    : existing.label;
  const code = String(payload.code ?? existing.code).trim().toLowerCase();
  if (code !== existing.code && await repo.codeTaken(table, code, id, { discriminator })) {
    throw new HttpError(409, 'CODE_TAKEN', `A ${MASTER_LABELS[masterKey].toLowerCase()} with code "${code}" already exists`);
  }
  // T-2026-114: resolve parentCode BEFORE the label-uniqueness check so that
  // (a) parent-scoped label duplicate detection can use the incoming or
  //     preserved parentCode as the scope, and
  // (b) an update that moves a village from taluka A to taluka B is properly
  //     checked against taluka B's existing villages (not taluka A's).
  const parentCode = isLookupKey(masterKey)
    ? (payload.parentCode !== undefined
        ? (payload.parentCode ? String(payload.parentCode).trim().toLowerCase() : null)
        : (existing.parent_code || null))
    : null;
  const labelDiscriminator = (isParentScopedLabel(masterKey) && parentCode)
    ? { ...discriminator, parentCode }
    : discriminator;
  // T-2026-114: for parent-scoped masters, the label check MUST rerun even
  // when the label itself is unchanged if the parentCode is changing (moving
  // "Wadali" from Balapur taluka to Nashik-City taluka can collide with an
  // existing "Wadali" in Nashik-City). Detect either case.
  const labelChanged = label.toLowerCase() !== String(existing.label).toLowerCase();
  const parentChanged = isParentScopedLabel(masterKey)
    && String(parentCode || '') !== String(existing.parent_code || '');
  if ((labelChanged || parentChanged)
      && await repo.labelTaken(table, label, id, { discriminator: labelDiscriminator })) {
    const scopeSuffix = isParentScopedLabel(masterKey) && parentCode
      ? ` under taluka "${await resolveParentLabel(masterKey, parentCode)}"`
      : '';
    throw new HttpError(
      409,
      'LABEL_TAKEN',
      `A ${MASTER_LABELS[masterKey].toLowerCase()} named "${label}"${scopeSuffix} already exists`,
      { parentCode: parentCode || null },
    );
  }
  // T-2026-045: description only applied when the table has the column and
  // the caller included the field. When key is absent, preserve existing.
  const description = payload.description !== undefined
    ? normalizeDescriptionForKey(masterKey, payload.description)
    : (existing.description || null);
  await repo.update(table, id, {
    code,
    label,
    sortOrder: payload.sortOrder !== undefined ? Number(payload.sortOrder) : existing.sort_order,
    isActive: payload.isActive !== undefined ? Boolean(payload.isActive) : Boolean(existing.is_active),
    parentCode,
    description,
  }, { discriminator });
  const after = await getOne(masterKey, id);
  // T-2026-045: emit MASTER_UPDATED whenever anything else changed;
  // additionally emit ACTIVATED/DEACTIVATED when is_active flipped so the
  // audit log surfaces the toggle explicitly (matches spec item #9).
  const activeFlipped = beforeDto.isActive !== after.isActive;
  const otherFieldsChanged = (
    beforeDto.code !== after.code ||
    beforeDto.label !== after.label ||
    (beforeDto.description || '') !== (after.description || '') ||
    Number(beforeDto.sortOrder) !== Number(after.sortOrder) ||
    (beforeDto.parentCode || null) !== (after.parentCode || null)
  );
  if (otherFieldsChanged) {
    await safeAudit(req, {
      action: 'MASTER_UPDATED',
      entityType: `master:${masterKey}`,
      entityId: after.id,
      summary: (beforeDto.label !== after.label)
        ? `Updated ${MASTER_LABELS[masterKey]}: "${beforeDto.label}" -> "${after.label}"`
        : `Updated ${MASTER_LABELS[masterKey]}: "${after.label}"`,
      metadata: { before: beforeDto, after },
    });
  }
  if (activeFlipped) {
    await safeAudit(req, {
      action: after.isActive ? 'MASTER_ACTIVATED' : 'MASTER_DEACTIVATED',
      entityType: `master:${masterKey}`,
      entityId: after.id,
      summary: after.isActive
        ? `Activated ${MASTER_LABELS[masterKey]}: "${after.label}"`
        : `Deactivated ${MASTER_LABELS[masterKey]}: "${after.label}"`,
      metadata: { before: beforeDto, after },
    });
  }
  return after;
}

async function remove(masterKey, id, req) {
  assertNotFixed(masterKey, 'deleting entries');
  const table = tableFor(masterKey);
  const discriminator = discriminatorFor(masterKey);
  const existing = await repo.findById(table, id, { discriminator });
  if (!existing) throw new HttpError(404, 'NOT_FOUND', `${MASTER_LABELS[masterKey]} not found`);
  const beforeDto = toDto(existing);

  // Best-effort safety: if any non-deleted property row still references this
  // code, refuse the delete and ask the admin to reassign. Deactivating
  // (is_active = 0) is offered as an alternative since it doesn't break old
  // rows but hides the option from new-property dropdowns.
  //
  // T-2026-045: build a per-table breakdown so the frontend delete-blocked
  // modal can render one row per referring table (e.g. "Inventory
  // Properties : 12 / Enquiry Properties : 4"). The breakdown lives in the
  // HttpError details.usage array so the frontend can render it without
  // parsing the message string.
  const refs = USAGE_REFS[masterKey] || [];
  const usage = [];
  let inUse = 0;
  for (const ref of refs) {
    const [[{ n }]] = await pool.query(
      `SELECT COUNT(*) AS n FROM ${ref.table} WHERE ${ref.column} = ? AND deleted_at IS NULL`,
      [existing.code],
    );
    const count = Number(n);
    if (count > 0) {
      usage.push({
        table: ref.table,
        column: ref.column,
        label: ref.friendlyLabel || ref.table,
        count,
      });
    }
    inUse += count;
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
        { usage: [{ table: 'master_lookups', column: 'parent_code', label: 'Child master rows', count: Number(n) }] },
      );
    }
  }
  if (inUse > 0) {
    // Compose a human-readable per-table breakdown alongside the total.
    // Frontend also reads err.details.usage[] to render the modal as a list.
    const breakdown = usage.map((u) => `${u.label} : ${u.count}`).join(', ');
    throw new HttpError(
      409,
      'IN_USE',
      `Cannot delete — this ${MASTER_LABELS[masterKey].toLowerCase()} is being used in: ${breakdown}. Deactivate it instead so it stops appearing in new-property dropdowns while existing records keep working.`,
      { usage, total: inUse },
    );
  }
  await repo.softDelete(table, id, { discriminator });
  await safeAudit(req, {
    action: 'MASTER_DELETED',
    entityType: `master:${masterKey}`,
    entityId: beforeDto.id,
    summary: `Deleted ${MASTER_LABELS[masterKey]}: "${beforeDto.label}"`,
    metadata: { before: beforeDto },
  });
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

// Canonicalise a code string for tolerant lookup. Handles the common FE
// spelling drift ('paying-guest' / 'Paying Guest' / 'PAYING_GUEST' → 'paying_guest')
// without swallowing genuinely different codes. Only used inside
// resolveActiveMasterRef's fallback path; the strict path (ID lookup, or
// exact-code lookup first) is tried before this so a match against the DB's
// literal code always wins.
function normaliseMasterCode(code) {
  if (code === undefined || code === null) return '';
  return String(code).trim().toLowerCase().replace(/[\s-]+/g, '_');
}

// Tolerant, ID-first resolver used by the centralised property-classification
// validator (services/masters/propertyMasters.js). Resolution order:
//   1. If `id` is a positive integer → look up by primary key.
//   2. Else if `code` is non-empty → look up by exact code (case-insensitive
//      via collation), and if that misses, retry with a normalised code.
// Returns the DTO of the active row (`{id, code, label, ...}`) or `null` when
// no input was supplied (partial updates / legacy pre-catalog records stay
// permissive). Throws HttpError 400 with a per-field message if a non-empty
// input was supplied but resolved to no active row.
async function resolveActiveMasterRef(masterKey, { id, code } = {}) {
  const hasId = id !== undefined && id !== null && id !== '' && Number.isInteger(Number(id)) && Number(id) > 0;
  const hasCode = code !== undefined && code !== null && code !== '';
  if (!hasId && !hasCode) return null;

  const table = tableFor(masterKey);
  const discriminator = discriminatorFor(masterKey);
  const label = MASTER_LABELS[masterKey].toLowerCase();

  if (hasId) {
    const byId = await repo.findById(table, Number(id), { discriminator });
    if (byId && byId.is_active) return toDto(byId);
    // The FE gave us an ID that is either unknown, soft-deleted or inactive.
    // If a code was also supplied, fall through and try to recover from it —
    // this keeps stale drafts (saved before the master row was rotated)
    // savable so long as the code still resolves.
    if (!hasCode) {
      throw new HttpError(
        400,
        'INVALID_MASTER_CODE',
        `Unknown or inactive ${label} id: ${id}`,
      );
    }
  }

  // Exact-code match first (matches whatever the DB literally stores).
  let byCode = await repo.findByCode(table, code, { discriminator });
  if (!byCode || !byCode.is_active) {
    // Fallback: normalise common FE spelling drift and retry. Only retried
    // when the normalised form actually differs from the input, so this
    // never doubles the DB round-trip for the common case.
    const normalised = normaliseMasterCode(code);
    if (normalised && normalised !== String(code)) {
      byCode = await repo.findByCode(table, normalised, { discriminator });
    }
  }
  if (byCode && byCode.is_active) return toDto(byCode);
  throw new HttpError(
    400,
    'INVALID_MASTER_CODE',
    `Unknown or inactive ${label}: "${code}"`,
  );
}

module.exports = {
  masterKeys,
  masterMeta,
  list,
  listAll,
  getOne,
  activeCodes,
  assertActiveCode,
  resolveActiveMasterRef,
  normaliseMasterCode,
  create,
  update,
  remove,
};
