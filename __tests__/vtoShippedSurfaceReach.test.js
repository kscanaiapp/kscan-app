// VTO-REACH-001 (P2) — Try It On must be REACHABLE on the shipped scan surface.
//
// WHY THIS FILE EXISTS. Virtual Try-On shipped complete and unreachable. Its
// only entry point, TryItOnEntry, was rendered by exactly one component --
// components/ProductShelf.tsx -- and `eas.json` sets
// EXPO_PUBLIC_SCAN_RESULTS_V2_UI=true in EVERY governed profile, so what a
// person actually sees after a scan is ScanResultV2, which renders
// PurchaseOptionsPanel and MultiItemCommerceSection. components/scan-results/
// contained ZERO references to VTO. Turning EXPO_PUBLIC_VTO_UI_ENABLED on would
// therefore have surfaced Try It On only on a reopened Recent Scan, never on the
// commerce results of a live scan.
//
// The pre-existing suite was green over all of it: vtoPrivacyAndWiring's "the
// Commerce seam is additive" asserts `<TryItOnEntry` appears in ProductShelf.tsx
// and never that anything reachable renders ProductShelf. That is the same
// false-green shape DEF-WL-07 hit for Watch, which is why this file is modelled
// on __tests__/watchlistShippedSurfaceReach.test.js.
//
// So this file tests REACH and IDENTITY, not styling: one executable half (the
// pure mapper that carries the garment) plus source-level guards on the wiring,
// because the repo has no react-test-renderer and the wiring is exactly what
// regressed.
//
// `.test.js`, not `.test.ts`: scripts/run-all-tests.js discovers on that literal
// suffix, so a `.test.ts` file would never run in certification.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

function loadTsModule(relativePath, requireMap = {}) {
  const filename = path.join(ROOT, relativePath);
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const mod = { exports: {} };
  const sandbox = {
    __DEV__: false,
    console,
    Date,
    Intl,
    URL,
    URLSearchParams,
    exports: mod.exports,
    module: mod,
    require: (specifier) => {
      if (specifier in requireMap) return requireMap[specifier];
      throw new Error(`Unexpected import in ${relativePath}: ${specifier}`);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename }).runInContext(sandbox);
  return mod.exports;
}

const dressingRoomCommerce = loadTsModule('services/dressingRoomCommerce.ts', {});
const commerceDestination = loadTsModule('services/commerceDestination.ts', {});
const vtoCommerceGarment = loadTsModule('services/vto/vtoCommerceGarment.ts', {
  '../commerceDestination': commerceDestination,
  '../dressingRoomCommerce': dressingRoomCommerce,
  '../../types/vto': {},
});

// ── The live surface is DERIVED from governed config, never assumed ──────────

/** True only when every governed profile ships the V2 result UI. */
function scanResultsV2LiveEverywhere() {
  const { resolveEasBuildProfiles } = require('../scripts/resolve-eas-build-profiles');
  const profiles = Object.values(resolveEasBuildProfiles(JSON.parse(read('eas.json'))));
  assert.ok(profiles.length > 0, 'eas.json must define at least one build profile');
  return profiles.every((p) => p.env?.EXPO_PUBLIC_SCAN_RESULTS_V2_UI === 'true');
}

/** The components the app actually renders for a completed scan's commerce. */
function liveCommerceSurfaceFiles() {
  return scanResultsV2LiveEverywhere()
    ? ['components/scan-results/PurchaseOptionsPanel.tsx']
    : ['components/ProductShelf.tsx'];
}

test('every governed build profile still ships the V2 result UI', () => {
  // Pins the assumption the reach assertions below depend on. If this ever goes
  // false, liveCommerceSurfaceFiles() correctly retargets ProductShelf instead
  // of silently validating a component nobody sees.
  assert.equal(scanResultsV2LiveEverywhere(), true);
});

test('VTO-REACH-001: the LIVE commerce surface renders the try-on entry point', () => {
  for (const file of liveCommerceSurfaceFiles()) {
    const source = stripComments(read(file));
    assert.match(
      source,
      /<TryItOnEntry/,
      `${file} is the shipped commerce surface and must render the VTO entry point`,
    );
  }
});

test('NEGATIVE CONTROL: the live scan screen reaches the panel that carries it', () => {
  // ScanResultV2 -> PurchaseOptionsPanel directly (single item) and via
  // MultiItemCommerceSection (per-item cards). If either link is cut, Try It On
  // stops being reachable even though the entry point still exists.
  const v2 = stripComments(read('components/scan-results/ScanResultV2.tsx'));
  assert.match(v2, /<PurchaseOptionsPanel/, 'ScanResultV2 must render PurchaseOptionsPanel');
  assert.match(v2, /<MultiItemCommerceSection/, 'ScanResultV2 must render MultiItemCommerceSection');
  const multi = stripComments(read('components/scan-results/MultiItemCommerceSection.tsx'));
  assert.match(multi, /<PurchaseOptionsPanel/, 'per-item cards must route through the same panel');
});

test('the app renders ScanResultV2 for a completed live scan', () => {
  const app = read('app.js').replace(/\s+/g, ' ');
  assert.match(
    app,
    /<ScanResultV2\b[\s\S]*?analysis=\{analysis\}/,
    'app.js must render an analysis-carrying ScanResultV2 -- the surface under test',
  );
});

// ── Identity: Product A's try-on can only be Product A's ────────────────────

const RECORD_A = {
  id: 'prod-A',
  title: 'Navy Wool Blazer',
  category: 'blazer',
  brand: 'Brand A',
  retailer: 'Retailer A',
  imageUrl: 'https://images.example.com/a.jpg',
  productUrl: 'https://retailer-a.example.com/navy-blazer',
  watchCapability: 'refreshable_listing',
};
const RECORD_B = {
  id: 'prod-B',
  title: 'Camel Trench Coat',
  category: 'outerwear',
  brand: 'Brand B',
  retailer: 'Retailer B',
  imageUrl: 'https://images.example.com/b.jpg',
  productUrl: 'https://retailer-b.example.com/camel-trench',
  watchCapability: 'refreshable_listing',
};

function loadScanResultTypes() {
  return loadTsModule('components/scan-results/types.ts', {
    '../../services/scanTitleBuilder': { buildScanTitle: () => 'Scan' },
    '../../constants/build': { SCAN_IDENTITY_DEBUG: false },
    '../../constants/featureFlags': { SCAN_RESULTS_DEMO_UI_ENABLED: false },
    '../../services/outfitConfirmation/outfitDetectionBridge': {},
    '../../services/vto/vtoCommerceGarment': vtoCommerceGarment,
    '../../types/vto': {},
  });
}

test('VTO-REACH-001: each rendered row carries the garment for ITS OWN product', () => {
  const types = loadScanResultTypes();
  const a = types.mapRawProductToPurchaseOption(RECORD_A, 0);
  const b = types.mapRawProductToPurchaseOption(RECORD_B, 1);

  assert.ok(a.vtoGarment, 'a watchable/renderable commerce row must carry a try-on garment');
  assert.ok(b.vtoGarment, 'a watchable/renderable commerce row must carry a try-on garment');

  // The whole point: no shared, hoisted, or last-write-wins garment.
  assert.equal(a.vtoGarment.productRef, 'prod-A');
  assert.equal(b.vtoGarment.productRef, 'prod-B');
  assert.notEqual(a.vtoGarment.productRef, b.vtoGarment.productRef);
  assert.equal(a.vtoGarment.imageUrl, RECORD_A.imageUrl);
  assert.equal(b.vtoGarment.imageUrl, RECORD_B.imageUrl);
  assert.equal(a.vtoGarment.category, 'blazer');
  assert.equal(b.vtoGarment.category, 'outerwear');
});

test('the panel anchors the entry point to the ROW it is rendering, not the shelf', () => {
  const panel = stripComments(read('components/scan-results/PurchaseOptionsPanel.tsx'));
  // `option.vtoGarment` -- the row's own identity. Anything hoisted out of the
  // map callback would be a shelf-level garment and could attach A's try-on to
  // B's row.
  assert.match(panel, /garment=\{option\.vtoGarment\}/, 'the garment must come from the row');
  assert.match(
    panel,
    /testID=\{`purchase-option-try-it-on-\$\{option\.id\}`\}/,
    'the entry point must be identified per row',
  );
});

test('a record with no stable product reference offers no try-on at all', () => {
  const types = loadScanResultTypes();
  const anonymous = types.mapRawProductToPurchaseOption({ retailer: 'Retailer' }, 0);
  // A try-on anchored to nothing is worse than no try-on: the panel renders
  // none, rather than one that cannot identify what it is visualizing.
  assert.equal(anonymous.vtoGarment, null);
});

// ── Availability: the entry point stays gated ───────────────────────────────

test('the feature flag gate is absolute on the live surface', () => {
  const panel = stripComments(read('components/scan-results/PurchaseOptionsPanel.tsx'));
  assert.match(
    panel,
    /VTO_UI_ENABLED && option\.vtoGarment \?/,
    'the flag must gate the entry point, so a disabled build renders nothing',
  );
  // Build 34 Android staging-certification (P2-EAS-FLAGS ruling): server-side
  // authority, quota, and fail-closed provider behavior (SEC-KPLUS-007) are
  // proven closed, so staging-certification enables the flag. Every OTHER
  // governed profile stays unset: reachability is not rollout.
  const build = JSON.parse(read('eas.json')).build;
  for (const [name, profile] of Object.entries(build)) {
    if (name === 'staging-certification') {
      assert.equal(
        profile.env?.EXPO_PUBLIC_VTO_UI_ENABLED,
        'true',
        'staging-certification must carry the proven-closed VTO ruling',
      );
      continue;
    }
    assert.equal(
      profile.env?.EXPO_PUBLIC_VTO_UI_ENABLED,
      undefined,
      'this repair makes VTO reachable when enabled; it must not enable it outside staging-certification',
    );
  }
});

test('eligibility and the K+ conversation stay with TryItOnEntry, not this panel', () => {
  const panel = stripComments(read('components/scan-results/PurchaseOptionsPanel.tsx'));
  // The panel must not re-derive who may try something on, or grow a second
  // paywall. TryItOnEntry already renders nothing unless the item is eligible,
  // and opens the one shared K+ surface when entitlement is the only gap.
  assert.doesNotMatch(panel, /useVtoAvailability/, 'eligibility belongs to TryItOnEntry');
  assert.doesNotMatch(panel, /VirtualTryOnSheet/, 'the sheet belongs to TryItOnEntry');
  assert.doesNotMatch(
    panel,
    /KPlusGate source="vto/,
    'VTO must reuse TryItOnEntry\'s shared K+ surface, not add a second one here',
  );
});

// ── One derivation, not two ─────────────────────────────────────────────────

test('VTO-REACH-001: both commerce surfaces share ONE garment derivation', () => {
  const shelf = stripComments(read('components/ProductShelf.tsx'));
  const types = stripComments(read('components/scan-results/types.ts'));
  for (const [file, source] of [['ProductShelf.tsx', shelf], ['scan-results/types.ts', types]]) {
    assert.match(
      source,
      /buildVtoGarmentFromCommerceRecord/,
      `${file} must delegate to the shared derivation`,
    );
  }
  // Two independent derivations are how Product A's try-on becomes Product B's.
  assert.doesNotMatch(
    types,
    /productRef:\s*\(typeof/,
    'scan-results/types.ts must not grow its own copy of the garment derivation',
  );
});

test('the extracted derivation preserves ProductShelf\'s field precedence', () => {
  const { buildVtoGarmentFromCommerceRecord } = vtoCommerceGarment;
  // id wins as productRef when present...
  assert.equal(buildVtoGarmentFromCommerceRecord(RECORD_A).productRef, 'prod-A');
  // ...and the purchase URL is the fallback when it is not.
  const noId = { ...RECORD_A, id: undefined };
  assert.equal(buildVtoGarmentFromCommerceRecord(noId).productRef, RECORD_A.productUrl);
  // ...and the image is the last resort.
  const noIdNoUrl = { ...RECORD_A, id: undefined, productUrl: undefined };
  assert.equal(buildVtoGarmentFromCommerceRecord(noIdNoUrl).productRef, RECORD_A.imageUrl);
  // Nothing identifying at all -> no garment.
  assert.equal(buildVtoGarmentFromCommerceRecord({ retailer: 'R' }), null);
  assert.equal(buildVtoGarmentFromCommerceRecord(null), null);
});

test('the try-on identity is EPHEMERAL: it is never persisted with a scan', () => {
  // Same posture as watchCandidate (DEF-WL-07): the persisted-snapshot
  // normalizer is a strict allowlist and must not learn about vtoGarment.
  const canonical = stripComments(read('services/dressingRoomCommerce.ts'));
  assert.doesNotMatch(
    canonical,
    /vtoGarment/,
    'the persisted commerce normalizer must not carry a try-on garment',
  );
  const options = dressingRoomCommerce.normalizePurchaseOptions([
    { ...RECORD_A, vtoGarment: { productRef: 'prod-A', imageUrl: 'x', category: 'blazer' } },
  ]);
  assert.ok(options.length > 0, 'the fixture must survive normalization for this to be meaningful');
  assert.equal(
    Object.prototype.hasOwnProperty.call(options[0], 'vtoGarment'),
    false,
    'a persisted purchase option must not carry try-on state',
  );
});
