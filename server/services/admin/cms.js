const { HttpError } = require('../../middleware/errors');
const cmsRepo = require('../../db/queries/cms');
const banners = require('../files/cmsBannerUpload');
const { toAbsolutePublicUrl } = require('../files/publicUrl');
const { isValidSettingKey, CMS_SETTING_KEYS } = require('../../constants/cms');

// ---------- banners ----------

async function listBanners() {
  const rows = await cmsRepo.listAllBanners();
  return rows.map(toBanner);
}

async function getBanner(id) {
  const row = await cmsRepo.findBannerById(id);
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Banner not found');
  return toBanner(row);
}

async function createBanner({ file, altText, caption, subcaption, sortOrder, isActive }) {
  if (!file) throw new HttpError(400, 'NO_FILE', 'Image is required');

  const persisted = await banners.persistBannerImage(file);
  try {
    const id = await cmsRepo.createBanner({
      imageUrl: persisted.publicUrl,
      altText,
      caption,
      subcaption,
      sortOrder: Number.isFinite(sortOrder) ? sortOrder : 0,
      isActive: isActive !== false,
    });
    return getBanner(id);
  } catch (err) {
    // INSERT failed after we wrote the file — roll back the disk + quota.
    await banners.deleteBannerImage(persisted.publicUrl);
    throw err;
  }
}

async function updateBanner(id, payload) {
  const existing = await cmsRepo.findBannerById(id);
  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Banner not found');
  await cmsRepo.updateBanner(id, {
    // PUT is partial — only overwrite fields the caller actually included.
    altText: 'altText' in payload ? payload.altText : existing.alt_text,
    caption: 'caption' in payload ? payload.caption : existing.caption,
    subcaption: 'subcaption' in payload ? payload.subcaption : existing.subcaption,
    sortOrder: Number.isFinite(payload.sortOrder) ? payload.sortOrder : existing.sort_order,
    isActive: typeof payload.isActive === 'boolean' ? payload.isActive : Boolean(existing.is_active),
  });
  return getBanner(id);
}

async function deleteBanner(id) {
  const existing = await cmsRepo.findBannerById(id);
  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Banner not found');
  await cmsRepo.deleteBanner(id);
  if (existing.image_url) {
    await banners.deleteBannerImage(existing.image_url);
  }
}

// ---------- settings ----------

async function readSettings() {
  const stored = await cmsRepo.listSettings();
  // Return a stable shape — every allowed key, value or null.
  const out = {};
  for (const k of CMS_SETTING_KEYS) out[k] = stored[k] ?? null;
  return out;
}

async function writeSettings(payload) {
  const entries = [];
  for (const [key, value] of Object.entries(payload || {})) {
    if (!isValidSettingKey(key)) {
      throw new HttpError(400, 'UNKNOWN_SETTING', `Unknown setting key: ${key}`);
    }
    entries.push({ key, value: value == null ? null : String(value).trim() });
  }
  if (entries.length === 0) {
    throw new HttpError(400, 'NO_VALUES', 'No settings provided');
  }
  await cmsRepo.upsertSettings(entries);
  return readSettings();
}

function toBanner(row) {
  return {
    id: row.id,
    imageUrl: toAbsolutePublicUrl(row.image_url),
    altText: row.alt_text,
    caption: row.caption,
    subcaption: row.subcaption,
    sortOrder: Number(row.sort_order || 0),
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

module.exports = {
  listBanners,
  getBanner,
  createBanner,
  updateBanner,
  deleteBanner,
  readSettings,
  writeSettings,
};
