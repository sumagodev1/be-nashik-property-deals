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
    `SELECT id, image_url, title, subtitle, cta_text,
            start_date, end_date, sort_order, is_active,
            created_at, updated_at
     FROM cms_sidebar_ads
     ORDER BY sort_order ASC, id ASC
     LIMIT ? OFFSET ?`,
    [ps, offset],
  );
  return { data: rows, total: Number(total), page: p, pageSize: ps };
}

async function findActiveSidebarAds() {
  const [rows] = await pool.query(
    `SELECT id, image_url, title, subtitle, cta_text,
            start_date, end_date, sort_order
     FROM cms_sidebar_ads
     WHERE is_active = 1
       AND (start_date IS NULL OR start_date <= CURDATE())
       AND (end_date   IS NULL OR end_date   >= CURDATE())
     ORDER BY sort_order ASC, id ASC`,
  );
  return rows;
}

async function findSidebarAdById(id) {
  const [rows] = await pool.query(
    `SELECT id, image_url, title, subtitle, cta_text,
            start_date, end_date, sort_order, is_active,
            created_at, updated_at
     FROM cms_sidebar_ads
     WHERE id = ?
     LIMIT 1`,
    [id],
  );
  return rows[0] || null;
}

async function isSidebarAdCurrentlyRunning({ isActive, startDate, endDate }) {
  const [[row]] = await pool.query(
    `SELECT CASE
       WHEN ? = 1
        AND (? IS NULL OR ? <= CURDATE())
        AND (? IS NULL OR ? >= CURDATE())
       THEN 1 ELSE 0
     END AS is_running`,
    [isActive ? 1 : 0, startDate || null, startDate || null, endDate || null, endDate || null],
  );
  return Boolean(row && row.is_running);
}

async function countCurrentlyRunningSidebarAds({ excludeId = null } = {}) {
  const params = [];
  let excludeSql = '';
  if (excludeId != null) {
    excludeSql = ' AND id <> ?';
    params.push(excludeId);
  }
  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total
     FROM cms_sidebar_ads
     WHERE is_active = 1
       AND (start_date IS NULL OR start_date <= CURDATE())
       AND (end_date   IS NULL OR end_date   >= CURDATE())${excludeSql}`,
    params,
  );
  return Number(total);
}

async function findCurrentlyRunningSidebarAdBySerialNumber(serialNumber, { excludeId = null } = {}) {
  const params = [serialNumber];
  let excludeSql = '';
  if (excludeId != null) {
    excludeSql = ' AND id <> ?';
    params.push(excludeId);
  }
  const [rows] = await pool.query(
    `SELECT id
     FROM cms_sidebar_ads
     WHERE is_active = 1
       AND (start_date IS NULL OR start_date <= CURDATE())
       AND (end_date   IS NULL OR end_date   >= CURDATE())
       AND sort_order = ?${excludeSql}
     LIMIT 1`,
    params,
  );
  return rows[0] || null;
}

async function createSidebarAd({
  imageUrl,
  title,
  subtitle,
  ctaText,
  startDate,
  endDate,
  serialNumber,
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
      '/login',
      startDate || null,
      endDate || null,
      serialNumber,
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
  startDate,
  endDate,
  serialNumber,
  isActive,
}) {
  // image_url uses COALESCE, NOT a bare placeholder.
  //
  // The update route validates with { stripUnknown: true } and its Joi schema
  // (sidebarAdUpdateBody) has no imageUrl key, so imageUrl NEVER arrives here -
  // it is always undefined. With a bare `image_url = ?` that became NULL, so
  // every ordinary Save from the admin form silently erased the ad image and
  // the website fell back to its static promo. COALESCE keeps the stored value
  // whenever no new one is supplied, while still allowing a real replacement
  // if a caller ever does pass imageUrl.
  await pool.query(
    `UPDATE cms_sidebar_ads
     SET image_url = COALESCE(?, image_url), title = ?, subtitle = ?,
         cta_text = ?, cta_url = ?, start_date = ?, end_date = ?,
         sort_order = ?, is_active = ?
     WHERE id = ?`,
    [
      imageUrl ?? null,
      title,
      subtitle || null,
      ctaText || null,
      '/login',
      startDate || null,
      endDate || null,
      serialNumber,
      isActive ? 1 : 0,
      id,
    ],
  );
}

// Update a sidebar ad and swap its serial with the current owner, if any.
// This keeps Serial Number positions unique when an admin moves an ad to an
// occupied position (for example, 1 -> 3 moves the old 3 -> 1).
async function updateSidebarAdWithSerialSwap(id, {
  imageUrl,
  title,
  subtitle,
  ctaText,
  startDate,
  endDate,
  serialNumber,
  isActive,
}) {
  const conn = await pool.getConnection();
  const targetId = Number(id);
  const nextSerialNumber = Number(serialNumber);
  try {
    await conn.beginTransaction();

    const [targetRows] = await conn.query(
      `SELECT id, sort_order
       FROM cms_sidebar_ads
       WHERE id = ?
       LIMIT 1
       FOR UPDATE`,
      [targetId],
    );
    const target = targetRows[0];
    if (!target) throw new Error('Sidebar ad not found');

    const currentSerialNumber = Number(target.sort_order ?? 1);
    let conflictId = null;
    if (currentSerialNumber !== nextSerialNumber) {
      const [conflictRows] = await conn.query(
        `SELECT id
         FROM cms_sidebar_ads
         WHERE id <> ? AND sort_order = ?
         ORDER BY id ASC
         LIMIT 1
         FOR UPDATE`,
        [targetId, nextSerialNumber],
      );
      conflictId = conflictRows[0]?.id ?? null;
      if (conflictId != null) {
        // Use a temporary value so the swap remains safe even if a unique
        // index is added to sort_order in a future schema revision.
        await conn.query(
          `UPDATE cms_sidebar_ads SET sort_order = ? WHERE id = ?`,
          [-targetId, conflictId],
        );
      }
    }

    await conn.query(
      `UPDATE cms_sidebar_ads
       SET image_url = COALESCE(?, image_url), title = ?, subtitle = ?,
           cta_text = ?, cta_url = ?, start_date = ?, end_date = ?,
           sort_order = ?, is_active = ?
       WHERE id = ?`,
      [
        imageUrl ?? null,
        title,
        subtitle || null,
        ctaText || null,
        '/login',
        startDate || null,
        endDate || null,
        nextSerialNumber,
        isActive ? 1 : 0,
        targetId,
      ],
    );

    if (conflictId != null) {
      await conn.query(
        `UPDATE cms_sidebar_ads SET sort_order = ? WHERE id = ?`,
        [currentSerialNumber, conflictId],
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
  findActiveSidebarAds,
  findSidebarAdById,
  isSidebarAdCurrentlyRunning,
  countCurrentlyRunningSidebarAds,
  findCurrentlyRunningSidebarAdBySerialNumber,
  createSidebarAd,
  updateSidebarAd,
  updateSidebarAdWithSerialSwap,
  deleteSidebarAd,
};
