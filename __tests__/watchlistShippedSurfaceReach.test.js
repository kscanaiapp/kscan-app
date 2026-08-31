// DEF-WL-07 (P1) — the Watch affordance must be REACHABLE on the shipped
// commerce surface.
//
// WHY THIS FILE EXISTS. The original build shipped a complete Watchlist whose
// entry point no reachable screen rendered: `eas.json` sets
// EXPO_PUBLIC_SCAN_RESULTS_V2_UI=true in every profile, so ScanResultV2 renders
// PurchaseOptionsPanel / MultiItemCommerceSection — and `components/scan-results/`
// contained ZERO references to ProductShelf or watchCapability. The only two
// surfaces that did render ProductShelf were fed through
// `normalizePurchaseOptions`, a strict allowlist that strips watchCapability.
// Every test passed: they asserted the server-side producer and the button in
// isolation and never the path between them.
//
// So this file deliberately tests REACH, not components. Two executable halves
// (the pure mapper/predicate, and the persistence invariant) plus source-level
// guards on the wiring — the repo has no react-test-renderer, and the wiring is
// exactly what regressed.
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
    // dressingRoomCommerce's URL normalizer uses these; without them its own
    // try/catch swallows a ReferenceError and every URL silently becomes null,
    // which would make the persistence assertions below quietly meaningless.
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

const scanResultTypes = loadTsModule('components/scan-results/types.ts', {
  '../../services/scanTitleBuilder': { buildScanTitle: () => 'Title' },
  '../../constants/build': { SCAN_IDENTITY_DEBUG: false },
  '../../constants/featureFlags': { SCAN_RESULTS_DEMO_UI_ENABLED: false },
  '../../services/outfitConfirmation/outfitDetectionBridge': {},
});
const { mapRawProductToPurchaseOption, canWatchPurchaseOption } = scanResultTypes;

const ELIGIBLE = {
  id: 'p1',
  title: 'Suede Loafer',
  retailer: 'Mr Porter',
  price: 420,
  currency: 'USD',
  productUrl: 'https://www.mrporter.com/en-us/mens/product/loafer/12345',
  imageUrl: 'https://images.example.com/loafer.jpg',
  type: 'retail',
  commerceType: 'retail',
  watchCapability: 'refreshable_listing',
};

// ─────────────────────────────── executable: the mapper carries capability ──

test('DEF-WL-07: the shipped mapper carries watch capability through to the render row', () => {
  const option = mapRawProductToPurchaseOption(ELIGIBLE, 0);
  assert.ok(option.watchCandidate, 'an eligible candidate must reach the render row');
  assert.equal(option.watchCandidate.watchCapability, 'refreshable_listing');
});

test('DEF-WL-07 NEGATIVE CONTROL: an eligible product exposes Watch', () => {
  assert.equal(canWatchPurchaseOption(mapRawProductToPurchaseOption(ELIGIBLE, 0)), true);
});

test('DEF-WL-07 NEGATIVE CONTROL: a product NOT eligible for Watch must not show the action', () => {
  for (const capability of ['unsupported', undefined, null, '', 'REFRESHABLE_LISTING', 'refreshable']) {
    const raw = { ...ELIGIBLE, watchCapability: capability };
    const option = mapRawProductToPurchaseOption(raw, 0);
    assert.equal(
      canWatchPurchaseOption(option),
      false,
      `watchCapability=${JSON.stringify(capability)} must not offer Watch`,
    );
  }
});

test('DEF-WL-07: an eligible listing with no canonical product URL offers nothing', () => {
  // A watch with no URL identity is not a watch on anything, so the row must
  // refuse it rather than create an unidentifiable watch.
  for (const url of [undefined, '', '   ', 'not-a-url']) {
    const option = mapRawProductToPurchaseOption({ ...ELIGIBLE, productUrl: url }, 0);
    assert.equal(canWatchPurchaseOption(option), false, `productUrl=${JSON.stringify(url)}`);
  }
});

test('DEF-WL-07: the watch identity is the CANONICAL retailer/product URL of the row', () => {
  const option = mapRawProductToPurchaseOption(ELIGIBLE, 0);
  assert.equal(option.watchCandidate.productUrl, ELIGIBLE.productUrl);
  assert.equal(option.watchCandidate.retailer, 'Mr Porter');
  // The row the user sees and the watch that results describe the same listing.
  assert.equal(option.productUrl, option.watchCandidate.productUrl);
});

test('DEF-WL-07: nothing about the candidate is invented', () => {
  const sparse = { id: 'p2', watchCapability: 'refreshable_listing' };
  const option = mapRawProductToPurchaseOption(sparse, 0);
  assert.equal(option.watchCandidate.productUrl, undefined);
  assert.equal(option.watchCandidate.imageUrl, undefined);
  assert.equal(option.watchCandidate.currency, undefined);
  assert.equal(canWatchPurchaseOption(option), false);
});

// ───────────────── executable: Base Commerce persistence must be unchanged ──

test('DEF-WL-07 INVARIANT: the persisted normalizer still strips watchCapability', () => {
  // The single most important assertion in this file. `saveScan` writes
  // normalizePurchaseOptions() output into saved_scans.purchase_options. If the
  // watch field ever leaked into THAT type, a reopened Recent Scan could offer
  // Watch on a listing the server would now refuse — capability is a live
  // property of a listing, not a fact to freeze into a row.
  const commerce = loadTsModule('services/dressingRoomCommerce.ts', {});
  const persisted = commerce.normalizePurchaseOptions([ELIGIBLE]);
  assert.equal(persisted.length, 1, 'the option itself must still persist');
  assert.ok(
    !('watchCapability' in persisted[0]),
    'watchCapability must never enter the persisted Base Commerce shape',
  );
  assert.ok(
    !('watchCandidate' in persisted[0]),
    'the ephemeral render carrier must never enter the persisted shape',
  );
  // And the canonical identity it does persist is untouched.
  assert.equal(persisted[0].productUrl, ELIGIBLE.productUrl);
});

// ──────────────────────────────────── source-level: the wiring that regressed ──

const PANEL = 'components/scan-results/PurchaseOptionsPanel.tsx';
const MULTI = 'components/scan-results/MultiItemCommerceSection.tsx';

test('DEF-WL-07: the SHIPPED panel renders a Watch action', () => {
  const source = stripComments(read(PANEL));
  assert.match(source, /canWatchPurchaseOption\(option\)/, 'eligibility must be read per row');
  assert.match(source, /purchase-option-watch-/, 'the action needs a stable testID');
  assert.match(source, /WatchThisModal/, 'it must open the EXISTING creation flow');
});

test('DEF-WL-07: the Watch action is K+ gated on the shipped surface too', () => {
  const source = stripComments(read(PANEL));
  const block = source.slice(source.indexOf('canWatch ?'));
  assert.match(block, /KPlusGate/, 'Watch is a K+ capability on every surface');
  assert.match(block, /openUpgrade\(\)/, 'a non-K+ actor is offered the upgrade, not the action');
});

test('DEF-WL-07: the panel reuses ProductShelf\'s modal rather than a second creation path', () => {
  const source = stripComments(read(PANEL));
  assert.match(source, /import \{ WatchThisModal \} from '\.\.\/ProductShelf'/);
  assert.doesNotMatch(source, /createWatch/, 'this surface must not create watches itself');
});

test('DEF-WL-07: BOTH shipped commerce surfaces reach the action', () => {
  // Single-item: ScanResultV2 renders PurchaseOptionsPanel directly.
  const v2 = stripComments(read('components/scan-results/ScanResultV2.tsx'));
  assert.match(v2, /<PurchaseOptionsPanel/);
  assert.match(v2, /<MultiItemCommerceSection/);
  // Multi-item: MultiItemCommerceSection delegates to the SAME panel, so the
  // action reaches every per-item card without a second implementation.
  const multi = stripComments(read(MULTI));
  assert.match(multi, /<PurchaseOptionsPanel/);
  assert.match(multi, /mapRawProductToPurchaseOption/,
    'per-item cards must build rows through the shared mapper that carries capability');
});

test('DEF-WL-07: the legacy AnalysisCard path is NOT resurrected and ProductShelf is not the only route', () => {
  const panel = stripComments(read(PANEL));
  assert.doesNotMatch(panel, /AnalysisCard/, 'the legacy card must not be reintroduced');
  assert.doesNotMatch(panel, /<ProductShelf/, 'the shelf must not become the shipped route');
});

test('DEF-WL-07 NEGATIVE CONTROL: with the V2 flag off, the legacy path is untouched', () => {
  // The repair adds a capability to the V2 surface; it must not have altered
  // how the legacy shelf decides eligibility, nor the persisted normalizer the
  // legacy surfaces are fed through.
  const shelf = stripComments(read('components/ProductShelf.tsx'));
  assert.match(shelf, /watchCapability === 'refreshable_listing'/,
    'the legacy predicate is unchanged');
  const commerce = stripComments(read('services/dressingRoomCommerce.ts'));
  assert.doesNotMatch(commerce, /watchCapability/,
    'the persisted normalizer must remain free of any watch field');
});
