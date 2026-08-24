const express = require('express');
const cms = require('../../db/queries/cms');
const { toAbsolutePublicUrl } = require('../../services/files/publicUrl');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const [settings, banners] = await Promise.all([cms.listSettings(), cms.listActiveBanners()]);
    res.json({
      settings,
      banners: banners.map((b) => ({
        id: b.id,
        imageUrl: toAbsolutePublicUrl(b.image_url),
        altText: b.alt_text,
        caption: b.caption,
        subcaption: b.subcaption,
        sortOrder: b.sort_order,
      })),
    });
  } catch (e) { next(e); }
});

/**
 * Currently-running sidebar advertisements (used by <StickySidebarAd />).
 * Returns every row where is_active = 1 and today's date is inside the
 * start/end window, ordered by serial number. If no row qualifies, returns
 * 204 so the website can use its static fallback promo.
 */
router.get('/sidebar-ad', async (req, res, next) => {
  try {
    const rows = await cms.findActiveSidebarAds();
    if (rows.length === 0) return res.status(204).end();
    res.json({
      data: rows.map((row) => ({
        id: row.id,
        imageUrl: row.image_url ? toAbsolutePublicUrl(row.image_url) : null,
        title: row.title,
        subtitle: row.subtitle,
        ctaText: row.cta_text || "Post Property, It's FREE",
        serialNumber: Number(row.sort_order ?? 1),
      })),
    });
  } catch (e) { next(e); }
});

module.exports = router;
