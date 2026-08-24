const { HttpError } = require('../../middleware/errors');
const cmsRepo = require('../../db/queries/cms');
const banners = require('../files/cmsBannerUpload');
const { toAbsolutePublicUrl } = require('../files/publicUrl');
const { isValidSettingKey, CMS_SETTING_KEYS } = require('../../constants/cms');

const MAX_RUNNING_SIDEBAR_ADS = 5;
const MAX_SIDEBAR_AD_SERIAL_NUMBER = 5;
const DEFAULT_SIDEBAR_CTA_TEXT = "Post Property, It's FREE";
const SIDEBAR_AD_LIMIT_MESSAGE =
  '5 sidebar advertisements are already active on the website. Please disable an existing advertisement before adding or activating a new one.';
const SIDEBAR_AD_SERIAL_LIMIT_MESSAGE =
  'Serial Number cannot be greater than 5.';

// ---------- banners ----------

async function listBanners(query = {}) {
  const result = await cmsRepo.listAllBanners(query);
  return {
    data: result.data.map(toBanner),
    total: result.total,
    page: result.page,
    pageSize: result.pageSize,
    totalPages: Math.max(1, Math.ceil(result.total / result.pageSize)),
  };
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

// ---------- sidebar ads ----------

async function listSidebarAds(query = {}) {
  const result = await cmsRepo.listAllSidebarAds(query);
  return {
    data: result.data.map(toSidebarAd),
    total: result.total,
    page: result.page,
    pageSize: result.pageSize,
    totalPages: Math.max(1, Math.ceil(result.total / result.pageSize)),
  };
}

async function getSidebarAd(id) {
  const row = await cmsRepo.findSidebarAdById(id);
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Sidebar ad not found');
  return toSidebarAd(row);
}

async function getActiveSidebarAds() {
  const rows = await cmsRepo.findActiveSidebarAds();
  return rows.map(toSidebarAd);
}

async function ensureSidebarAdCapacity({ id = null, existing = null, startDate, endDate, isActive, serialNumber }) {
  if (!Number.isInteger(serialNumber) || serialNumber < 1 || serialNumber > MAX_SIDEBAR_AD_SERIAL_NUMBER) {
    throw new HttpError(400, 'SIDEBAR_AD_SERIAL_OUT_OF_RANGE', SIDEBAR_AD_SERIAL_LIMIT_MESSAGE);
  }
  const candidateRunning = await cmsRepo.isSidebarAdCurrentlyRunning({ isActive, startDate, endDate });
  if (!candidateRunning) return;

  // Updating an already-running ad does not increase the running count. This
  // also keeps legacy over-limit data editable and deactivatable.
  const existingRunning = existing
    ? await cmsRepo.isSidebarAdCurrentlyRunning({
      isActive: existing.is_active,
      startDate: existing.start_date,
      endDate: existing.end_date,
    })
    : false;

  if (!existingRunning) {
    const runningCount = await cmsRepo.countCurrentlyRunningSidebarAds({ excludeId: id });
    if (runningCount >= MAX_RUNNING_SIDEBAR_ADS) {
      throw new HttpError(409, 'SIDEBAR_AD_LIMIT_REACHED', SIDEBAR_AD_LIMIT_MESSAGE);
    }
  }

  // If an occupied serial is selected during an edit, the repository swaps
  // the two positions atomically so the edited ad takes the requested serial.
}

async function createSidebarAd({
  file,
  title,
  subtitle,
  ctaText,
  startDate,
  endDate,
  serialNumber,
  isActive,
}) {
  const nextIsActive = isActive !== false;
  const nextCtaText = String(ctaText || DEFAULT_SIDEBAR_CTA_TEXT).trim();
  const nextSerialNumber = Number.isFinite(serialNumber) ? serialNumber : 1;
  await ensureSidebarAdCapacity({
    startDate,
    endDate,
    isActive: nextIsActive,
    serialNumber: nextSerialNumber,
  });

  // Image is optional for sidebar ads — admins may want a text-only promo,
  // and the website renders a sensible layout either way. If a file IS
  // present we persist it through the existing cms upload pipeline.
  let persisted = null;
  if (file) {
    persisted = await banners.persistBannerImage(file);
  }
  try {
    const id = await cmsRepo.createSidebarAd({
      imageUrl: persisted ? persisted.publicUrl : null,
      title,
      subtitle,
      ctaText: nextCtaText,
      startDate,
      endDate,
      serialNumber: nextSerialNumber,
      isActive: nextIsActive,
    });
    return getSidebarAd(id);
  } catch (err) {
    if (persisted) await banners.deleteBannerImage(persisted.publicUrl);
    throw err;
  }
}

async function updateSidebarAd(id, payload) {
  const existing = await cmsRepo.findSidebarAdById(id);
  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Sidebar ad not found');
  const next = {
    startDate: 'startDate' in payload ? payload.startDate : existing.start_date,
    endDate: 'endDate' in payload ? payload.endDate : existing.end_date,
    ctaText: 'ctaText' in payload
      ? String(payload.ctaText || '').trim()
      : (existing.cta_text || DEFAULT_SIDEBAR_CTA_TEXT),
    serialNumber: 'serialNumber' in payload
      ? payload.serialNumber
      : ('sortOrder' in payload
        ? payload.sortOrder
        : (existing.sort_order == null ? 1 : Number(existing.sort_order))),
    isActive: typeof payload.isActive === 'boolean' ? payload.isActive : Boolean(existing.is_active),
  };
  await ensureSidebarAdCapacity({ id, existing, ...next });
  // PUT is partial — only fields present in payload overwrite existing values.
  await cmsRepo.updateSidebarAdWithSerialSwap(id, {
    imageUrl: 'imageUrl' in payload ? payload.imageUrl : existing.image_url,
    title: 'title' in payload ? payload.title : existing.title,
    subtitle: 'subtitle' in payload ? payload.subtitle : existing.subtitle,
    ctaText: next.ctaText || DEFAULT_SIDEBAR_CTA_TEXT,
    startDate: next.startDate,
    endDate: next.endDate,
    serialNumber: next.serialNumber,
    isActive: next.isActive,
  });
  return getSidebarAd(id);
}

async function deleteSidebarAd(id) {
  const existing = await cmsRepo.findSidebarAdById(id);
  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Sidebar ad not found');
  await cmsRepo.deleteSidebarAd(id);
  if (existing.image_url) {
    await banners.deleteBannerImage(existing.image_url);
  }
}

function toSidebarAd(row) {
  return {
    id: row.id,
    imageUrl: row.image_url ? toAbsolutePublicUrl(row.image_url) : null,
    title: row.title,
    subtitle: row.subtitle,
    ctaText: row.cta_text || DEFAULT_SIDEBAR_CTA_TEXT,
    // Date columns come back as JS Date instances from mysql2. Coerce to
    // ISO `YYYY-MM-DD` so the frontend's <input type="date"> can bind to
    // them directly without locale weirdness.
    startDate: row.start_date ? toIsoDate(row.start_date) : null,
    endDate: row.end_date ? toIsoDate(row.end_date) : null,
    serialNumber: Number(row.sort_order ?? 1),
    isActive: row.is_active != null ? Boolean(row.is_active) : true,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toIsoDate(d) {
  if (d instanceof Date) {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }
  // Already a string (some drivers return DATE as 'YYYY-MM-DD' directly).
  return String(d).slice(0, 10);
}

module.exports = {
  listBanners,
  getBanner,
  createBanner,
  updateBanner,
  deleteBanner,
  readSettings,
  writeSettings,
  listSidebarAds,
  getSidebarAd,
  getActiveSidebarAds,
  createSidebarAd,
  updateSidebarAd,
  deleteSidebarAd,
};
