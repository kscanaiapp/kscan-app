// VTO V2 REQUIRED CUSTOMER JOURNEYS (A..L) and the LOCAL performance budget.
//
// The blocking controls (__tests__/vtoModeAuthorityBlocking.test.js) prove the
// invariants. This file walks the journeys themselves, end to end at the
// source level, so "a customer can get from a product to a try-on and back to
// the product" is a executed path rather than an inference from twelve
// separate assertions.
//
// PERFORMANCE IS MEASURED, NOT CLAIMED. Only LOCAL, synchronous code is timed.
// No provider latency and no device frame rate is reported anywhere here --
// neither has been observed, and a number nobody measured is worse than no
// number.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const code = (rel) =>
  read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

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
    URL, URLSearchParams, Math, Number, Set, Map, Object, Array, JSON, Date,
    RangeError, Error, TypeError, String, Boolean, RegExp, Promise,
    __DEV__: false,
    process: { env: {} },
    require: (specifier) => {
      if (Object.prototype.hasOwnProperty.call(requireMap, specifier)) return requireMap[specifier];
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
const nativeModuleStub = {
  LIVE_VTO_SUPPORTED_PLATFORMS: ['ios', 'android'],
  isLiveVtoNativeCapable: (c) =>
    !!c && c.present === true && c.capable === true && c.runtimeReady === true,
};
const liveCapability = loadTsModule('services/vto/vtoLiveCapability.ts', {
  './liveVtoNativeModule': nativeModuleStub,
});
const authority = loadTsModule('services/vto/vtoModeAuthority.ts', {
  './vtoEligibility': eligibility,
  './vtoLiveGarment': liveGarment,
  './vtoLiveGarmentRegistry': registry,
  './vtoLiveCapability': liveCapability,
  './liveVtoNativeModule': nativeModuleStub,
});
const entryContract = loadTsModule('services/vto/vtoEntryContract.ts', {
  '../../types/vto': {},
  './vtoModeAuthority': authority,
});
const capabilityCache = loadTsModule('services/vto/vtoCapabilityCache.ts', {
  './liveVtoNativeModule': {
    describeLiveVtoNativeCapability: () => CAPABLE_NATIVE,
    resetLiveVtoNativeModuleCache: () => {},
  },
});
const vtoLiveTypes = loadTsModule('types/vtoLive.ts');

const { resolveVtoMode, shouldRenderTryOnAction } = authority;
const { sessionRefForDecision } = entryContract;

const CAPABLE_NATIVE = {
  present: true, capable: true, runtimeReady: true,
  runtimeVersion: 'test', provenance: 'native', reason: null,
};
const GOVERNED = registry.LIVE_VTO_GOVERNED_ASSETS[0];
const GOVERNED_B = registry.LIVE_VTO_GOVERNED_ASSETS[1];

const garment = (overrides = {}) => ({
  productRef: 'prod-dress-0004',
  imageUrl: 'https://cdn.example.com/garments/dress.jpg',
  category: 'Midi Dress',
  brand: null,
  commerceSource: 'Example Retailer',
  ...overrides,
});
const liveProduct = (asset = GOVERNED) =>
  garment({ productRef: asset.productRef, category: 'top' });

const capabilities = (overrides = {}) => ({
  photoFeatureEnabled: true,
  photoRemoteEnabled: true,
  liveFeatureEnabled: true,
  liveRemoteEnabled: true,
  nativeCapability: CAPABLE_NATIVE,
  cameraPermission: 'granted',
  platformOS: 'ios',
  ...overrides,
});
const actor = (overrides = {}) => ({
  authenticated: true,
  accountActive: true,
  hasEntitlement: true,
  entitlementResolved: true,
  quota: 'unknown',
  ...overrides,
});

// ── JOURNEY A — product -> Live ─────────────────────────────────────────────

test('JOURNEY A: an eligible governed garment reaches the Live runtime', () => {
  const product = liveProduct();
  const decision = resolveVtoMode(product, capabilities(), actor());

  assert.equal(decision.mode, 'LIVE_LOCAL');
  assert.equal(shouldRenderTryOnAction(decision), true);
  assert.equal(decision.liveAssetKey, GOVERNED.assetKey);
  assert.equal(decision.productRef, product.productRef);

  const start = sessionRefForDecision(product, decision, 'commerce_product');
  assert.equal(start.started, true);
  assert.equal(start.session.mode, 'LIVE_LOCAL');

  // The sheet opens on Live when the capability says so, and the Live panel is
  // the surface it opens.
  const sheet = code('components/vto/VirtualTryOnSheet.tsx');
  assert.match(sheet, /capability \? defaultVtoMode\(capability\) : 'ai_photo'/);
  assert.match(sheet, /<VtoLivePanel/);
});

// ── JOURNEY B — product -> Photo, explicit capture, no paid call ────────────

test('JOURNEY B: a verified garment reaches an explicit capture and a handoff-ready state', () => {
  const product = garment();
  const decision = resolveVtoMode(product, capabilities(), actor());
  assert.equal(decision.mode, 'PHOTOREAL_STILL');
  assert.equal(decision.garmentImageRef, product.imageUrl);

  const start = sessionRefForDecision(product, decision, 'commerce_product');
  assert.equal(start.session.mode, 'PHOTOREAL_STILL');

  // The handoff refuses anything that is not an explicitly captured clean
  // person frame, and refuses it by declared kind.
  assert.throws(
    () => vtoLiveTypes.assertCleanPersonFrame({ kind: 'PREVIEW', localUri: 'file:///x.jpg' }),
    RangeError,
  );
  // Nothing in this lane executes a provider call. The one billable path is
  // the existing store -> client -> Edge Function chain, untouched.
  const handoff = code('services/vto/vtoPhotorealHandoff.ts');
  assert.ok(!handoff.includes('fetch('), 'the handoff carries no network client');
  assert.match(handoff, /harnessActive\(\)/, 'a simulated session may not spend a generation');
});

// ── JOURNEY C / D / E — result -> Shop / Save / Watch ───────────────────────

test('JOURNEY C: the result Shop action opens the same verified product destination', () => {
  const sheet = code('components/vto/VirtualTryOnSheet.tsx');
  const block = sheet.match(/title="Shop this piece"[\s\S]{0,320}/)[0];
  assert.ok(block.includes('onShop?.()'));
  assert.ok(block.includes('disabled={!onShop}'), 'no destination, no Buy action');
  // The entry passes Commerce's own callback straight through, unmodified.
  assert.match(code('components/vto/TryItOnEntry.tsx'), /onShop=\{onShop\}/);
  // And each product surface supplies THAT row's destination.
  assert.match(
    code('components/scan-results/PurchaseOptionsPanel.tsx'),
    /onShop=\{destination \? openOffer : undefined\}/,
  );
});

test('JOURNEY D: the result Save action reuses the existing Dressing Room path', () => {
  const sheet = code('components/vto/VirtualTryOnSheet.tsx');
  assert.match(sheet, /<VtoSaveToDressingRoom/);
  // The product identity travels with the saved result.
  assert.match(sheet, /productRef=\{garment\.productRef\}/);
  // Ownership is unchanged: the save goes to a Dressing Room, never the Closet.
  const save = code('components/vto/VtoSaveToDressingRoom.tsx');
  assert.match(save, /AddScanToDressingRoomModal/);
  for (const forbidden of ['ownedClosetItems', 'closetLibrary', 'addToCloset']) {
    assert.ok(!save.includes(forbidden), `a try-on result is not an owned item (${forbidden})`);
  }
});

test('JOURNEY E: the result Watch action appears only where Watchlist is available', () => {
  const sheet = code('components/vto/VirtualTryOnSheet.tsx');
  assert.match(sheet, /\{onWatch \?/, 'no callback, no Watch action');
  const panel = code('components/scan-results/PurchaseOptionsPanel.tsx');
  // The SAME server-authored predicate that gates the row's own Watch button.
  assert.match(panel, /const canWatch = canWatchPurchaseOption\(option\);/);
  assert.match(panel, /onWatch=\{\s*canWatch\s*\?/);
  assert.match(
    code('components/scan-results/types.ts'),
    /candidate\.watchCapability !== 'refreshable_listing'/,
    'watch eligibility is server-authored and only read',
  );
});

// ── JOURNEY F / G / H / I — honest refusals ────────────────────────────────

test('JOURNEY F: an unsupported item produces no Try On action at all', () => {
  for (const category of ['Leather Sneakers', 'Leather Tote', 'Sunglasses', 'Straight Leg Jeans']) {
    const decision = resolveVtoMode(garment({ category }), capabilities(), actor());
    assert.equal(decision.mode, 'UNAVAILABLE', category);
    assert.equal(shouldRenderTryOnAction(decision), false, category);
  }
});

test('JOURNEY G: an unentitled actor reaches the existing K+ flow and nothing else', () => {
  const decision = resolveVtoMode(garment(), capabilities(), actor({ hasEntitlement: false }));
  assert.equal(decision.reasonCode, 'ENTITLEMENT_REQUIRED');
  assert.equal(decision.upgradeOpportunity, true);
  // The entry renders the shared K+ surface, and no sheet, no camera and no
  // provider work can start from it.
  const entry = code('components/vto/TryItOnEntry.tsx');
  const upgradeBranch = entry.slice(
    entry.indexOf("if (mode === 'UNAVAILABLE') {"),
    entry.indexOf('const copy = MODE_COPY[mode];'),
  );
  assert.match(upgradeBranch, /<KPlusGate source="vto">/);
  assert.ok(!upgradeBranch.includes('VirtualTryOnSheet'), 'no sheet from the upgrade branch');
  assert.ok(!upgradeBranch.includes('openSheet'), 'no session from the upgrade branch');
  // No price, tier or purchase claim is invented here. The K+ conversation
  // belongs to the shared surface, which is the one place a price could ever
  // legitimately appear. (A bare `$` is not checked: a template literal
  // carries one.)
  assert.doesNotMatch(upgradeBranch, /\$\s?\d/, 'must not invent a price');
  for (const forbidden of ['price', 'subscribe', 'per month', 'per year', 'trial', 'usd']) {
    assert.ok(!upgradeBranch.toLowerCase().includes(forbidden), `must not invent ${forbidden}`);
  }
});

test('JOURNEY H: an exhausted quota is stated, and no provider work is started', () => {
  const decision = resolveVtoMode(garment(), capabilities(), actor({ quota: 'exhausted' }));
  assert.equal(decision.mode, 'UNAVAILABLE');
  assert.equal(decision.reasonCode, 'QUOTA_EXHAUSTED');
  assert.equal(shouldRenderTryOnAction(decision), false);
  const start = sessionRefForDecision(garment(), decision, 'commerce_product');
  assert.equal(start.started, false);
});

test('JOURNEY I: an unsafe garment image makes Photo unavailable', () => {
  const decision = resolveVtoMode(
    garment({ imageUrl: 'http://cdn.example.com/g.jpg' }),
    capabilities(),
    actor(),
  );
  assert.equal(decision.mode, 'UNAVAILABLE');
  assert.equal(decision.reasonCode, 'NO_SAFE_GARMENT_IMAGE');
});

// ── JOURNEY J / K — product and mode switching ─────────────────────────────

test('JOURNEY J + K: switching product or mode carries no stale state', () => {
  const productA = liveProduct(GOVERNED);
  const productB = garment();
  const productC = liveProduct(GOVERNED_B);

  const decisionA = resolveVtoMode(productA, capabilities(), actor());
  const decisionB = resolveVtoMode(productB, capabilities(), actor());
  const decisionC = resolveVtoMode(productC, capabilities(), actor());

  // Live -> Photo, Photo -> Live, Live -> Live: each decision names its OWN
  // product and its OWN asset. Nothing from the previous one survives.
  assert.equal(decisionA.mode, 'LIVE_LOCAL');
  assert.equal(decisionA.liveAssetKey, GOVERNED.assetKey);
  assert.equal(decisionB.mode, 'PHOTOREAL_STILL');
  assert.equal(decisionB.liveAssetKey, undefined, 'a Photo decision carries no asset key');
  assert.equal(decisionC.mode, 'LIVE_LOCAL');
  assert.equal(decisionC.liveAssetKey, GOVERNED_B.assetKey);
  assert.notEqual(decisionA.liveAssetKey, decisionC.liveAssetKey);

  // And a decision may not be used to start a different product, in EITHER
  // direction -- which is what makes "A's completion overwrites B" structurally
  // unreachable at the entry rather than merely superseded later.
  for (const [product, decision] of [
    [productB, decisionA], [productA, decisionB],
    [productC, decisionA], [productA, decisionC],
  ]) {
    const outcome = sessionRefForDecision(product, decision, 'commerce_product');
    assert.equal(outcome.started, false);
    assert.equal(outcome.reason, 'product_reference_invalid');
  }

  // The live runtime's own teardown-on-withdrawal rule is unchanged.
  assert.match(
    code('components/vto/VirtualTryOnSheet.tsx'),
    /if \(liveSurfaceWithdrawn && liveEntered\) live\.exitLive\(\);/,
  );
});

// ── JOURNEY L — provider error keeps VTO usable ────────────────────────────

test('JOURNEY L: a provider error is honest and leaves the session usable', () => {
  const handoff = loadTsModule('services/vto/vtoPhotorealHandoff.ts', {
    '../privacyImageUpload': {},
    './vtoLiveHarness': { isLiveVtoHarnessActive: () => false },
    './vtoPersonInput': { VTO_PERSON_JPEG_QUALITY: 0.8, VTO_PERSON_MAX_DIMENSION: 1024 },
    '../../types/vtoLive': vtoLiveTypes,
    '../../types/vto': {},
  });
  for (const providerCode of ['provider_unavailable', 'provider_timeout', 'rate_limited']) {
    const outcome = handoff.photorealOutcomeForGenerativeFailure(providerCode);
    assert.equal(outcome.liveSessionRemainsUsable, true, providerCode);
  }
  // A provider failure and an unsupported product are different sentences.
  const failures = loadTsModule('services/vto/vtoFailures.ts', {
    '../../types/vto': loadTsModule('types/vto.ts'),
  });
  assert.doesNotMatch(
    failures.toVtoFailure('provider_unavailable').message,
    /isn't available for this item/i,
  );
});

// ── LOCAL PERFORMANCE (mission section 46) ─────────────────────────────────

test('performance: local mode resolution stays cheap enough to render a shelf', () => {
  const corpus = JSON.parse(read('__tests__/vtoCoverageCorpus.json')).records;
  const commerceDestination = loadTsModule('services/commerceDestination.ts');
  const dressingRoomCommerce = loadTsModule('services/dressingRoomCommerce.ts', {
    '../types/canonicalDressingRoomItem': {},
  });
  const commerceGarment = loadTsModule('services/vto/vtoCommerceGarment.ts', {
    '../commerceDestination': commerceDestination,
    '../dressingRoomCommerce': dressingRoomCommerce,
    '../../types/vto': {},
  });
  const garments = corpus.map((entry) =>
    commerceGarment.buildVtoGarmentFromCommerceRecord(entry.record));

  const ITERATIONS = 200;
  const measure = (fn) => {
    fn(); // warm
    const started = process.hrtime.bigint();
    for (let i = 0; i < ITERATIONS; i += 1) fn();
    return Number(process.hrtime.bigint() - started) / 1e6 / ITERATIONS;
  };

  const modeResolutionMs = measure(() => {
    for (const g of garments) resolveVtoMode(g, capabilities(), actor());
  }) / garments.length;

  const assetLookupMs = measure(() => {
    for (const g of garments) liveGarment.resolveLiveGarment({ garment: g });
  }) / garments.length;

  const capabilityCacheLookupMs = measure(() => capabilityCache.getLiveVtoCapability());

  const handoffPreflightMs = measure(() => {
    try {
      vtoLiveTypes.assertCleanPersonFrame({ kind: 'PERSON_FRAME', localUri: 'file:///x.jpg' });
    } catch { /* not reachable for a PERSON_FRAME */ }
  });

  // eslint-disable-next-line no-console
  console.log(
    '[vto-perf] fixtures=%d MODE_RESOLUTION_MS=%s ASSET_LOOKUP_MS=%s '
      + 'CAPABILITY_CACHE_LOOKUP_MS=%s HANDOFF_PREFLIGHT_MS=%s',
    garments.length,
    modeResolutionMs.toFixed(4),
    assetLookupMs.toFixed(4),
    capabilityCacheLookupMs.toFixed(4),
    handoffPreflightMs.toFixed(4),
  );

  // Generous ceilings on purpose. They exist to catch a future change that
  // makes the render-path decision expensive (an I/O call, a regex explosion,
  // a registry scan per card), not to pin a benchmark on CI hardware.
  assert.ok(modeResolutionMs < 1, `mode resolution per product: ${modeResolutionMs}ms`);
  assert.ok(assetLookupMs < 1, `asset lookup per product: ${assetLookupMs}ms`);
  assert.ok(capabilityCacheLookupMs < 1, `capability cache lookup: ${capabilityCacheLookupMs}ms`);
});

test('performance: the render-path decision performs no I/O at all', () => {
  // The cheapest possible proof that the number above stays a local one: the
  // decision path cannot reach a network, a filesystem, or an image decoder.
  for (const file of [
    'services/vto/vtoModeAuthority.ts',
    'services/vto/vtoLiveGarment.ts',
    'services/vto/vtoLiveGarmentRegistry.ts',
    'services/vto/vtoEligibility.ts',
    'services/vto/vtoCapabilityCache.ts',
  ]) {
    const source = code(file);
    for (const forbidden of ['fetch(', 'FileSystem', 'AsyncStorage', 'Image.getSize', 'await ', 'async ']) {
      assert.ok(
        !source.includes(forbidden),
        `${file} must stay synchronous and I/O free (${forbidden})`,
      );
    }
  }
});

test('performance: the native self-check is asked once, not once per product card', () => {
  let calls = 0;
  const cache = loadTsModule('services/vto/vtoCapabilityCache.ts', {
    './liveVtoNativeModule': {
      describeLiveVtoNativeCapability: () => { calls += 1; return CAPABLE_NATIVE; },
      resetLiveVtoNativeModuleCache: () => {},
    },
  });
  const describe = () => { calls += 1; return CAPABLE_NATIVE; };
  const now = 1_000_000;
  for (let i = 0; i < 10; i += 1) cache.getLiveVtoCapability({ nowMs: now, describe });
  assert.equal(calls, 1, 'ten product cards must cost one native self-check');

  // The memo expires, so a runtime that finishes initializing later is not
  // locked out until relaunch.
  cache.getLiveVtoCapability({ nowMs: now + cache.LIVE_CAPABILITY_POSITIVE_TTL_MS + 1, describe });
  assert.equal(calls, 2);

  // And it is memory only: no persistent device fingerprint exists to leak.
  const source = code('services/vto/vtoCapabilityCache.ts');
  for (const forbidden of ['AsyncStorage', 'SecureStore', 'FileSystem', 'localStorage']) {
    assert.ok(!source.includes(forbidden), `the cache must not persist (${forbidden})`);
  }
});
