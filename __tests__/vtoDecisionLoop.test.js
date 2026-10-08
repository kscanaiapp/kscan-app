const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, runModule } = require('./helpers/componentRenderer');

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const types = runModule('types/vto.ts', {}, { jsx: false });
const loop = runModule('services/vto/vtoDecisionLoop.ts', {
  '../../types/vto': types,
}, { jsx: false });

const garment = Object.freeze({
  productRef: 'product-a',
  imageUrl: 'https://example.test/a.png',
  category: 'tops',
});
const result = Object.freeze({
  requestId: 'request-a',
  provider: 'test',
  dataUri: 'data:image/png;base64,AAAA',
  mediaType: 'image/png',
  width: 800,
  height: 1000,
  isAiVisualization: true,
  latencyMs: 1,
});
const snapshot = Object.freeze({
  status: 'success',
  requestId: result.requestId,
  garment,
  result,
});

test('result actions require exact request and product identity', () => {
  assert.equal(loop.vtoResultBelongsToProduct(snapshot, garment), true);
  assert.equal(loop.vtoResultBelongsToProduct({ ...snapshot, requestId: 'stale' }, garment), false);
  assert.equal(loop.vtoResultBelongsToProduct({ ...snapshot, status: 'failed' }, garment), false);
  assert.equal(loop.vtoResultBelongsToProduct(snapshot, { ...garment, productRef: 'product-b' }), false);
  assert.equal(loop.vtoResultBelongsToProduct(snapshot, { ...garment, imageUrl: null }), false);
});

test('action hierarchy is truthful and does not invent commerce', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(loop.planVtoResultActions({
    canShop: true,
    canWatch: true,
    canSave: true,
  }))), {
    primary: 'shop',
    secondary: ['save', 'watch'],
    tertiary: ['try_again', 'try_another'],
    shopUnavailable: false,
  });
  const browseOnly = loop.planVtoResultActions({ canShop: false, canWatch: false, canSave: true });
  assert.equal(browseOnly.primary, null);
  assert.equal(browseOnly.shopUnavailable, true);
  assert.deepEqual(Array.from(browseOnly.secondary), ['save']);
});

test('retry guidance is bounded and offered only for retryable failures', () => {
  assert.equal(loop.vtoFailureOffersRetry({ retryable: true }), true);
  assert.equal(loop.vtoFailureOffersRetry({ retryable: false }), false);
  assert.equal(loop.vtoRetryCooldownMs({ retryable: true, retryAfterSeconds: 12 }), 12_000);
  assert.equal(loop.vtoRetryCooldownMs({ retryable: false, retryAfterSeconds: 12 }), 0);
  assert.equal(loop.formatVtoRetryGuidance(2), 'Try again in a few seconds.');
  assert.equal(loop.formatVtoRetryGuidance(12), 'Try again in about 15 seconds.');
  assert.equal(loop.formatVtoRetryGuidance(61), 'Try again in about 2 minutes.');
});

test('VTO hands Shop and Watch to callbacks and owns no persistence authority', () => {
  const decision = read('services/vto/vtoDecisionLoop.ts');
  const sheet = read('components/vto/VirtualTryOnSheet.tsx');
  const entry = read('components/vto/TryItOnEntry.tsx');
  const host = read('components/vto/VtoLaunchHost.tsx');
  for (const forbidden of [
    'createWatch', 'watchlistClient', 'addScanImageToDressingRoom',
    'markOwned', 'recordPurchase', 'supabase',
  ]) {
    assert.equal(decision.includes(forbidden), false, forbidden);
    assert.equal(sheet.includes(forbidden), false, forbidden);
    assert.equal(entry.includes(forbidden), false, forbidden);
    assert.equal(host.includes(forbidden), false, forbidden);
  }
  assert.match(sheet, /vtoResultBelongsToProduct\(vto, garment\)/);
  assert.match(sheet, /\) : vto\.status === 'success' \? null : vto\.person \? \(/);
  assert.match(host, /setMinimized\(true\);\s*onWatch\(\);/);
  assert.match(sheet, /onShop\(\)/);
  assert.match(sheet, /onWatch\(\)/);
});
