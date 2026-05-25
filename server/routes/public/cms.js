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

module.exports = router;
