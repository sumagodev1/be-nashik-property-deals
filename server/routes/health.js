const express = require('express');
const { ping } = require('../db/pool');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    await ping();
    res.json({ status: 'ok', db: 'ok', uptime: process.uptime() });
  } catch (err) {
    res.status(503).json({ status: 'degraded', db: 'down', message: err.message });
  }
});

module.exports = router;
