const express = require('express');
const Joi = require('joi');

const { validate } = require('../../middleware/validate');
const service = require('../../services/admin/business_associates');

const router = express.Router();

// Homepage strip — small cap so a stray high `pageSize` can't be used
// to scrape the whole directory unauthenticated.
const listQuery = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(24).default(6),
});

router.get('/', validate(listQuery, 'query'), async (req, res, next) => {
  try {
    res.json(await service.list(req.query));
  } catch (e) { next(e); }
});

module.exports = router;
