const { pool } = require('../pool');

// ---------- settings (key/value) ----------

async function listSettings() {
  const [rows] = await pool.query('SELECT setting_key, setting_value FROM cms_settings ORDER BY setting_key ASC');
  const out = {};
  for (const r of rows) out[r.setting_key] = r.setting_value;
  return out;
}

/**
 * Bulk-upsert: write all key/value pairs in a single transaction.
 * Empty/null values are stored as NULL (caller can use that to "clear" a key).
 */
async function upsertSettings(entries) {
  if (entries.length === 0) return;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const { key, value } of entries) {
      await conn.query(
        `INSERT INTO cms_settings (setting_key, setting_value)
         VALUES (?, ?)
         ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
        [key, value === '' || value === undefined ? null : value],
      );
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

// ---------- banners ----------

async function listAllBanners() {
  const [rows] = await pool.query(
    `SELECT id, image_url, alt_text, caption, subcaption, sort_order, is_active, created_at, updated_at
     FROM cms_banners
     ORDER BY sort_order ASC, id ASC`,
  );
  return rows;
}

async function listActiveBanners() {
  const [rows] = await pool.query(
    `SELECT id, image_url, alt_text, caption, subcaption, sort_order
     FROM cms_banners
     WHERE is_active = 1
     ORDER BY sort_order ASC, id ASC`,
  );
  return rows;
}

async function findBannerById(id) {
  const [rows] = await pool.query(
    `SELECT id, image_url, alt_text, caption, subcaption, sort_order, is_active, created_at, updated_at
     FROM cms_banners
     WHERE id = ?
     LIMIT 1`,
    [id],
  );
  return rows[0] || null;
}

async function createBanner({ imageUrl, altText, caption, subcaption, sortOrder, isActive }) {
  const [result] = await pool.query(
    `INSERT INTO cms_banners (image_url, alt_text, caption, subcaption, sort_order, is_active)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [imageUrl, altText || null, caption || null, subcaption || null, sortOrder, isActive ? 1 : 0],
  );
  return result.insertId;
}

async function updateBanner(id, { altText, caption, subcaption, sortOrder, isActive }) {
  await pool.query(
    `UPDATE cms_banners
     SET alt_text = ?, caption = ?, subcaption = ?, sort_order = ?, is_active = ?
     WHERE id = ?`,
    [altText || null, caption || null, subcaption || null, sortOrder, isActive ? 1 : 0, id],
  );
}

async function deleteBanner(id) {
  await pool.query('DELETE FROM cms_banners WHERE id = ?', [id]);
}

module.exports = {
  listSettings,
  upsertSettings,
  listAllBanners,
  listActiveBanners,
  findBannerById,
  createBanner,
  updateBanner,
  deleteBanner,
};
