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
 * Currently-active sidebar advertisement (used by <StickySidebarAd />).
 * Picks the single row where is_active = 1 AND today ∈ [start_date, end_date],
 * ordered by sort_order then id. If no row qualifies, returns 204 so the
 * website silently falls back to its static promo — visitors never see an
 * empty sidebar regardless of admin scheduling gaps.
 */
router.get('/sidebar-ad', async (req, res, next) => {
  try {
    const row = await cms.findActiveSidebarAd();
    if (!row) return res.status(204).end();
    res.json({
      data: {
        id: row.id,
        imageUrl: row.image_url ? toAbsolutePublicUrl(row.image_url) : null,
        title: row.title,
        subtitle: row.subtitle,
        ctaText: row.cta_text,
        ctaUrl: row.cta_url,
        sortOrder: row.sort_order,
      },
    });
  } catch (e) { next(e); }
});

module.exports = router;
