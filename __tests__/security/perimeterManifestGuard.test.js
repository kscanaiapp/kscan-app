#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  HELD_FUNCTIONS,
  PRODUCTION_REF,
  assertNotProductionRef,
  detectHeldFunctionsDeployed,
  detectUnclassifiedFunctions,
  detectVerifyJwtDrift,
} = require('../../security/scripts/perimeter-manifest-guard');

test('HELD_FUNCTIONS covers exactly the three currently-held functions', () => {
  assert.deepEqual([...HELD_FUNCTIONS].sort(), ['nike-shoe-details', 'search-vinted-secondhand', 'tryon-clothes-pro']);
});

test('detectHeldFunctionsDeployed: reports nothing when no held function is live', () => {
  const live = ['stylechat-generate', 'kickscrew-sneaker-description'];
  assert.deepEqual(detectHeldFunctionsDeployed(live), []);
});

test('detectHeldFunctionsDeployed: flags a held function that has become live', () => {
  const live = ['stylechat-generate', 'nike-shoe-details'];
  assert.deepEqual(detectHeldFunctionsDeployed(live), ['nike-shoe-details']);
});

test('detectHeldFunctionsDeployed: flags multiple held functions if more than one is live', () => {
  const live = ['tryon-clothes-pro', 'search-vinted-secondhand'];
  assert.deepEqual(detectHeldFunctionsDeployed(live).sort(), ['search-vinted-secondhand', 'tryon-clothes-pro']);
});

test('detectUnclassifiedFunctions: a live function present in the manifest is not flagged', () => {
  const manifest = [{ type: 'supabase_edge_function', name: 'stylechat-generate' }];
  assert.deepEqual(detectUnclassifiedFunctions(['stylechat-generate'], manifest), []);
});

test('detectUnclassifiedFunctions: a brand-new live function absent from the manifest is flagged', () => {
  const manifest = [{ type: 'supabase_edge_function', name: 'stylechat-generate' }];
  assert.deepEqual(detectUnclassifiedFunctions(['stylechat-generate', 'brand-new-function'], manifest), ['brand-new-function']);
});

test('detectUnclassifiedFunctions: ignores non-edge-function manifest entries when matching', () => {
  const manifest = [
    { type: 'supabase_rpc', name: 'get_public_room_preview' },
    { type: 'supabase_edge_function', name: 'stylechat-generate' },
  ];
  // A live function slug that happens to collide with an RPC name (not realistic, but proves the type filter matters)
  assert.deepEqual(detectUnclassifiedFunctions(['get_public_room_preview'], manifest), ['get_public_room_preview']);
});

test('detectVerifyJwtDrift: reports nothing when live matches expected', () => {
  const live = [{ slug: 'stylechat-generate', verify_jwt: true }];
  assert.deepEqual(detectVerifyJwtDrift(live, { 'stylechat-generate': true }), []);
});

test('detectVerifyJwtDrift: flags a documented-true function that flips to false', () => {
  const live = [{ slug: 'privacy-correction-request', verify_jwt: false }];
  const drift = detectVerifyJwtDrift(live, { 'privacy-correction-request': true });
  assert.deepEqual(drift, [{ slug: 'privacy-correction-request', expected: true, actual: false }]);
});

test('detectVerifyJwtDrift: does not flag a function absent from the expected map (handled by the unclassified check instead)', () => {
  const live = [{ slug: 'some-new-function', verify_jwt: false }];
  assert.deepEqual(detectVerifyJwtDrift(live, {}), []);
});

test('assertNotProductionRef: throws for the production ref', () => {
  assert.throws(() => assertNotProductionRef(PRODUCTION_REF));
});

test('assertNotProductionRef: does not throw for the staging ref', () => {
  assert.doesNotThrow(() => assertNotProductionRef('yzqjvdfgefveprobvvyw'));
});
