/**
 * Resolve persisted location codes for report/list DTOs.
 *
 * Location codes remain on the DTO because the admin filters and the SQL
 * queries use them. The sibling name fields are resolved from the canonical
 * `master_lookups` data for the same source row, so callers can display the
 * human-readable value without replacing the query key or mixing source
 * records together.
 */

const locationsQuery = require('../db/queries/locations');

const LOCATION_MASTERS = Object.freeze([
  ['district', 'districtName'],
  ['taluka', 'talukaName'],
  ['shivar', 'shivarName'],
]);

function uniqueCodes(rows, field) {
  return Array.from(new Set(
    (rows || [])
      .map((row) => row && row[field])
      .filter((value) => value !== null && value !== undefined && String(value).trim() !== '')
      .map((value) => String(value)),
  ));
}

function labelMap(rows) {
  const byCode = {};
  const byId = {};
  for (const row of rows || []) {
    if (row?.code !== null && row?.code !== undefined) byCode[String(row.code)] = row.label;
    if (row?.id !== null && row?.id !== undefined) byId[String(row.id)] = row.label;
  }
  // If an id happens to have the same textual value as another row's code,
  // the stored government code is the more specific representation.
  return { ...byId, ...byCode };
}

/**
 * Add `districtName`, `talukaName`, and `shivarName` to list DTOs.
 *
 * The resolver is intentionally source-neutral: each service passes only its
 * own query result rows, so a label can never be borrowed from another report
 * source. A failed/missing master lookup yields null; the report layer then
 * renders its standard "Not specified" fallback instead of exposing a code.
 */
async function attachLocationNames(rows, toListItem) {
  const sourceRows = Array.isArray(rows) ? rows : [];
  const resolved = await Promise.all(
    LOCATION_MASTERS.map(([masterKey, field]) => (
      locationsQuery.labelsForCodes(masterKey, uniqueCodes(sourceRows, masterKey))
        .then(labelMap)
        .catch(() => ({}))
        .then((labels) => [field, labels])
    )),
  );
  const byField = Object.fromEntries(resolved);

  return sourceRows.map((row) => {
    const item = toListItem(row);
    return {
      ...item,
      districtName: byField.districtName[String(row.district)] || null,
      talukaName: byField.talukaName[String(row.taluka)] || null,
      shivarName: byField.shivarName[String(row.shivar)] || null,
    };
  });
}

module.exports = { attachLocationNames };
