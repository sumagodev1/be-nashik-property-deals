// Centralised validator for the three property-classification masters that
// every registration form shares: Property Type, Transaction Type, and
// Property Variety. Every service that persists a property (Inventory,
// Enquiry, Website/Seller) MUST route through this module — never call
// masters.assertActiveCode('transaction_type', payload.transactionVariant)
// or any other field→master pairing directly. Historically that miswiring
// caused INVALID_MASTER_CODE errors like "Unknown or inactive global /
// transaction type: 'new'" because `transactionVariant` carries a Property
// Variety code (e.g. 'new', 'resale', migration 054) but was being looked
// up in the Transaction Type table.
//
// Resolution strategy (per T-2026 master-lookup hardening):
//   1. If the FE sent an `*Id` we resolve by primary key (dynamic — a
//      newly-added master row works with no code change here).
//   2. Otherwise we look the code up literally, then retry after a light
//      normalisation ('paying-guest' / 'PAYING_GUEST' / 'Paying Guest' →
//      'paying_guest') so common FE spelling drift never fails a save
//      that the DB actually has the row for.
//   3. On success the payload is rewritten in place with the master row's
//      canonical id + code + label so every downstream layer (DB write,
//      dashboard, exports, response DTO) sees a single agreed value —
//      even when the caller only sent an ID or only sent a code.
//
// Fixed field → master pairing (do NOT reorder or reassign):
//   payload.propertyType       → 'property_type'    (Global / Property Type)
//   payload.transactionType    → 'transaction_type' (Global / Transaction Type)
//   payload.transactionVariant → 'property_variety' (Global / Property Variety)
//
// The DB column and payload key are named `transaction_variant` /
// `transactionVariant` for historical reasons; semantically the value is
// always a Property Variety code (see migration 054 seed + comments in
// db/queries/inventory_properties.js and enquiry_properties.js which JOIN
// this column against master_lookups where master_key='property_variety').
//
// Empty / null / undefined values are permitted (each check is a no-op on
// empty input) so partial updates and pre-catalog legacy records keep
// saving.

const masters = require('./management');

// Contract map — kept as a literal (not derived) so a grep for any master
// key or payload field lands here immediately.
const PROPERTY_CLASSIFICATION_MASTERS = Object.freeze({
  propertyType:       'property_type',
  transactionType:    'transaction_type',
  transactionVariant: 'property_variety',
});

// Payload key → { masterKey, idKey, nameKey }. `nameKey` is the FE-friendly
// label field paired with the id (propertyTypeName / transactionTypeName /
// propertyVarietyName); the id/name pair was added in T-2026-055 to carry
// the pre-form chooser's captured master row verbatim.
const CLASSIFICATION_FIELDS = Object.freeze([
  { codeKey: 'propertyType',       idKey: 'propertyTypeId',     nameKey: 'propertyTypeName',     masterKey: 'property_type'    },
  { codeKey: 'transactionType',    idKey: 'transactionTypeId',  nameKey: 'transactionTypeName',  masterKey: 'transaction_type' },
  { codeKey: 'transactionVariant', idKey: 'propertyVarietyId',  nameKey: 'propertyVarietyName',  masterKey: 'property_variety' },
]);

async function validatePropertyClassification(payload) {
  if (!payload || typeof payload !== 'object') return;

  for (const field of CLASSIFICATION_FIELDS) {
    const id = payload[field.idKey];
    const code = payload[field.codeKey];

    const row = await masters.resolveActiveMasterRef(field.masterKey, { id, code });
    if (!row) continue; // no input for this field — permissive by design

    // Rewrite the payload with the master row's canonical values so the DB
    // write, downstream services, and the response all see a single agreed
    // (id, code, label) triple. We ONLY overwrite the id / name fields when
    // the caller either did not send them or sent an inconsistent value —
    // this keeps operator-supplied names intact in the common case while
    // ensuring nulls / stale IDs get healed.
    payload[field.codeKey] = row.code;
    if (id === undefined || id === null || id === '' || Number(id) !== row.id) {
      payload[field.idKey] = row.id;
    }
    if (!payload[field.nameKey]) {
      payload[field.nameKey] = row.label;
    }
  }
}

module.exports = {
  PROPERTY_CLASSIFICATION_MASTERS,
  CLASSIFICATION_FIELDS,
  validatePropertyClassification,
};
