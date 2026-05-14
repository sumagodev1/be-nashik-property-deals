const express = require('express');
const auth = require('./auth');
const profile = require('./profile');
const properties = require('./properties');

const router = express.Router();

router.use('/auth', auth);
router.use('/profile', profile);
router.use('/properties', properties);

module.exports = router;
