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

async function listAllBanners({ page = 1, pageSize = 10 } = {}) {
  const p = Math.max(1, Number(page) || 1);
  const ps = Math.max(1, Math.min(100, Number(pageSize) || 10));
  const offset = (p - 1) * ps;
  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM cms_banners`,
  );
  const [rows] = await pool.query(
    `SELECT id, image_url, alt_text, caption, subcaption, sort_order, is_active, created_at, updated_at
     FROM cms_banners
     ORDER BY sort_order ASC, id ASC
     LIMIT ? OFFSET ?`,
    [ps, offset],
  );
  return { data: rows, total: Number(total), page: p, pageSize: ps };
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

// ---------- sidebar ads ----------
//
// Active-window check uses CURDATE() so a midnight rollover doesn't require
// the admin to refresh anything — the new day's eligible ads start showing
// automatically. NULL start_date or end_date means "open-ended" on that
// side (typical for evergreen ads with no scheduled end).

async function listAllSidebarAds({ page = 1, pageSize = 10 } = {}) {
  const p = Math.max(1, Number(page) || 1);
  const ps = Math.max(1, Math.min(100, Number(pageSize) || 10));
  const offset = (p - 1) * ps;
  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM cms_sidebar_ads`,
  );
  const [rows] = await pool.query(
    `SELECT id, image_url, title, subtitle, cta_text, cta_url,
            start_date, end_date, sort_order, is_active,
            created_at, updated_at
     FROM cms_sidebar_ads
     ORDER BY sort_order ASC, id DESC
     LIMIT ? OFFSET ?`,
    [ps, offset],
  );
  return { data: rows, total: Number(total), page: p, pageSize: ps };
}

async function findActiveSidebarAd() {
  const [rows] = await pool.query(
    `SELECT id, image_url, title, subtitle, cta_text, cta_url,
            start_date, end_date, sort_order
     FROM cms_sidebar_ads
     WHERE is_active = 1
       AND (start_date IS NULL OR start_date <= CURDATE())
       AND (end_date   IS NULL OR end_date   >= CURDATE())
     ORDER BY sort_order ASC, id DESC
     LIMIT 1`,
  );
  return rows[0] || null;
}

async function findSidebarAdById(id) {
  const [rows] = await pool.query(
    `SELECT id, image_url, title, subtitle, cta_text, cta_url,
            start_date, end_date, sort_order, is_active,
            created_at, updated_at
     FROM cms_sidebar_ads
     WHERE id = ?
     LIMIT 1`,
    [id],
  );
  return rows[0] || null;
}

async function createSidebarAd({
  imageUrl,
  title,
  subtitle,
  ctaText,
  ctaUrl,
  startDate,
  endDate,
  sortOrder,
  isActive,
}) {
  const [result] = await pool.query(
    `INSERT INTO cms_sidebar_ads
       (image_url, title, subtitle, cta_text, cta_url,
        start_date, end_date, sort_order, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      imageUrl || null,
      title,
      subtitle || null,
      ctaText || null,
      ctaUrl || null,
      startDate || null,
      endDate || null,
      sortOrder,
      isActive ? 1 : 0,
    ],
  );
  return result.insertId;
}

async function updateSidebarAd(id, {
  imageUrl,
  title,
  subtitle,
  ctaText,
  ctaUrl,
  startDate,
  endDate,
  sortOrder,
  isActive,
}) {
  await pool.query(
    `UPDATE cms_sidebar_ads
     SET image_url = ?, title = ?, subtitle = ?, cta_text = ?, cta_url = ?,
         start_date = ?, end_date = ?, sort_order = ?, is_active = ?
     WHERE id = ?`,
    [
      imageUrl ?? null,
      title,
      subtitle || null,
      ctaText || null,
      ctaUrl || null,
      startDate || null,
      endDate || null,
      sortOrder,
      isActive ? 1 : 0,
      id,
    ],
  );
}

async function deleteSidebarAd(id) {
  await pool.query('DELETE FROM cms_sidebar_ads WHERE id = ?', [id]);
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
  listAllSidebarAds,
  findActiveSidebarAd,
  findSidebarAdById,
  createSidebarAd,
  updateSidebarAd,
  deleteSidebarAd,
};
