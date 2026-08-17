// Sub Admin module keys. Admin always has all access (does not need to be listed).
// Add a new module: add its key here AND surface it in the frontend nav config.

const MODULES = Object.freeze({
  // T-2026-174: INVENTORY_MANAGEMENT is retained as a DEPRECATED umbrella
  // key that historically gated all five surfaces below. New grants must
  // use the five discrete keys (INVENTORY_DASHBOARD / INVENTORY_PROPERTIES
  // / ENQUIRY_DASHBOARD / ENQUIRY_PROPERTIES / AGREEMENT_REMINDERS). Kept
  // in the registry so:
  //   (a) pre-T-174 SQL rows in sub_admin_modules still resolve to a valid
  //       key and continue to grant access via migration 111's fan-out
  //       backfill on the five new keys.
  //   (b) pre-T-174 JWTs in flight (issued before this deploy) that carry
  //       'inventory_management' in their modules[] array still satisfy
  //       hasGrant() checks -- middleware/auth.js#hasGrant tolerates any
  //       valid key in the payload; the split routes below check the NEW
  //       keys, and the migration 111 backfill ensures the DB rows exist
  //       so the very next JWT re-issue picks up the new discrete grants.
  //   (c) legacy scripts / smoke tests / audit-log entries that reference
  //       the key by name still resolve.
  // The Sub Admin editor (FE src/shared/constants/modules.js) excludes
  // this key from SUB_ADMIN_GRANTABLE_MODULES via HIDDEN_FROM_SUB_ADMIN_EDITOR
  // so no NEW grants can be minted against it.
  INVENTORY_MANAGEMENT: 'inventory_management',
  // T-2026-174: the five discrete surfaces that used to share
  // INVENTORY_MANAGEMENT are now separately grantable. Route files below
  // migrate off INVENTORY_MANAGEMENT to their respective new key:
  //   - inventory-properties.js  -> INVENTORY_PROPERTIES
  //   - enquiry-properties.js    -> ENQUIRY_PROPERTIES
  //   - agreement-reminders.js   -> AGREEMENT_REMINDERS
  //   - dashboard.js (per-verb)  -> INVENTORY_DASHBOARD (/inventory/*)
  //                              -> ENQUIRY_DASHBOARD (/enquiry/*)
  // A pre-T-174 sub-admin holding INVENTORY_MANAGEMENT is fanned out into
  // all five new keys by migration 111 so their effective access does not
  // change on deploy.
  INVENTORY_DASHBOARD: 'inventory_dashboard',
  INVENTORY_PROPERTIES: 'inventory_properties',
  ENQUIRY_DASHBOARD: 'enquiry_dashboard',
  ENQUIRY_PROPERTIES: 'enquiry_properties',
  AGREEMENT_REMINDERS: 'agreement_reminders',
  WEBSITE_PROPERTY_MANAGEMENT: 'website_property_management',
  BUSINESS_ASSOCIATE_MANAGEMENT: 'business_associate_management',
  LEAD_MANAGEMENT: 'lead_management',
  USER_MANAGEMENT: 'user_management',
  CMS_MANAGEMENT: 'cms_management',
  MASTER_MANAGEMENT: 'master_management',
  // The key is retained (originally "Land Record Management") because it
  // gates existing sub_admin permission grants. The user-facing label was
  // relabelled to "Miscellaneous" in the frontend MODULE_LABELS map.
  LAND_RECORD_MANAGEMENT: 'land_record_management',
  DOCUMENT_DIRECTORY: 'document_directory',
  PHONE_BOOK_MANAGEMENT: 'phone_book_management',
  // T-2026-151: CRM module -- new admin surface that replaces the old
  // Leads menu. Combines Website + NPD enquiries under a Parent / Sub-
  // Enquiry data model with duplicate detection, immutable status
  // history, and Google Calendar follow-up (Strategy-C stub in Phase 1).
  // Backward compat: LEAD_MANAGEMENT above is retained so pre-existing
  // sub_admin permission grants continue to gate the legacy Leads route
  // until it is removed in Phase 2. The two keys are INDEPENDENT --
  // granting CRM does not auto-grant Leads and vice versa.
  CRM_MANAGEMENT: 'crm_management',
  // T-2026-173-B: previously admin-only surfaces promoted to sub-admin-
  // grantable modules per user requirement. Existing behaviour preserved:
  //   - Administrator role continues to bypass all module checks via
  //     requireModule's role==='admin' short-circuit (middleware/auth.js).
  //   - Existing sub-admins have NO grants for these keys after deploy
  //     (no auto-grant), so nothing is silently escalated.
  //   - A sub-admin explicitly granted SUB_ADMIN_MANAGEMENT can manage
  //     other sub-admins (read to list/view, write to create/edit/delete).
  //   - AUDIT_LOG is read-only in practice (audit-log.js has no mutating
  //     verbs), so the write gate is a no-op but is applied for future-
  //     proofing.
  //   - REPORTS and CONVERSION_TABLE have no dedicated BE routes -- they
  //     are FE-only surfaces that compose other endpoints. The keys exist
  //     purely for FE sidebar filter + route guard.
  SUB_ADMIN_MANAGEMENT: 'sub_admin_management',
  AUDIT_LOG: 'audit_log',
  REPORTS: 'reports',
  CONVERSION_TABLE: 'conversion_table',
});

const MODULE_KEYS = Object.values(MODULES);

function isValidModuleKey(key) {
  return MODULE_KEYS.includes(key);
}

module.exports = { MODULES, MODULE_KEYS, isValidModuleKey };
