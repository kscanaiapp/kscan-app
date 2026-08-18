/**
 * v127 (P1-B) — commerce shelf pending/error/retry wiring.
 *
 * `ProductShelf.tsx` and `AnalysisCard.tsx` import react-native and Platform-
 * dependent theme tokens at module scope, so the whole file cannot load under
 * plain `node --test` (confirmed: loading either throws on unrelated
 * RN-only module-level code before any test-relevant line runs). The actual
 * JSX in both files calls `resolveEmptyShelfMode` / `resolvePurchaseShelfMode`
 * rather than duplicating the precedence inline, so extracting and executing
 * just those two named, pure, dependency-free functions is real behavioral
 * coverage of the branch the render path actually takes — not a parallel
 * reimplementation and not a source-text guess.
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
      // Scalar/union return type: consume up to the body's `{`.
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

const { resolveEmptyShelfMode } = loadPure('components/ProductShelf.tsx', 'resolveEmptyShelfMode');
const { resolvePurchaseShelfMode } = loadPure('components/AnalysisCard.tsx', 'resolvePurchaseShelfMode');

// ── ProductShelf: which empty-state treatment renders ───────────────────────

test('ProductShelf: pending wins over error', () => {
  assert.equal(resolveEmptyShelfMode(true, true), 'pending');
});

test('ProductShelf: error renders when not pending', () => {
  assert.equal(resolveEmptyShelfMode(false, true), 'error');
});

test('ProductShelf: default empty when neither pending nor error', () => {
  assert.equal(resolveEmptyShelfMode(false, false), 'empty');
});

// ── AnalysisCard: which "WHERE TO BUY" treatment renders ────────────────────

test('AnalysisCard: options in hand always win, even if status says error', () => {
  // A stale 'error' from before a successful retry must never hide options
  // that already arrived — this is the exact bug class P1-B closes.
  assert.equal(resolvePurchaseShelfMode(1, true, 'error'), 'options');
  assert.equal(resolvePurchaseShelfMode(3, true, 'pending'), 'options');
});

test('AnalysisCard: pending renders only while nothing has arrived', () => {
  assert.equal(resolvePurchaseShelfMode(0, true, 'pending'), 'pending');
});

test('AnalysisCard: error renders only while nothing has arrived', () => {
  assert.equal(resolvePurchaseShelfMode(0, true, 'error'), 'error');
});

test('AnalysisCard: idle/success/empty status with no options stays hidden (pre-existing behavior)', () => {
  for (const status of ['idle', 'success', 'empty', 'unknown-future-status']) {
    assert.equal(
      resolvePurchaseShelfMode(0, true, status), 'hidden',
      `status "${status}" unexpectedly shows a shelf treatment`,
    );
  }
});

test('AnalysisCard: the feature flag gate is absolute — nothing renders when priceDiscovery is off', () => {
  assert.equal(resolvePurchaseShelfMode(1, false, 'pending'), 'hidden');
  assert.equal(resolvePurchaseShelfMode(0, false, 'error'), 'hidden');
});

// ── Retry wiring: app.js -> AnalysisCard -> ProductShelf -> retryCommerce ───

test('WIRING: the Retry control reaches retryCommerce, not a placeholder', () => {
  const appSrc = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  const cardSrc = fs.readFileSync(path.join(ROOT, 'components/AnalysisCard.tsx'), 'utf8');
  const shelfSrc = fs.readFileSync(path.join(ROOT, 'components/ProductShelf.tsx'), 'utf8');

  assert.ok(appSrc.includes('onRetryCommerce={retryCommerce}'), 'app.js does not pass retryCommerce into AnalysisCard');
  assert.ok(cardSrc.includes('onRetryCommerce,'), 'AnalysisCard does not accept onRetryCommerce');
  assert.ok(cardSrc.includes('onRetry={onRetryCommerce}'), 'AnalysisCard does not forward onRetryCommerce into ProductShelf as onRetry');
  assert.ok(shelfSrc.includes('onPress={onRetry}'), 'ProductShelf\'s retry control is not wired to the onRetry prop');
});

test('negative control: this is exactly the pre-P1-B behavior for the cases it changed', () => {
  // Before P1-B, the render call was a plain `purchaseOptions.length >= 1`
  // check with no commerceStatus branch at all — pending/error rendered
  // NOTHING. Simulate that literal pre-fix expression against the same inputs.
  function preFixMode(purchaseOptionsCount, priceDiscoveryEnabled) {
    return priceDiscoveryEnabled && purchaseOptionsCount >= 1 ? 'options' : 'hidden';
  }
  assert.equal(preFixMode(0, true), 'hidden');
  assert.notEqual(resolvePurchaseShelfMode(0, true, 'pending'), preFixMode(0, true), 'pending case does not differ from pre-fix — P1-B added nothing observable');
  assert.notEqual(resolvePurchaseShelfMode(0, true, 'error'), preFixMode(0, true), 'error case does not differ from pre-fix — P1-B added nothing observable');
});
