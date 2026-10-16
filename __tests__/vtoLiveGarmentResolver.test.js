// Governed Live-VTO asset resolver -- productRef -> ELIGIBLE(asset) |
// INELIGIBLE(reason) | NOT_FOUND | ERROR.
//
// WHY THIS FILE EXISTS. Before resolveLiveGarment, loadGarment/switchGarment
// resolved EVERY descriptor to the SAME bundled native fixture regardless of
// the requested productRef (docs/vto-live-bridge-contract.md §13.5). These
// tests prove the resolver that closes that gap: two DIFFERENT real
// governed assets are distinguished by productRef, an unknown or
// category-ineligible product is refused rather than defaulted to a
// fixture, and the resolved descriptor carries the exact asset identity
// native needs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function loadTsModule(relativePath, requireMap = {}) {
  const filename = path.join(ROOT, relativePath);
  const output = ts.transpileModule(read(relativePath), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const mod = { exports: {} };
  const sandbox = {
    console,
    exports: mod.exports,
    module: mod,
    URL, Math, Number, Set, Map, Object, Array, JSON, Date, RangeError, String, Promise,
    __DEV__: false,
    process: { env: {} },
    require: (specifier) => {
      if (Object.prototype.hasOwnProperty.call(requireMap, specifier)) {
        return requireMap[specifier];
      }
      throw new Error(`Unexpected import in ${path.basename(filename)}: ${specifier}`);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename }).runInContext(sandbox);
  return mod.exports;
}

const eligibility = loadTsModule('services/vto/vtoEligibility.ts');
const registry = loadTsModule('services/vto/vtoLiveGarmentRegistry.ts');
const liveGarment = loadTsModule('services/vto/vtoLiveGarment.ts', {
  './vtoEligibility': eligibility,
  './vtoLiveGarmentRegistry': registry,
});

const { resolveLiveGarment, evaluateLiveGarmentEligibility, isLiveGarmentEligible } = liveGarment;
const { LIVE_VTO_GOVERNED_ASSETS } = registry;

const ASSET_A = LIVE_VTO_GOVERNED_ASSETS.find((a) => a.assetKey === 'n1b-fixture');
const ASSET_B = LIVE_VTO_GOVERNED_ASSETS.find((a) => a.assetKey === 'n1c-asym-fixture');

function garment(overrides = {}) {
  return {
    productRef: ASSET_A.productRef,
    imageUrl: 'https://retailer.example/photo.jpg',
    category: 'top',
    brand: null,
    commerceSource: 'test',
    ...overrides,
  };
}

// ── Fixture sanity ──────────────────────────────────────────────────────────

test('the registry has (at least) two distinct governed assets to resolve against', () => {
  assert.ok(ASSET_A, 'n1b-fixture entry must exist');
  assert.ok(ASSET_B, 'n1c-asym-fixture entry must exist');
  assert.notEqual(ASSET_A.productRef, ASSET_B.productRef);
  assert.notEqual(ASSET_A.assetId, ASSET_B.assetId);
});

// ── ELIGIBLE ─────────────────────────────────────────────────────────────────

test('resolveLiveGarment: a known governed productRef resolves ELIGIBLE with its OWN asset identity', () => {
  const resolution = resolveLiveGarment({ garment: garment({ productRef: ASSET_A.productRef }) });
  assert.equal(resolution.status, 'ELIGIBLE');
  assert.equal(resolution.descriptor.productRef, ASSET_A.productRef);
  assert.equal(resolution.descriptor.assetKey, 'n1b-fixture');
  assert.equal(resolution.descriptor.assetId, ASSET_A.assetId);
  assert.equal(resolution.descriptor.assetVersion, ASSET_A.assetVersion);
  assert.equal(resolution.asset.assetKey, 'n1b-fixture');
  assert.equal(resolution.asset.sourceManifestId, ASSET_A.assetId);
  assert.equal(resolution.asset.ksgarmentSchemaVersion, '1.0');
  assert.equal(resolution.asset.retrievalAddress, 'bundled-asset://n1b-fixture');
});

test('resolveLiveGarment: PRODUCT A RESOLVES ASSET A, PRODUCT B RESOLVES ASSET B -- the required identity proof', () => {
  const a = resolveLiveGarment({ garment: garment({ productRef: ASSET_A.productRef }) });
  const b = resolveLiveGarment({ garment: garment({ productRef: ASSET_B.productRef }) });
  assert.equal(a.status, 'ELIGIBLE');
  assert.equal(b.status, 'ELIGIBLE');
  // Different productRef -> different assetKey/assetId/assetVersion-bearing
  // descriptor. Not merely "different productRef string carried through" --
  // the underlying asset identity actually differs.
  assert.notEqual(a.descriptor.assetKey, b.descriptor.assetKey);
  assert.notEqual(a.descriptor.assetId, b.descriptor.assetId);
  assert.equal(a.descriptor.productRef, ASSET_A.productRef);
  assert.equal(b.descriptor.productRef, ASSET_B.productRef);
});

// ── NOT_FOUND ────────────────────────────────────────────────────────────────

test('resolveLiveGarment: an unknown productRef is NOT_FOUND, not a silent fixture default', () => {
  const resolution = resolveLiveGarment({ garment: garment({ productRef: 'asos-real-catalog-sku-4471829' }) });
  assert.equal(resolution.status, 'NOT_FOUND');
  assert.equal(resolution.productRef, 'asos-real-catalog-sku-4471829');
  assert.equal(resolution.descriptor, undefined);
});

test('resolveLiveGarment: NOT_FOUND cannot be coerced into loading the bundled fixture (hard negative control)', () => {
  const resolution = resolveLiveGarment({ garment: garment({ productRef: 'totally-unaddressed-product' }) });
  assert.equal(resolution.status, 'NOT_FOUND');
  assert.ok(!('descriptor' in resolution) || resolution.descriptor === undefined);
  assert.ok(!('asset' in resolution) || resolution.asset === undefined);
});

// ── INELIGIBLE ───────────────────────────────────────────────────────────────

test('resolveLiveGarment: missing productRef is INELIGIBLE(invalid_product_reference), never NOT_FOUND', () => {
  const resolution = resolveLiveGarment({ garment: garment({ productRef: '' }) });
  assert.equal(resolution.status, 'INELIGIBLE');
  assert.equal(resolution.reason, 'invalid_product_reference');
});

test('resolveLiveGarment: null garment is INELIGIBLE(invalid_product_reference)', () => {
  const resolution = resolveLiveGarment({ garment: null });
  assert.equal(resolution.status, 'INELIGIBLE');
  assert.equal(resolution.reason, 'invalid_product_reference');
});

test('resolveLiveGarment: an unsupported category is INELIGIBLE(unsupported_category) even for a governed productRef', () => {
  const resolution = resolveLiveGarment({
    garment: garment({ productRef: ASSET_A.productRef, category: 'outerwear' }),
  });
  assert.equal(resolution.status, 'INELIGIBLE');
  assert.equal(resolution.reason, 'unsupported_category');
});

test('resolveLiveGarment: a missing image is INELIGIBLE(missing_garment_image)', () => {
  const resolution = resolveLiveGarment({ garment: garment({ imageUrl: '' }) });
  assert.equal(resolution.status, 'INELIGIBLE');
  assert.equal(resolution.reason, 'missing_garment_image');
});

test('resolveLiveGarment: a found asset whose own QA/eligibility says no is INELIGIBLE(asset_not_eligible), not silently accepted', () => {
  const ineligibleRegistry = [
    { ...ASSET_A, productRef: 'excluded-product', eligible: false, ineligibleReason: 'segmentation_below_threshold' },
  ];
  const resolution = resolveLiveGarment({
    garment: garment({ productRef: 'excluded-product' }),
    registry: ineligibleRegistry,
  });
  assert.equal(resolution.status, 'INELIGIBLE');
  assert.equal(resolution.reason, 'asset_not_eligible');
});

test('resolveLiveGarment: a found asset that failed QA is INELIGIBLE(asset_not_eligible) even if eligibility.live2d says true', () => {
  const badQaRegistry = [{ ...ASSET_A, productRef: 'bad-qa-product', qaPassed: false }];
  const resolution = resolveLiveGarment({
    garment: garment({ productRef: 'bad-qa-product' }),
    registry: badQaRegistry,
  });
  assert.equal(resolution.status, 'INELIGIBLE');
  assert.equal(resolution.reason, 'asset_not_eligible');
});

// ── ERROR ────────────────────────────────────────────────────────────────────

test('resolveLiveGarment: a structurally malformed registry entry (unallowlisted assetKey) fails closed as ERROR', () => {
  const corruptRegistry = [{ ...ASSET_A, productRef: 'corrupt-product', assetKey: '../../etc/passwd' }];
  const resolution = resolveLiveGarment({
    garment: garment({ productRef: 'corrupt-product' }),
    registry: corruptRegistry,
  });
  assert.equal(resolution.status, 'ERROR');
  assert.equal(resolution.reason, 'resolution_error');
});

test('resolveLiveGarment: an unsupported ksgarment schema version fails closed as ERROR', () => {
  const corruptRegistry = [{ ...ASSET_A, productRef: 'old-schema-product', ksgarmentSchemaVersion: '0.9' }];
  const resolution = resolveLiveGarment({
    garment: garment({ productRef: 'old-schema-product' }),
    registry: corruptRegistry,
  });
  assert.equal(resolution.status, 'ERROR');
});

test('resolveLiveGarment: a blank assetId fails closed as ERROR', () => {
  const corruptRegistry = [{ ...ASSET_A, productRef: 'blank-id-product', assetId: '' }];
  const resolution = resolveLiveGarment({
    garment: garment({ productRef: 'blank-id-product' }),
    registry: corruptRegistry,
  });
  assert.equal(resolution.status, 'ERROR');
});

// ── Cache hit / cache miss (registry lookup IS the cache -- no network) ──────

test('resolveLiveGarment: repeated resolution for the same productRef is idempotent (cache-hit-equivalent)', () => {
  const first = resolveLiveGarment({ garment: garment({ productRef: ASSET_A.productRef }) });
  const second = resolveLiveGarment({ garment: garment({ productRef: ASSET_A.productRef }) });
  assert.deepEqual(first, second);
});

test('resolveLiveGarment: an empty registry is a cache-miss-equivalent NOT_FOUND for every productRef', () => {
  const resolution = resolveLiveGarment({ garment: garment({ productRef: ASSET_A.productRef }), registry: [] });
  assert.equal(resolution.status, 'NOT_FOUND');
});

// ── Backward-compatible adapter (existing VirtualTryOnSheet.tsx call site) ──

test('evaluateLiveGarmentEligibility: still returns {eligible:true, descriptor} for a governed product, with the extended fields present', () => {
  const result = evaluateLiveGarmentEligibility({ garment: garment({ productRef: ASSET_A.productRef }) });
  assert.equal(result.eligible, true);
  assert.equal(result.descriptor.productRef, ASSET_A.productRef);
  assert.equal(result.descriptor.assetKey, 'n1b-fixture');
  assert.equal(result.descriptor.assetId, ASSET_A.assetId);
  assert.equal(result.descriptor.assetVersion, ASSET_A.assetVersion);
});

test('evaluateLiveGarmentEligibility: NOT_FOUND collapses to eligible:false with reason asset_not_found', () => {
  const result = evaluateLiveGarmentEligibility({ garment: garment({ productRef: 'unaddressed-product' }) });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'asset_not_found');
});

test('evaluateLiveGarmentEligibility: category-ineligible still reports unsupported_category (unchanged behavior)', () => {
  const result = evaluateLiveGarmentEligibility({ garment: garment({ category: 'dress' }) });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'unsupported_category');
});

test('isLiveGarmentEligible: true only for a real governed+category-eligible product', () => {
  assert.equal(isLiveGarmentEligible(garment({ productRef: ASSET_A.productRef })), true);
  assert.equal(isLiveGarmentEligible(garment({ productRef: 'not-governed' })), false);
  assert.equal(isLiveGarmentEligible(null), false);
});
