const test = require('node:test');
const assert = require('node:assert/strict');
const { runModule } = require('./helpers/componentRenderer');
const registry = runModule('services/vto/vtoLiveGarmentRegistry.ts', {});
const eligibility = runModule('services/vto/vtoEligibility.ts', {});
const garments = runModule('services/vto/vtoLiveGarment.ts', {
  './vtoEligibility': eligibility, './vtoLiveGarmentRegistry': registry,
});
const commerce = runModule('services/vto/vtoCommerceGarment.ts', {
  '../commerceDestination': { selectCommerceDestination: (urls) => urls.find(Boolean) ?? null },
  '../dressingRoomCommerce': { normalizePersistedCommerceUrl: (url) => typeof url === 'string' && url.startsWith('https://') ? url : null },
});
const contract = runModule('types/vtoLive.ts', {});
const adapter = runModule('services/vto/liveVtoNativeModule.ts', {
  'react-native': { Platform: { OS: 'android' } },
  '../../constants/featureFlags': { LIVE_VTO_NATIVE_MODULE_NAME: 'KScanLiveVto' },
  '../../types/vtoLive': contract,
});
const sessions = runModule('services/vto/vtoLiveSession.ts', {
  './liveVtoNativeModule': adapter, '../../types/vtoLive': contract,
});
const asset = registry.LIVE_VTO_GOVERNED_ASSETS.find((a) => a.assetKey === 'ascolour-5001-black-v1');
function makeId(prefix, seed) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return `${prefix}-${(hash >>> 0).toString(36)}`;
}
const product = {
  id: makeId('serper', asset.productUrl), productUrl: asset.productUrl,
  imageUrl: asset.sourceImageUrl, category: 'top', brand: 'AS Colour',
  title: 'Staple Tee 5001 - Black',
};

test('real commerce identity resolves its exact bundled asset, captures through the session controller and returns to the same product', async () => {
  const selected = structuredClone(product);
  const garment = commerce.buildVtoGarmentFromCommerceRecord(selected);
  assert.equal(garment.productRef, selected.id);
  const resolved = garments.resolveLiveGarment({ garment });
  assert.equal(resolved.status, 'ELIGIBLE');
  assert.equal(resolved.descriptor.productRef, selected.id);
  assert.equal(resolved.descriptor.assetId, asset.assetId);
  let listener;
  let loaded;
  const calls = [];
  const emit = (type, payload = {}) => listener({ type, timestamp: Date.now(), payload });
  // Controlled native adapter, deliberately not a physical camera claim.
  const native = {
    addListener: (_, fn) => { listener = fn; return { remove() { listener = null; } }; },
    loadGarment: (descriptor) => { loaded = descriptor; calls.push('load'); emit('garmentLoaded', { productRef: descriptor.productRef }); },
    start: () => { assert.equal(loaded.assetKey, asset.assetKey); calls.push('start'); emit('ready'); emit('trackingAcquired'); },
    pause() {}, resume() {}, stop() {}, dispose() { calls.push('dispose'); },
    capturePreview: async () => ({ captureId: 'controlled-preview', kind: 'PREVIEW', localUri: 'file:///controlled-preview.png', width: 720, height: 960 }),
  };
  const session = sessions.createLiveVtoSession(native);
  session.start(resolved.descriptor);
  assert.deepEqual(calls, ['load', 'start']);
  assert.equal(session.getSnapshot().state, 'TRACKING');
  assert.equal(session.getSnapshot().loadedProductRef, selected.id);
  assert.equal((await session.capturePreview()).kind, 'PREVIEW');
  session.dispose();
  assert.deepEqual(selected, product, 'return-to-commerce retains the original selection and destination');
  assert.equal(listener, null);
});

test('pilot URL matching keeps the variant and source identity significant', () => {
  for (const changes of [
    { productUrl: asset.productUrl.replace('Black', 'White') },
    { imageUrl: asset.sourceImageUrl.replace('BLACK', 'WHITE') },
    { productUrl: asset.productUrl.replace('ascolour.com', 'ascolour.com.evil.example') },
    { productUrl: asset.productUrl + '&Colour=White' },
    { productUrl: 'https://ascolour.com/staple-tee-5001/' },
  ]) {
    const garment = commerce.buildVtoGarmentFromCommerceRecord({ ...product, ...changes });
    assert.equal(garments.resolveLiveGarment({ garment }).status, 'NOT_FOUND');
    assert.equal(garment.productRef, product.id);
  }
  const garment = commerce.buildVtoGarmentFromCommerceRecord({ ...product, productUrl: product.productUrl + '&utm_source=scan' });
  assert.equal(garments.resolveLiveGarment({ garment }).status, 'ELIGIBLE');
});

test('unsupported products remain intact for Photo VTO; no garment is substituted', () => {
  const garment = commerce.buildVtoGarmentFromCommerceRecord({ ...product, id: 'unsupported', productUrl: 'https://retailer.example/other', imageUrl: 'https://retailer.example/other.png' });
  assert.equal(garments.resolveLiveGarment({ garment }).status, 'NOT_FOUND');
  assert.equal(garment.productRef, 'unsupported');
  assert.equal(garment.imageUrl, 'https://retailer.example/other.png');
});
