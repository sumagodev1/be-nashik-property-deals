const { pool } = require('../pool');

async function listForSubAdmin(subAdminId) {
  const [rows] = await pool.query(
    `SELECT module_key FROM sub_admin_modules WHERE sub_admin_id = ?`,
    [subAdminId],
  );
  return rows.map((r) => r.module_key);
}

async function replaceForSubAdmin(subAdminId, moduleKeys) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM sub_admin_modules WHERE sub_admin_id = ?', [subAdminId]);
    if (moduleKeys.length > 0) {
      const values = moduleKeys.map(() => '(?, ?)').join(', ');
      const params = moduleKeys.flatMap((k) => [subAdminId, k]);
      await conn.query(
        `INSERT INTO sub_admin_modules (sub_admin_id, module_key) VALUES ${values}`,
        params,
      );
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { listForSubAdmin, replaceForSubAdmin };
