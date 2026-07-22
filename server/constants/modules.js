// Sub Admin module keys. Admin always has all access (does not need to be listed).
// Add a new module: add its key here AND surface it in the frontend nav config.

const MODULES = Object.freeze({
  INVENTORY_MANAGEMENT: 'inventory_management',
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
});

const MODULE_KEYS = Object.values(MODULES);

function isValidModuleKey(key) {
  return MODULE_KEYS.includes(key);
}

module.exports = { MODULES, MODULE_KEYS, isValidModuleKey };
