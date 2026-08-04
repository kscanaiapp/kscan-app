#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { STAGING_DEPLOYMENT_ALLOWLIST, filterToApproved } = require('../../security/scripts/staging-deployment-allowlist');

test('filterToApproved: an approved function passes through', () => {
  const { approved, heldBack } = filterToApproved(['stylechat-generate']);
  assert.deepEqual(approved, ['stylechat-generate']);
  assert.deepEqual(heldBack, []);
});

test('filterToApproved: a hardened-but-not-yet-approved function is held back, not silently dropped', () => {
  const { approved, heldBack } = filterToApproved(['search-vinted-secondhand']);
  assert.deepEqual(approved, []);
  assert.deepEqual(heldBack, ['search-vinted-secondhand']);
});

test('filterToApproved: a mixed manifest splits correctly', () => {
  const { approved, heldBack } = filterToApproved(['product-search-deals', 'tryon-clothes-pro', 'nike-shoe-details']);
  assert.deepEqual(approved, ['product-search-deals']);
  assert.deepEqual(heldBack.sort(), ['nike-shoe-details', 'tryon-clothes-pro']);
});

test('filterToApproved: approved + heldBack always reconstruct the full input manifest (nothing lost)', () => {
  const manifest = ['stylechat-generate', 'search-vinted-secondhand', 'tryon-clothes-pro', 'nike-shoe-details', 'product-search-deals', 'kickscrew-sneaker-description'];
  const { approved, heldBack } = filterToApproved(manifest);
  assert.deepEqual([...approved, ...heldBack].sort(), [...manifest].sort());
});

test('STAGING_DEPLOYMENT_ALLOWLIST: does not include the three functions deliberately held back this pass', () => {
  for (const name of ['search-vinted-secondhand', 'tryon-clothes-pro', 'nike-shoe-details']) {
    assert.equal(STAGING_DEPLOYMENT_ALLOWLIST.includes(name), false);
  }
});

test('STAGING_DEPLOYMENT_ALLOWLIST: includes the two functions cleared for redeploy this pass', () => {
  for (const name of ['product-search-deals', 'kickscrew-sneaker-description']) {
    assert.equal(STAGING_DEPLOYMENT_ALLOWLIST.includes(name), true);
  }
});

test('filterToApproved: an empty manifest yields nothing approved and nothing held back', () => {
  const { approved, heldBack } = filterToApproved([]);
  assert.deepEqual(approved, []);
  assert.deepEqual(heldBack, []);
});
