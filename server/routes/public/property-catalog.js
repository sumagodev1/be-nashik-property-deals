// T-2026-058: public, read-only endpoint that returns the nested
// (Property Type -> Transaction Type -> Property Variety -> Form Code)
// dependency tree for either the Inventory or Enquiry surface.
//
// This is the SINGLE SOURCE OF TRUTH the frontend now consumes.
// `chooserTree.js` on the FE remains as a bootstrap fallback so
// installs where migration 063 hasn't run yet still work, but as
// soon as the DB has rows the FE hook auto-swaps to the network
// response.
//
// Auth-free by design — the tree is admin-vocabulary metadata, not
// property data. Both the /admin app's chooser and the public
// website's cascade dropdowns can read it without a login.
//
// Cache hint: the response is safe to CDN-cache for a minute or two
// because master rows change rarely; the FE hook already caches in
// memory for the session.

'use strict';

const express = require('express');
const Joi = require('joi');
const { validate } = require('../../middleware/validate');
const propertyFormCatalog = require('../../services/masters/propertyFormCatalog');

const router = express.Router();

const modeQuery = Joi.object({
  mode: Joi.string().valid('inventory', 'enquiry').required(),
});

router.get('/', validate(modeQuery, 'query'), async (req, res, next) => {
  try {
    const mode = req.query.mode;
    const [seeded, tree] = await Promise.all([
      propertyFormCatalog.isCatalogSeeded().catch(() => false),
      propertyFormCatalog.tree(mode).catch(() => []),
    ]);
    // A short cache lets the network layer amortise this cheap
    // read across concurrent admin sessions.
    res.set('Cache-Control', 'public, max-age=60');
    res.json({
      mode,
      seeded,     // false => migration 063 has not run; FE stays on fallback tree
      tree,       // [] when seeded=false
    });
  } catch (e) { next(e); }
});

module.exports = router;
