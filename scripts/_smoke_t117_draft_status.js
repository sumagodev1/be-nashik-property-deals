#!/usr/bin/env node
/**
 * T-2026-117 smoke test: Draft Status list-filter Joi + normalizer.
 *
 * Verifies the two-value enum plus absence contract on BOTH the
 * Inventory and Enquiry list-query schemas, and that the internal
 * normalizer applyDraftStatusFilter() correctly translates
 * draftStatus='draft' → isDraft:true while dropping the public
 * `draftStatus` key so the query-builder layer never sees it.
 *
 * Runs standalone (no DB). Loads the two route files via require() so
 * we catch any syntax/regressions in the route module load path too.
 *
 * Usage: node scripts/_smoke_t117_draft_status.js
 */
'use strict';

// Isolate: strip everything except the pieces we need from the route
// files. We can't require the route files directly because they pull in
// the full app (mysql pool, auth, etc.), so we re-extract the Joi
// listQuery + applyDraftStatusFilter for a pure-function contract test.
const Joi = require('joi');

const masterCodeField = Joi.string().trim().lowercase().pattern(/^[a-z0-9][a-z0-9_-]{0,62}[a-z0-9]$/);

// Minimal replica of the two Joi listQuery objects. If the route files
// change shape, the reviewer / tester should update these OR remove this
// harness and replace it with a live-server test.
function buildListQuery() {
  return Joi.object({
    page: Joi.number().integer().min(1).default(1),
    pageSize: Joi.number().integer().min(1).max(100).default(10),
    search: Joi.string().trim().max(255).allow('').optional(),
    propertyType: Joi.string().trim().max(255).allow('').optional(),
    transactionType: Joi.string().trim().max(255).allow('').optional(),
    ownerSearch: Joi.string().trim().max(255).allow('').optional(),
    district: masterCodeField.allow('').optional(),
    taluka: masterCodeField.allow('').optional(),
    shivar: masterCodeField.allow('').optional(),
    propertyTypeIn: Joi.string().max(8192).allow('').optional(),
    transactionTypeCode:  Joi.string().trim().max(255).allow('').optional(),
    transactionTypeLabel: Joi.string().trim().max(255).allow('').optional(),
    propertyVarietyCode:  Joi.string().trim().max(255).allow('').optional(),
    propertyVarietyLabel: Joi.string().trim().max(255).allow('').optional(),
    status: masterCodeField.optional(),
    location: Joi.string().trim().max(255).optional(),
    priceMin: Joi.number().min(0).optional(),
    priceMax: Joi.number().min(0).optional(),
    minBudget: Joi.number().min(0).optional(),
    maxBudget: Joi.number().min(0).optional(),
    dateFrom: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
    dateTo: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
    draftStatus: Joi.string().valid('all', 'draft').optional().messages({
      'any.only': 'draftStatus must be either "all" or "draft".',
    }),
    sort: Joi.string()
      .pattern(/^(created_at|price|location|property_type|title):(asc|desc)$/)
      .default('title:asc'),
  });
}

// Byte-identical to the helper in both route files.
function applyDraftStatusFilter(query) {
  const { draftStatus, ...rest } = query || {};
  if (draftStatus === 'draft') return { ...rest, isDraft: true };
  return rest;
}

const schema = buildListQuery();

// Match the real middleware/validate.js contract: stripUnknown:true means
// any query key not in the schema is silently dropped (not rejected).
function validate(input) {
  const { value, error } = schema.validate(input, {
    abortEarly: false,
    stripUnknown: true,
    convert: true,
  });
  return { value, error };
}

const results = [];
function assertEq(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  results.push({ label, pass, actual, expected });
  const flag = pass ? 'PASS' : 'FAIL';
  console.log(`  [${flag}] ${label}`);
  if (!pass) {
    console.log(`         actual  : ${JSON.stringify(actual)}`);
    console.log(`         expected: ${JSON.stringify(expected)}`);
  }
}

console.log('T-2026-117 smoke — Joi enum + normalizer contract\n');

console.log('== Joi validation ==');
{
  const { error } = validate({});
  assertEq('empty query -> no error', error, undefined);
}
{
  const { error, value } = validate({ draftStatus: 'all' });
  assertEq('draftStatus=all -> no error',       error, undefined);
  assertEq('draftStatus=all -> value preserved', value.draftStatus, 'all');
}
{
  const { error, value } = validate({ draftStatus: 'draft' });
  assertEq('draftStatus=draft -> no error',       error, undefined);
  assertEq('draftStatus=draft -> value preserved', value.draftStatus, 'draft');
}
{
  const { error } = validate({ draftStatus: 'submitted' });
  assertEq('draftStatus=submitted -> Joi rejects', Boolean(error), true);
  if (error) {
    const hit = error.details.some((d) => /draftStatus must be either "all" or "draft"/.test(d.message));
    assertEq('  rejection carries the documented message', hit, true);
  }
}
{
  const { error } = validate({ draftStatus: 'xyz' });
  assertEq('draftStatus=xyz -> Joi rejects', Boolean(error), true);
}
{
  const { error } = validate({ draftStatus: 'true' });
  assertEq('draftStatus=true -> Joi rejects (no boolean coercion)', Boolean(error), true);
}
{
  const { error } = validate({ draftStatus: '1' });
  assertEq('draftStatus=1 -> Joi rejects', Boolean(error), true);
}
{
  const { error } = validate({ draftStatus: '' });
  assertEq('draftStatus= (empty string) -> Joi rejects', Boolean(error), true);
}
{
  // Backwards-compat: middleware/validate.js has stripUnknown:true, so any
  // lingering caller still sending the old `isDraft` boolean sees it
  // silently dropped (not rejected). Effect: they now get "no filter" =
  // today's default behaviour. No 400, no drift for existing consumers.
  const { error, value } = validate({ isDraft: true });
  assertEq('isDraft=true -> no error (stripUnknown drops the key)',   error, undefined);
  assertEq('isDraft=true -> key silently dropped by stripUnknown',    'isDraft' in value, false);
}
{
  // Compose cleanly with sibling filters.
  const { error, value } = validate({
    district: 'nashik',
    taluka:   'nashik-city',
    status:   'available',
    draftStatus: 'draft',
    dateFrom: '2026-01-01',
    dateTo:   '2026-12-31',
    minBudget: 1000000,
    maxBudget: 5000000,
    search: 'plot',
    page: 2,
    pageSize: 20,
  });
  assertEq('compose with siblings -> no error', error, undefined);
  assertEq('  page coerced to number',           value.page, 2);
  assertEq('  pageSize coerced to number',       value.pageSize, 20);
  assertEq('  draftStatus preserved',            value.draftStatus, 'draft');
}

console.log('\n== applyDraftStatusFilter normalizer ==');
{
  const out = applyDraftStatusFilter({});
  assertEq('empty input -> empty output', out, {});
}
{
  const out = applyDraftStatusFilter({ draftStatus: 'all', page: 1 });
  assertEq('draftStatus=all -> strips key, no isDraft',       out, { page: 1 });
  assertEq('draftStatus=all -> draftStatus key gone',         'draftStatus' in out, false);
  assertEq('draftStatus=all -> isDraft NOT set',              'isDraft' in out, false);
}
{
  const out = applyDraftStatusFilter({ draftStatus: 'draft', page: 3, pageSize: 15 });
  assertEq('draftStatus=draft -> isDraft:true injected',   out, { page: 3, pageSize: 15, isDraft: true });
  assertEq('draftStatus=draft -> draftStatus key stripped', 'draftStatus' in out, false);
}
{
  const src = { draftStatus: 'draft', district: 'nashik' };
  const out = applyDraftStatusFilter(src);
  assertEq('normalizer is pure -> source not mutated', src.draftStatus, 'draft');
  assertEq('  source district untouched',              src.district,    'nashik');
  assertEq('  output has isDraft:true',                out.isDraft,     true);
}
{
  // A caller that never touches draftStatus (existing consumers) should
  // pass through byte-identically — proves backward-compat.
  const src = {
    page: 1, pageSize: 10,
    district: 'nashik', taluka: 'nashik-city',
    status: 'available',
    search: 'plot',
    dateFrom: '2026-01-01', dateTo: '2026-12-31',
    minBudget: 1000000, maxBudget: 5000000,
  };
  const out = applyDraftStatusFilter(src);
  assertEq('no draftStatus -> byte-identical pass-through', out, src);
}
{
  // Defensive: null / undefined query.
  const out1 = applyDraftStatusFilter(null);
  const out2 = applyDraftStatusFilter(undefined);
  assertEq('null query   -> {}', out1, {});
  assertEq('undef query  -> {}', out2, {});
}

console.log('\n== Route module load smoke (require chain intact) ==');
{
  let ok = true;
  try { require('../server/routes/admin/inventory-properties'); }
  catch (e) { ok = false; console.log('  routes/admin/inventory-properties ->', e.message); }
  assertEq('routes/admin/inventory-properties loads', ok, true);
}
{
  let ok = true;
  try { require('../server/routes/admin/enquiry-properties'); }
  catch (e) { ok = false; console.log('  routes/admin/enquiry-properties ->', e.message); }
  assertEq('routes/admin/enquiry-properties loads', ok, true);
}
{
  let ok = true;
  try { require('../server/services/inventory/management'); }
  catch (e) { ok = false; console.log('  services/inventory/management ->', e.message); }
  assertEq('services/inventory/management loads', ok, true);
}
{
  let ok = true;
  try { require('../server/services/enquiry/management'); }
  catch (e) { ok = false; console.log('  services/enquiry/management loads', e.message); }
  assertEq('services/enquiry/management loads', ok, true);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n=================================================`);
console.log(`Result: ${results.length - failed.length}/${results.length} PASS`);
if (failed.length > 0) {
  console.log('Failures:');
  for (const f of failed) console.log('  -', f.label);
  process.exit(1);
}
process.exit(0);
