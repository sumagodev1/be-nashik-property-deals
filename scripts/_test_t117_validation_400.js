#!/usr/bin/env node
/**
 * T-2026-117: verify the 400 VALIDATION_ERROR path fires with the
 * documented message when draftStatus is not one of {all,draft}.
 *
 * Uses the real validate middleware from server/middleware/validate.js
 * and the actual listQuery from routes/admin/inventory-properties.js by
 * re-declaring the Joi shape byte-identically (route file pulls in
 * mysql pool + auth which we don't want to boot here).
 */
'use strict';

const Joi = require('joi');
const { validate } = require('../server/middleware/validate');

const masterCodeField = Joi.string().trim().lowercase().pattern(/^[a-z0-9][a-z0-9_-]{0,62}[a-z0-9]$/);
const listQuery = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(100).default(10),
  search: Joi.string().trim().max(255).allow('').optional(),
  district: masterCodeField.allow('').optional(),
  taluka: masterCodeField.allow('').optional(),
  shivar: masterCodeField.allow('').optional(),
  status: masterCodeField.optional(),
  dateFrom: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
  minBudget: Joi.number().min(0).optional(),
  maxBudget: Joi.number().min(0).optional(),
  draftStatus: Joi.string().valid('all', 'draft').optional().messages({
    'any.only': 'draftStatus must be either "all" or "draft".',
  }),
  sort: Joi.string()
    .pattern(/^(created_at|price|location|property_type|title):(asc|desc)$/)
    .default('title:asc'),
});

const mw = validate(listQuery, 'query');

function callMw(query) {
  return new Promise((resolve) => {
    const req = { query };
    const res = {};
    let called = false;
    mw(req, res, (err) => {
      called = true;
      resolve({ req, err });
    });
    setTimeout(() => { if (!called) resolve({ req, err: new Error('middleware did not call next()') }); }, 50);
  });
}

async function main() {
  const cases = [
    { name: 'absence',           query: {},                          expectErr: false },
    { name: 'draftStatus=all',   query: { draftStatus: 'all' },      expectErr: false },
    { name: 'draftStatus=draft', query: { draftStatus: 'draft' },    expectErr: false },
    { name: 'draftStatus=submitted', query: { draftStatus: 'submitted' }, expectErr: true, msg: 'draftStatus must be either "all" or "draft".' },
    { name: 'draftStatus=xyz',       query: { draftStatus: 'xyz' },       expectErr: true, msg: 'draftStatus must be either "all" or "draft".' },
    { name: 'draftStatus=1',         query: { draftStatus: '1' },         expectErr: true, msg: 'draftStatus must be either "all" or "draft".' },
    { name: 'draftStatus=true',      query: { draftStatus: 'true' },      expectErr: true, msg: 'draftStatus must be either "all" or "draft".' },
    { name: 'draftStatus= (empty)',  query: { draftStatus: '' },          expectErr: true },
  ];

  const results = [];
  for (const c of cases) {
    const { err } = await callMw(c.query);
    let pass;
    if (c.expectErr) {
      pass = Boolean(err) && err.status === 400 && err.code === 'VALIDATION_ERROR';
      if (c.msg && pass) {
        pass = Array.isArray(err.details) && err.details.some((d) => d.message === c.msg);
      }
    } else {
      pass = !err;
    }
    results.push({ label: c.name, pass, err });
    console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${c.name}`);
    if (!pass) {
      console.log('         err:', err && { status: err.status, code: err.code, details: err.details, msg: err.message });
    }
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n=================================================`);
  console.log(`Result: ${results.length - failed.length}/${results.length} PASS`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
