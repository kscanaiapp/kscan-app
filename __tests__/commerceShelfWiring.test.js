/**
 * v127 (P1-B) — commerce panel pending/error/retry wiring, Android.
 *
 * `PurchaseOptionsPanel.tsx` and `AnalysisCard.tsx` import react-native and
 * Platform-dependent theme tokens at module scope, so the whole file cannot
 * load under plain `node --test`. The actual JSX in both files calls
 * `resolvePurchaseOptionsPanelMode` / `resolvePurchaseShelfMode` rather than
 * duplicating the precedence inline, so extracting and executing just those
 * two named, pure, dependency-free functions is real behavioral coverage of
 * the branch the render path actually takes.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

/** Extract one `export function name(...): ReturnType { body }` as plain JS.
 * Only the signature is touched (params/return-type annotations stripped by
 * position, not by pattern-matching object-literal keys inside the body). */
function extractFunctionAsJs(src, name) {
  const nameStart = src.indexOf(`export function ${name}(`);
  assert.ok(nameStart > 0, `missing ${name}`);
  const parenOpen = nameStart + `export function ${name}`.length;
  assert.equal(src[parenOpen], '(');

  let depth = 0;
  let parenClose = -1;
  for (let i = parenOpen; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') { depth--; if (depth === 0) { parenClose = i; break; } }
  }
  assert.ok(parenClose > 0, `unbalanced parameter list for ${name}`);

  const paramText = src.slice(parenOpen + 1, parenClose);
  const rawParams = [];
  let nest = 0;
  let last = 0;
  for (let i = 0; i < paramText.length; i++) {
    const ch = paramText[i];
    if (ch === '<' || ch === '(' || ch === '{' || ch === '[') nest++;
    else if (ch === '>' || ch === ')' || ch === '}' || ch === ']') nest--;
    else if (ch === ',' && nest === 0) { rawParams.push(paramText.slice(last, i)); last = i + 1; }
  }
  rawParams.push(paramText.slice(last));
  const params = rawParams.map((p) => p.trim().split(':')[0].trim()).filter(Boolean);

  let cursor = parenClose + 1;
  while (/\s/.test(src[cursor])) cursor++;
  if (src[cursor] === ':') {
    cursor++;
    while (/\s/.test(src[cursor])) cursor++;
    if (src[cursor] === '{') {
      let typeDepth = 0;
      for (; cursor < src.length; cursor++) {
        if (src[cursor] === '{') typeDepth++;
        else if (src[cursor] === '}') { typeDepth--; if (typeDepth === 0) { cursor++; break; } }
      }
    } else {
      const brace = src.indexOf('{', cursor);
      cursor = brace;
    }
    while (/\s/.test(src[cursor])) cursor++;
  }
  const bodyOpen = cursor;
  assert.equal(src[bodyOpen], '{', `no function body found for ${name}`);

  depth = 0;
  let bodyClose = -1;
  for (let i = bodyOpen; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { bodyClose = i; break; } }
  }
  assert.ok(bodyClose > bodyOpen, `unbalanced body for ${name}`);

  return `function ${name}(${params.join(', ')}) ${src.slice(bodyOpen, bodyClose + 1)}`;
}

function loadPure(file, ...names) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const code = names.map((n) => extractFunctionAsJs(src, n)).join('\n')
    + `\nreturn { ${names.join(', ')} };`;
  return new Function(code)();
}

const { resolvePurchaseOptionsPanelMode } = loadPure(
  'components/scan-results/PurchaseOptionsPanel.tsx',
  'resolvePurchaseOptionsPanelMode',
);
const { resolvePurchaseShelfMode } = loadPure('components/AnalysisCard.tsx', 'resolvePurchaseShelfMode');

// ── PurchaseOptionsPanel: which treatment renders ───────────────────────────

test('PurchaseOptionsPanel: data always wins, even if status says error', () => {
  // A stale 'error' from before a successful retry must never hide options
  // that already arrived — this is the exact bug class P1-B closes.
  assert.equal(resolvePurchaseOptionsPanelMode(true, 'error'), 'data');
  assert.equal(resolvePurchaseOptionsPanelMode(true, 'pending'), 'data');
});

test('PurchaseOptionsPanel: pending/error render only while there is no data', () => {
  assert.equal(resolvePurchaseOptionsPanelMode(false, 'pending'), 'pending');
  assert.equal(resolvePurchaseOptionsPanelMode(false, 'error'), 'error');
});

test('PurchaseOptionsPanel: idle/success/empty status with no data falls back to the existing empty state', () => {
  for (const status of ['idle', 'success', 'empty', 'unknown-future-status']) {
    assert.equal(resolvePurchaseOptionsPanelMode(false, status), 'empty');
  }
});

// ── AnalysisCard: whether the panel mounts at all ───────────────────────────

test('AnalysisCard: options in hand always win, even if status says error', () => {
  assert.equal(resolvePurchaseShelfMode(1, true, 'error'), 'options');
  assert.equal(resolvePurchaseShelfMode(3, true, 'pending'), 'options');
});

test('AnalysisCard: pending/error mount the panel only while nothing has arrived', () => {
  assert.equal(resolvePurchaseShelfMode(0, true, 'pending'), 'pending');
  assert.equal(resolvePurchaseShelfMode(0, true, 'error'), 'error');
});

test('AnalysisCard: idle/success/empty status with no options renders the governed empty state', () => {
  for (const status of ['idle', 'success', 'empty', 'unknown-future-status']) {
    assert.equal(
      resolvePurchaseShelfMode(0, true, status), 'empty',
      `status "${status}" unexpectedly failed to mount the empty state`,
    );
  }
});

test('AnalysisCard: the feature flag gate is absolute — nothing renders when priceDiscovery is off', () => {
  assert.equal(resolvePurchaseShelfMode(1, false, 'pending'), 'hidden');
  assert.equal(resolvePurchaseShelfMode(0, false, 'error'), 'hidden');
});

// ── Retry wiring: app.js -> AnalysisCard -> PurchaseOptionsPanel -> retryCommerce
//
// NOTE: AnalysisCard is the pre-v127-live-surface-repair fallback component —
// SCAN_RESULTS_V2_UI_ENABLED is 'true' in every governed profile on this line,
// so app.js actually renders ScanResultV2 for a completed scan, not this one.
// This test is retained because AnalysisCard still exists as the fallback for
// an unhealthy config and its own wiring must not silently rot. The LIVE
// surface's equivalent contract is asserted in
// __tests__/liveCommerceSurfaceStateContract.test.js, which resolves which
// component is actually live from eas.json rather than assuming.

test('WIRING (fallback surface): the Retry control reaches retryCommerce, not a placeholder', () => {
  const appSrc = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  const cardSrc = fs.readFileSync(path.join(ROOT, 'components/AnalysisCard.tsx'), 'utf8');
  const panelSrc = fs.readFileSync(path.join(ROOT, 'components/scan-results/PurchaseOptionsPanel.tsx'), 'utf8');

  assert.ok(appSrc.includes('onRetryCommerce={retryCommerce}'), 'app.js does not pass retryCommerce into AnalysisCard');
  assert.ok(cardSrc.includes('onRetryCommerce,'), 'AnalysisCard does not accept onRetryCommerce');
  assert.ok(cardSrc.includes('onRetry={onRetryCommerce}'), 'AnalysisCard does not forward onRetryCommerce into PurchaseOptionsPanel as onRetry');
  assert.ok(panelSrc.includes('onPress: onRetry'), 'PurchaseOptionsPanel\'s retry action is not wired to the onRetry prop');
});

test('negative control: this is exactly the pre-P1-B behavior for the cases it changed', () => {
  // Before P1-B, the outer render gate was a plain `commerceOptions.length > 0`
  // check with no commerceStatus branch at all — pending/error mounted NOTHING.
  function preFixMode(purchaseOptionsCount, priceDiscoveryEnabled) {
    return priceDiscoveryEnabled && purchaseOptionsCount > 0 ? 'options' : 'hidden';
  }
  assert.equal(preFixMode(0, true), 'hidden');
  assert.notEqual(resolvePurchaseShelfMode(0, true, 'pending'), preFixMode(0, true));
  assert.notEqual(resolvePurchaseShelfMode(0, true, 'error'), preFixMode(0, true));
});
