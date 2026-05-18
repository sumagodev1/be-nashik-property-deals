const express = require('express');
const service = require('../../services/public/stats');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    res.json(await service.publicStats());
  } catch (e) {
    next(e);
  }
});

module.exports = router;
