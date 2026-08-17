// ============================================================
// services/inventory/units.js — Builder Property unit CRUD (T-2026-137)
// ============================================================
// Thin service layer over db/queries/inventory_property_units.js. The
// existing inventory `management.js` service is intentionally NOT
// extended — units are a distinct resource (child collection) with a
// simpler shape and no file / share / export path. Keeping them in
// their own module means:
//
//   * Zero risk of breaking any of the 15+ methods on management.js
//     (which is what the T1/T2 regression bar mandates).
//   * The FE units UI (T-2026-139) can lean on a small, focused API.
//   * A future generalisation to non-Flat property types (spec section
//     29) can extend THIS module in one place.
//
// PUBLIC-EXCLUSION CONTRACT:
//   Every callsite here confirms the parent master's is_builder_master
//   flag is 1 (via `assertMasterIsBuilder`) BEFORE any write operation.
//   Non-builder rows cannot accidentally accrue unit children — the DB
//   FK would technically permit it, but the service refuses. This keeps
//   the invariant "units only exist under builder masters" intact even
//   if a bad admin payload tries to POST /:aNonBuilderId/units/....
// ============================================================

const { HttpError } = require('../../middleware/errors');
const { pool } = require('../../db/pool');
const units = require('../../db/queries/inventory_property_units');

/**
 * Load the master row for the given id AND assert it exists, is not
 * soft-deleted, and is flagged as a Builder Property (is_builder_master=1).
 * Throws 404 / 409 as appropriate. Returns the master row on success.
 *
 * Kept as a direct pool query (rather than via the fatter
 * db/queries/inventory_properties.findById which composes a 26-branch
 * SELECT with masters JOINs) because we only need three columns.
 */
async function assertMasterIsBuilder(masterId) {
  const [rows] = await pool.query(
    `SELECT id, is_builder_master, deleted_at
       FROM inventory_properties
      WHERE id = ?
      LIMIT 1`,
    [masterId],
  );
  const master = rows[0];
  if (!master || master.deleted_at) {
    throw new HttpError(404, 'MASTER_NOT_FOUND', 'Builder master property not found.');
  }
  if (Number(master.is_builder_master) !== 1) {
    throw new HttpError(409, 'NOT_A_BUILDER_MASTER',
      'Cannot manage units under a non-Builder property.');
  }
  return master;
}

/**
 * List every unit under a master, plus aggregated status counts + total.
 * Called by the FE Unit Inventory dashboard header cards + table.
 *
 * Response shape:
 *   {
 *     master: { id, is_builder_master, ... passthrough summary ... },
 *     units:  [{ id, master_property_id, unit_no, status, details, created_at, updated_at }, ...],
 *     summary: {
 *       total: N,
 *       counts: { available, in_discussion, booked, sold, hold, hidden }
 *     }
 *   }
 */
async function list(masterId) {
  const master = await assertMasterIsBuilder(masterId);
  const [rows, summary] = await Promise.all([
    units.listByMaster(masterId),
    units.statusCountsByMaster(masterId),
  ]);
  return {
    master: {
      id: master.id,
      is_builder_master: Number(master.is_builder_master) === 1,
    },
    units: rows,
    summary,
  };
}

async function getOne(masterId, unitId) {
  await assertMasterIsBuilder(masterId);
  const row = await units.findById(masterId, unitId);
  if (!row) throw new HttpError(404, 'UNIT_NOT_FOUND', 'Unit not found.');
  return row;
}

/**
 * Create a new unit under a builder master. Duplicate unit_no under the
 * same master surfaces as a 409 with a specific `UNIT_NO_TAKEN` code so
 * the FE can show "Flat No. already used" inline.
 */
async function create(masterId, { unitNo, status, details }) {
  await assertMasterIsBuilder(masterId);
  try {
    return await units.create({
      masterId,
      unitNo,
      status: status || 'available',
      details: details || {},
    });
  } catch (err) {
    if (err && err.code === 'ER_DUP_ENTRY') {
      throw new HttpError(409, 'UNIT_NO_TAKEN',
        'A unit with this Unit No. already exists under this master.');
    }
    throw err;
  }
}

/**
 * Full update. Any absent field is left untouched. Duplicate-unit_no
 * across a rename surfaces the same 409 code as create().
 */
async function update(masterId, unitId, { unitNo, status, details }) {
  await assertMasterIsBuilder(masterId);
  const existing = await units.findById(masterId, unitId);
  if (!existing) throw new HttpError(404, 'UNIT_NOT_FOUND', 'Unit not found.');
  try {
    return await units.update({ masterId, unitId, unitNo, status, details });
  } catch (err) {
    if (err && err.code === 'ER_DUP_ENTRY') {
      throw new HttpError(409, 'UNIT_NO_TAKEN',
        'A unit with this Unit No. already exists under this master.');
    }
    throw err;
  }
}

/**
 * Single-field status flip. Kept separate from `update` because the FE
 * dashboard fast-path (status pill click) sends ONLY the status and it
 * would be wasteful (and error-prone) to require the FE to round-trip
 * the full unit shape for one field flip.
 */
async function changeStatus(masterId, unitId, status) {
  await assertMasterIsBuilder(masterId);
  const existing = await units.findById(masterId, unitId);
  if (!existing) throw new HttpError(404, 'UNIT_NOT_FOUND', 'Unit not found.');
  return units.updateStatus({ masterId, unitId, status });
}

async function remove(masterId, unitId) {
  await assertMasterIsBuilder(masterId);
  const affected = await units.remove({ masterId, unitId });
  if (affected === 0) {
    throw new HttpError(404, 'UNIT_NOT_FOUND', 'Unit not found.');
  }
  return { ok: true };
}

module.exports = {
  list,
  getOne,
  create,
  update,
  changeStatus,
  remove,
  // Exposed so callers outside this module can reuse the invariant check
  // (e.g. the master save path in T-2026-138 will assert BEFORE flipping
  // is_builder_master back to 0 that no children exist).
  assertMasterIsBuilder,
};
