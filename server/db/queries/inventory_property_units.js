// ============================================================
// inventory_property_units — query layer (T-2026-137)
// ============================================================
// Query helpers for the child table introduced in migration 099.
// One row per unit inside a Builder Property MASTER (inventory_properties
// row with is_builder_master=1).
//
// PUBLIC-API BOUNDARY:
//   This module is imported ONLY by the admin-side services layer. It
//   MUST NOT be reached from any /api/public/* route. The public
//   controllers never JOIN or SELECT from inventory_property_units —
//   builder inventory is admin-only per T-2026-136 spec sections 12 /
//   26 / T13-T14.
//
// COLUMN CONTRACT:
//   id                  BIGINT UNSIGNED PK
//   master_property_id  BIGINT UNSIGNED FK -> inventory_properties.id
//                       (ON DELETE CASCADE — deleting the master atomically
//                        removes every unit under it in one DB round-trip)
//   unit_no             VARCHAR(64)   Unique per master (UK uk_master_unit)
//   status              ENUM(available, in_discussion, booked, sold, hold, hidden)
//                       DEFAULT 'available'
//   details             JSON NOT NULL Unit-level dynamicData subset
//   created_at / updated_at  DATETIME
//
// NOTHING ELSE — no is_draft column in this iteration (drafts are
// handled at the FE localStorage layer per slice T-2026-140 plan), no
// soft-delete column (hard delete is fine: CASCADE from master or admin
// explicit unit delete). If either is needed later, add as an additive
// nullable migration.
// ============================================================

const { pool } = require('../pool');

/**
 * Parse the `details` column back into an object.
 * MariaDB 10.4 stores JSON as LONGTEXT internally, and mysql2's driver
 * returns it as a string. Higher versions return an object; we handle
 * both defensively so the rest of the code layer sees a plain object.
 */
function parseDetails(row) {
  if (!row) return row;
  const out = { ...row };
  const raw = out.details;
  if (raw == null) {
    out.details = null;
  } else if (typeof raw === 'string') {
    try {
      out.details = JSON.parse(raw);
    } catch (_e) {
      out.details = null;
    }
  }
  return out;
}

/**
 * Fetch every unit for one master, ordered by unit_no ascending.
 * Callers that need a status-filtered slice can filter in JS after the
 * fetch (the unit count per master is expected to stay in the low
 * hundreds — no need for SQL-level pagination in this iteration).
 */
async function listByMaster(masterId) {
  const [rows] = await pool.query(
    `SELECT id, master_property_id, unit_no, status, details, created_at, updated_at
       FROM inventory_property_units
      WHERE master_property_id = ?
      ORDER BY unit_no ASC, id ASC`,
    [masterId],
  );
  return rows.map(parseDetails);
}

/**
 * Aggregated status counts for the dashboard header cards. Also returns
 * total so the FE header cards can render "Total X / Available Y / ..."
 * without a second round-trip.
 */
async function statusCountsByMaster(masterId) {
  const [rows] = await pool.query(
    `SELECT status, COUNT(*) AS n
       FROM inventory_property_units
      WHERE master_property_id = ?
      GROUP BY status`,
    [masterId],
  );
  const counts = {
    available: 0,
    in_discussion: 0,
    booked: 0,
    sold: 0,
    hold: 0,
    hidden: 0,
  };
  let total = 0;
  for (const r of rows) {
    const n = Number(r.n) || 0;
    if (Object.prototype.hasOwnProperty.call(counts, r.status)) {
      counts[r.status] = n;
    }
    total += n;
  }
  return { total, counts };
}

async function findById(masterId, unitId) {
  const [rows] = await pool.query(
    `SELECT id, master_property_id, unit_no, status, details, created_at, updated_at
       FROM inventory_property_units
      WHERE master_property_id = ? AND id = ?
      LIMIT 1`,
    [masterId, unitId],
  );
  return rows[0] ? parseDetails(rows[0]) : null;
}

/**
 * Create a new unit. `details` MUST be an object (never null / undefined) —
 * the DB column is NOT NULL. Callers pass at least `{}` when they have
 * nothing to store. Duplicate unit_no under the same master raises
 * mysql2 ER_DUP_ENTRY 1062 — the service layer translates that to a
 * 409 HttpError.
 */
async function create({ masterId, unitNo, status, details }) {
  const detailsJson = JSON.stringify(details && typeof details === 'object' ? details : {});
  const [result] = await pool.query(
    `INSERT INTO inventory_property_units
       (master_property_id, unit_no, status, details)
     VALUES (?, ?, ?, ?)`,
    [masterId, unitNo, status || 'available', detailsJson],
  );
  return findById(masterId, result.insertId);
}

/**
 * Update a unit's editable fields. Any of unitNo / status / details can
 * be null/undefined to leave that column untouched. Uses a dynamic
 * SET-list built from the provided keys so callers don't need a
 * separate function per single-field flip.
 */
async function update({ masterId, unitId, unitNo, status, details }) {
  const setParts = [];
  const params = [];
  if (unitNo != null) {
    setParts.push('unit_no = ?');
    params.push(unitNo);
  }
  if (status != null) {
    setParts.push('status = ?');
    params.push(status);
  }
  if (details !== undefined) {
    setParts.push('details = ?');
    params.push(JSON.stringify(details && typeof details === 'object' ? details : {}));
  }
  if (setParts.length === 0) {
    // Nothing to update — return the current row unchanged. Callers who
    // hit this branch (empty payload) get a no-op with the fresh row.
    return findById(masterId, unitId);
  }
  params.push(masterId, unitId);
  await pool.query(
    `UPDATE inventory_property_units
        SET ${setParts.join(', ')}
      WHERE master_property_id = ? AND id = ?`,
    params,
  );
  return findById(masterId, unitId);
}

/**
 * Single-field status flip (dashboard fast-path). Returns the fresh row
 * so the caller can broadcast the updated status back to the FE.
 */
async function updateStatus({ masterId, unitId, status }) {
  await pool.query(
    `UPDATE inventory_property_units
        SET status = ?
      WHERE master_property_id = ? AND id = ?`,
    [status, masterId, unitId],
  );
  return findById(masterId, unitId);
}

/**
 * Hard-delete a single unit. Returns the number of rows affected so the
 * service layer can decide 204 vs 404.
 */
async function remove({ masterId, unitId }) {
  const [result] = await pool.query(
    `DELETE FROM inventory_property_units
      WHERE master_property_id = ? AND id = ?`,
    [masterId, unitId],
  );
  return result.affectedRows;
}

module.exports = {
  listByMaster,
  statusCountsByMaster,
  findById,
  create,
  update,
  updateStatus,
  remove,
};
