// v127 (P1-B) LIVE SURFACE — negative control + behavioral contract.
//
// THE DEFECT THIS PINS
//
// SCAN_RESULTS_V2_UI_ENABLED is 'true' in EVERY governed build profile on
// this line (eas.json), so ScanResultV2 is the ACTUAL live final-result
// surface — AnalysisCard is an unreachable fallback in every shipped build.
// The v127 pending/empty/error/retry commerce contract (commerceStatus,
// onRetryCommerce) was wired only into AnalysisCard. commerceShelfWiring.
// test.js and the pre-repair scanFunnelUtilitySurfaces.test.js both validated
// AnalysisCard and went green over a dead surface.
//
// This suite identifies the REAL live surface from the same governed
// configuration the app ships with, then asserts the v127 contract against
// THAT file. Before the repair this suite failed here: ScanResultV2.tsx had
// no commerceStatus/onRetryCommerce props and gated the whole panel on
// `purchaseOptions.length > 0`, so pending/empty/error/retry were unreachable
// no matter what the hook reported. (Verified by stashing the repair and
// re-running this file — see the repair-pass notes.)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

function easProfiles() {
  const { resolveEasBuildProfiles } = require('../scripts/resolve-eas-build-profiles');
  return resolveEasBuildProfiles(JSON.parse(read('eas.json')));
}

/** True only when every governed profile ships the V2 result UI. */
function scanResultsV2LiveEverywhere() {
  const profiles = Object.values(easProfiles());
  assert.ok(profiles.length > 0, 'eas.json must define at least one build profile');
  return profiles.every((p) => p.env?.EXPO_PUBLIC_SCAN_RESULTS_V2_UI === 'true');
}

const V2_FILE = 'components/scan-results/ScanResultV2.tsx';
const LEGACY_FILE = 'components/AnalysisCard.tsx';

/** The file the app actually renders for a completed scan, not an assumption. */
function liveResultSurfaceFile() {
  return scanResultsV2LiveEverywhere() ? V2_FILE : LEGACY_FILE;
}

/**
 * The analysis-carrying <ScanResultV2 .../> invocation in app.js — distinct
 * from the candidate-review invocation (Android only), which intentionally
 * carries zero commerce props. Identified by the active analysis projection, not by
 * position, so this stays correct if the file is reordered.
 */
function liveAnalysisCallSite(componentName) {
  const src = read('app.js').replace(/\s+/g, ' ');
  const blocks = [...src.matchAll(new RegExp(`<${componentName}\\b[\\s\\S]*?/>`, 'g'))].map((m) => m[0]);
  const live = blocks.find((b) => b.includes('analysis={displayAnalysis}'));
  assert.ok(live, `app.js must render an analysis-carrying <${componentName} .../>`);
  return live;
}

test('every governed build profile ships the V2 result UI on this line', () => {
  // Pins the assumption every other test in this file depends on. If this
  // ever goes false, liveResultSurfaceFile() correctly retargets AnalysisCard
  // instead of silently validating the wrong component.
  assert.equal(scanResultsV2LiveEverywhere(), true);
});

test('NEGATIVE CONTROL: live result displays the active batch ITEM commerce state and retry, not detection aggregate', () => {
  const file = liveResultSurfaceFile();
  const componentName = file === V2_FILE ? 'ScanResultV2' : 'AnalysisCard';
  const callSite = liveAnalysisCallSite(componentName);

  assert.match(callSite, /commerceStatus=\{batchResultVisible/,
    `${file}: live surface must branch for a selected batch item`);
  assert.match(callSite, /batchCommerceStatuses\[activeBatchItem\.id\]/,
    'each item must read ONLY its own commerce status');
  assert.match(callSite, /analysis\?\.commerceDeferred \? commerceStatus : 'idle'/,
    'ordinary single-image scans must preserve their hook status');
  assert.match(callSite, /onRetryCommerce=\{batchResultVisible/,
    'the retry must branch on selected batch mode');
  assert.match(callSite, /hydrateBatchCommerceForItem\(activeBatchItem, \{ isRetry: true \}\)/,
    'retry must target the exact selected item without re-running Gemini');
  assert.match(callSite, /: retryCommerce\}/,
    'single-image commerce must retain its existing retry callback');
});

test('active batch never inherits aggregate detection shelf or the wrong garment retry', () => {
  const callSite = liveAnalysisCallSite('ScanResultV2');
  assert.match(read('app.js'), /const displayAnalysis = batchResultVisible \? activeBatchItem\.analysis : analysis;/);
  assert.match(callSite, /multiItemCommerce=\{batchResultVisible \? \[\] : multiItemCommerce\}/);
  assert.match(callSite, /multiItemCommerceStatus=\{batchResultVisible \? 'idle' : multiItemCommerceStatus\}/);
  assert.match(callSite, /onRetryMultiItemCommerce=\{batchResultVisible \? undefined : retryMultiItemCommerce\}/);
  assert.match(callSite, /batchCommerceStatuses\[activeBatchItem\.id\]/);
  assert.doesNotMatch(callSite, /commerceStatus=\{!batchResultVisible/,
    'the old design hid per-item commerce in batch mode');
});

test('NEGATIVE CONTROL: the live surface component declares the commerce status/retry contract', () => {
  const file = liveResultSurfaceFile();
  const source = read(file);
  assert.match(
    source,
    /commerceStatus\?:\s*'idle' \| 'pending' \| 'success' \| 'empty' \| 'error'/,
    `${file}: must declare the v127 commerceStatus union`,
  );
  assert.match(
    source,
    /onRetryCommerce\?:\s*\(\)\s*=>\s*void/,
    `${file}: must declare onRetryCommerce`,
  );
});

test('NEGATIVE CONTROL: the live surface mounts the commerce panel for pending/error, not only for data', () => {
  const file = liveResultSurfaceFile();
  const source = read(file).replace(/\s+/g, ' ');
  assert.match(
    source,
    /purchaseShelfMode === 'pending' \|\| purchaseShelfMode === 'error'/,
    `${file}: pending/error must be a real render branch, not folded into "no data, say nothing"`,
  );
  assert.match(
    source,
    /<PurchaseOptionsPanel purchaseOptions=\{\[\]\} commerceStatus=\{purchaseShelfMode\} onRetry=\{onRetryCommerce\}/,
    `${file}: the pending/error branch must mount the panel WITH status and retry, not an empty view`,
  );
});

// -- Behavioral contract (real pure functions, not re-implemented) ----------

function loadPureFunction(file, name) {
  const source = read(file);
  const match = source.match(new RegExp(`export function ${name}[\\s\\S]*?\\n}`));
  assert.ok(match, `${name} must exist and be exported from ${file}`);
  const { outputText } = ts.transpileModule(`${match[0]}\nmodule.exports = { ${name} };`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  const mod = { exports: {} };
  new Function('module', 'exports', outputText)(mod, mod.exports);
  return mod.exports[name];
}

test('behavioral: resolvePurchaseShelfMode governs the live surface exactly as the fallback', () => {
  const resolvePurchaseShelfMode = loadPureFunction(LEGACY_FILE, 'resolvePurchaseShelfMode');

  assert.equal(resolvePurchaseShelfMode(0, true, 'pending'), 'pending');
  assert.equal(resolvePurchaseShelfMode(0, true, 'error'), 'error');
  assert.equal(resolvePurchaseShelfMode(0, true, 'idle'), 'empty');
  assert.equal(resolvePurchaseShelfMode(2, true, 'error'), 'options', 'data in hand always wins');
  assert.equal(
    resolvePurchaseShelfMode(0, false, 'pending'),
    'hidden',
    'the remote priceDiscovery kill-switch wins over a pending state',
  );
});

test('behavioral: the panel itself resolves pending/error/empty/data correctly', () => {
  const resolvePurchaseOptionsPanelMode = loadPureFunction(
    'components/scan-results/PurchaseOptionsPanel.tsx',
    'resolvePurchaseOptionsPanelMode',
  );

  assert.equal(resolvePurchaseOptionsPanelMode(false, 'pending'), 'pending');
  assert.equal(resolvePurchaseOptionsPanelMode(false, 'error'), 'error');
  assert.equal(resolvePurchaseOptionsPanelMode(false, 'idle'), 'empty');
  assert.equal(
    resolvePurchaseOptionsPanelMode(true, 'error'),
    'data',
    'data in hand always wins over a stale error from before a successful retry',
  );
});

test('the live surface honors the remote priceDiscovery kill-switch for commerce', () => {
  const file = liveResultSurfaceFile();
  const source = read(file);
  assert.match(
    source,
    /isFeatureEnabled\('priceDiscovery'\)/,
    `${file}: the live surface must consult the same remote freeze the fallback does`,
  );
});
