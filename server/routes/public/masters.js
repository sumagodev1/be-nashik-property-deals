/**
 * Public, read-only endpoint that returns the active rows of a master so the
 * website (e.g. the seller's add-property form) can populate its dropdowns
 * without requiring auth. We only expose `code` + `label` to keep the API
 * surface minimal.
 */

const express = require('express');
const Joi = require('joi');

const { validate } = require('../../middleware/validate');
const management = require('../../services/masters/management');

const router = express.Router();

const keyParam = Joi.object({
  key: Joi.string().valid(...management.masterKeys()).required(),
});

router.get('/:key', validate(keyParam, 'params'), async (req, res, next) => {
  try {
    // Public endpoint fetches ALL active rows (no pagination — dropdowns need
    // the full list).
    const result = await management.listAll(req.params.key, { isActive: true });
    res.json({
      master: result.master,
      data: result.data.map((row) => ({ code: row.code, label: row.label, sortOrder: row.sortOrder })),
    });
  } catch (e) { next(e); }
});

module.exports = router;
