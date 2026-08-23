/**
 * Build 32 — zero scan-time dependency isolation.
 *
 * A React hook (hooks/useKScan.js) cannot be executed under this project's
 * plain Node test runner (see services/commerceJobScheduler.ts's header and
 * commerceHydrationV127.test.js, which asserts the equivalent v127 guard
 * against source for the same reason). This file follows that established
 * convention for the Build 32 addition.
 *
 * The invariant under test: PRIMARY_RESULT_READY —
 * `setAnalysis(data)` + `setStatus('result')` inside `finishAnalysis`, which
 * `runAnalysis` awaits — must never depend on multi-item commerce hydration
 * or multi-item persistence. Both are dispatched from SEPARATE useEffect
 * blocks gated on `status === 'result'`, i.e. only AFTER the result already
 * committed, never as part of reaching it.
 *
 * Includes a negative control (Section B of the Build 32 spec): the same
 * assertion technique applied to a deliberately mutated copy of the source,
 * with the violation wired into the primary-result path, must fail. This
 * proves the test would actually catch the regression it exists to prevent.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const useKScanSource = fs.readFileSync(path.join(ROOT, 'hooks', 'useKScan.js'), 'utf8');
const appSource = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

function runAnalysisSlice(src) {
  const start = src.indexOf('const runAnalysis = useCallback(');
  assert.ok(start > 0, 'runAnalysis not found');
  // Bounded to the same closing deps array used elsewhere in this hook —
  // avoids a brace-counting parser while still covering the whole function.
  const end = src.indexOf('[status, photo, startInFlight, clearInFlight, isOperationValid]', start);
  assert.ok(end > start, 'could not bound runAnalysis');
  return src.slice(start, end);
}

test('runAnalysis (the function that reaches PRIMARY_RESULT_READY) never calls multi-item commerce or its persistence', () => {
  const runAnalysis = runAnalysisSlice(useKScanSource);
  for (const forbidden of ['hydrateMultiItemCommerce', 'fetchMultiItemCommerce', 'saveMultiItemScan', 'attachScanMultiItemCommerce']) {
    assert.ok(
      !runAnalysis.includes(forbidden),
      `runAnalysis references ${forbidden} — multi-item commerce/persistence must never be awaited before the result is set`,
    );
  }
});

test('hydrateMultiItemCommerce is dispatched from its own effect, gated on status === "result", not from inside runAnalysis', () => {
  const commentStart = useKScanSource.indexOf(
    "// Dispatch once per detection result that has candidates to shop.",
  );
  assert.ok(commentStart > 0, 'multi-item commerce dispatch effect not found');
  // Anchor on the useEffect itself, not the comment above it: comment length
  // must not decide whether this assertion can see the guard chain.
  const dispatchEffectStart = useKScanSource.indexOf('useEffect(() => {', commentStart);
  assert.ok(dispatchEffectStart > commentStart, 'dispatch effect body not found');
  const effectSlice = useKScanSource.slice(dispatchEffectStart, dispatchEffectStart + 400);
  assert.ok(effectSlice.includes("if (status !== 'result') return;"), 'dispatch effect must early-return before status is result');
  assert.ok(effectSlice.includes('hydrateMultiItemCommerce(candidates)'), 'dispatch call not found in the effect');

  // And that effect must be textually AFTER runAnalysis is fully defined —
  // i.e. it is a sibling hook registration, not a step inside it.
  const runAnalysisStart = useKScanSource.indexOf('const runAnalysis = useCallback(');
  assert.ok(dispatchEffectStart > runAnalysisStart);
});

test('multi-item commerce is gated by the v127 activation authority, exactly like the single-item path', () => {
  // commerceDeferred is set only when the backend reports
  // `commerce.deferred === true`, which only the v127 funnel branch does. With
  // the funnel off there is no MODE B route server-side, so an ungated
  // dispatch would issue one wasted invocation per candidate and then render
  // "no strong shopping match" for a search that never ran.
  const dispatchEffectStart = useKScanSource.indexOf(
    '// Dispatch once per detection result that has candidates to shop.',
  );
  assert.ok(dispatchEffectStart > 0, 'multi-item commerce dispatch effect not found');
  const effectSlice = useKScanSource.slice(dispatchEffectStart, dispatchEffectStart + 1400);
  assert.ok(
    effectSlice.includes("if (!analysis?.commerceDeferred) return;"),
    'multi-item dispatch must be gated on commerceDeferred, the v127 activation authority',
  );

  // The explicit retry must carry the same gate — otherwise a retry button
  // reintroduces exactly the requests the dispatch gate prevents.
  const retryStart = useKScanSource.indexOf('const retryMultiItemCommerce = useCallback(');
  assert.ok(retryStart > 0, 'retryMultiItemCommerce not found');
  const retrySlice = useKScanSource.slice(retryStart, retryStart + 500);
  assert.ok(
    retrySlice.includes("if (!analysis?.commerceDeferred) return;"),
    'retryMultiItemCommerce must carry the same v127 gate as the dispatch effect',
  );
});

test('saveMultiItemScan in app.js is gated the same way as the existing saveScan effect — post-result only', () => {
  const effectStart = appSource.indexOf(
    '// Build 32: save a multi-item detection result once',
  );
  assert.ok(effectStart > 0, 'multi-item save effect not found in app.js');
  const effectSlice = appSource.slice(effectStart, effectStart + 700);
  assert.ok(effectSlice.includes("status !== 'result'"), 'save effect must be gated on status === result');
  assert.ok(effectSlice.includes('saveMultiItemScan('), 'save call not found in the effect');
});

// ── Negative control ─────────────────────────────────────────────────────────
//
// Proves the first assertion actually catches a real violation, rather than
// passing vacuously. Mutates an in-memory copy only — no file on disk is
// touched.

test('NEGATIVE CONTROL: wiring hydrateMultiItemCommerce into runAnalysis is caught by the same check', () => {
  const start = useKScanSource.indexOf('const runAnalysis = useCallback(');
  const insertionPoint = useKScanSource.indexOf("setStatus('processing');", start) + "setStatus('processing');".length;
  const mutated =
    useKScanSource.slice(0, insertionPoint) +
    '\n      await hydrateMultiItemCommerce([]); // INJECTED VIOLATION — must be caught' +
    useKScanSource.slice(insertionPoint);

  const runAnalysis = runAnalysisSlice(mutated);
  assert.ok(
    runAnalysis.includes('hydrateMultiItemCommerce'),
    'the mutation did not actually land inside runAnalysis — negative control is not exercising the check',
  );
  // This is the same predicate the real test asserts NOT true; here it must
  // be true, proving the check has teeth.
  const wouldFailRealCheck = runAnalysis.includes('hydrateMultiItemCommerce');
  assert.equal(wouldFailRealCheck, true);
});
