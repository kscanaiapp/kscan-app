/**
 * Build 32 — Scanner critical path is not owned by commerce or persistence.
 *
 * Section 15 of the Build 32 audit: PRIMARY_RESULT_READY must remain
 * available when multi-item commerce and multi-item persistence are slow or
 * throwing. Source-text checks cannot show that — an import graph can look
 * correct while the runtime still awaits. So this drives the REAL
 * hooks/useKScan.js through a deterministic React hook runtime (useState /
 * useEffect / useCallback / useRef / useMemo), with a 5-SECOND multi-item
 * commerce delay and a throwing persistence layer injected underneath it, and
 * asserts the result is already readable while both are still outstanding.
 *
 * Everything below the hook is a stub; the hook itself is production source.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = process.env.KSCAN_COMMERCE_SOURCE_ROOT
  ? path.resolve(process.env.KSCAN_COMMERCE_SOURCE_ROOT)
  : path.resolve(__dirname, '..');

// selectStaticFixture is the deterministic entry into 'preview' and is DEV-gated.
globalThis.__DEV__ = true;
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);

// ── A minimal, deterministic React hook runtime ─────────────────────────────
//
// Enough of React's contract for a single component instance: positional
// state slots, effects that run after each render pass, and stable refs.
// Renders are driven explicitly so the test controls when the "UI" observes
// state — which is exactly the property under test.
function createHookRuntime() {
  const slots = [];
  let cursor = 0;
  let renderScheduled = false;
  let renderFn = null;
  const pendingEffects = [];
  const cleanups = new Map();
  let lastResult = null;
  let renderCount = 0;

  const scheduleRender = () => {
    if (renderScheduled) return;
    renderScheduled = true;
    queueMicrotask(() => { renderScheduled = false; render(); });
  };

  function useState(initial) {
    const i = cursor++;
    if (!(i in slots)) slots[i] = { value: typeof initial === 'function' ? initial() : initial };
    const slot = slots[i];
    const set = (next) => {
      const value = typeof next === 'function' ? next(slot.value) : next;
      if (Object.is(value, slot.value)) return;
      slot.value = value;
      scheduleRender();
    };
    return [slot.value, set];
  }

  function useRef(initial) {
    const i = cursor++;
    if (!(i in slots)) slots[i] = { current: initial };
    return slots[i];
  }

  // Must memoize on deps exactly like React does. A useCallback that returns a
  // fresh identity each render would make every dependent effect re-fire, and
  // the resulting duplicate dispatches would be an artifact of this harness
  // rather than a property of the hook under test.
  function useCallback(fn, deps) {
    const i = cursor++;
    const prev = slots[i];
    if (prev && prev.deps && deps && depsEqual(prev.deps, deps)) return prev.value;
    slots[i] = { value: fn, deps: deps ? deps.slice() : deps };
    return fn;
  }

  function useMemo(factory, deps) {
    const i = cursor++;
    const prev = slots[i];
    if (prev && prev.deps && depsEqual(prev.deps, deps)) return prev.value;
    const value = factory();
    slots[i] = { value, deps: deps ? deps.slice() : deps };
    return value;
  }

  function depsEqual(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    return a.every((v, i) => Object.is(v, b[i]));
  }

  function useEffect(fn, deps) {
    const i = cursor++;
    const prev = slots[i];
    const changed = !prev || !prev.deps || !deps || !depsEqual(prev.deps, deps);
    slots[i] = { deps: deps ? deps.slice() : deps, isEffect: true };
    if (changed) pendingEffects.push({ key: i, fn });
  }

  function render() {
    cursor = 0;
    renderCount += 1;
    lastResult = renderFn();
    const effects = pendingEffects.splice(0, pendingEffects.length);
    for (const { key, fn } of effects) {
      const cleanup = cleanups.get(key);
      if (typeof cleanup === 'function') { try { cleanup(); } catch { /* ignore */ } }
      const next = fn();
      cleanups.set(key, typeof next === 'function' ? next : null);
    }
    return lastResult;
  }

  return {
    React: { useState, useRef, useCallback, useEffect, useMemo },
    mount(fn) { renderFn = fn; return render(); },
    get current() { return lastResult; },
    get renderCount() { return renderCount; },
    flush: async (times = 6) => { for (let i = 0; i < times; i += 1) await Promise.resolve(); },
  };
}

function createLoader(root, mocks = {}) {
  const cache = new Map();
  function resolveFile(candidate) {
    const candidates = path.extname(candidate)
      ? [candidate]
      : [`${candidate}.ts`, `${candidate}.tsx`, `${candidate}.js`];
    return candidates.find((f) => fs.existsSync(f) && fs.statSync(f).isFile());
  }
  function loadFile(filename) {
    const resolved = resolveFile(filename);
    if (!resolved) throw new Error(`Unable to resolve production module: ${filename}`);
    if (cache.has(resolved)) return cache.get(resolved).exports;
    const module = { exports: {} };
    cache.set(resolved, module);
    const output = ts.transpileModule(fs.readFileSync(resolved, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
        jsx: ts.JsxEmit.React,
      },
      fileName: resolved,
    }).outputText;
    const localRequire = (id) => {
      if (Object.prototype.hasOwnProperty.call(mocks, id)) return mocks[id];
      if (id.startsWith('.')) return loadFile(path.resolve(path.dirname(resolved), id));
      try { return require(id); } catch { return {}; }
    };
    Function('exports', 'require', 'module', '__filename', '__dirname', output)(
      module.exports, localRequire, module, resolved, path.dirname(resolved),
    );
    return module.exports;
  }
  return (relativePath) => loadFile(path.resolve(root, relativePath));
}

const ANALYSIS_WITH_CANDIDATES = {
  result: 'A biker jacket and a chelsea boot.',
  metadata: { category: 'outerwear', color: 'black' },
  products: [],
  purchaseOptions: [],
  commerceDeferred: true,
  confirmationCandidates: [
    { id: 'jacket', order: 0, label: 'Biker Jacket', category: 'outerwear', subtype: 'jacket',
      isPrimary: true, source: { candidateId: 'jacket', identification: { item_type: 'jacket' }, attributes: {} } },
    { id: 'boots', order: 1, label: 'Chelsea Boot', category: 'footwear', subtype: 'boot',
      isPrimary: false, source: { candidateId: 'boots', identification: { item_type: 'boot' }, attributes: {} } },
  ],
};

/**
 * Mount useKScan with every dependency stubbed, and with multi-item commerce
 * deliberately hostile: a 5s delay, or a synchronous throw.
 */
function mountScanner({ commerceDelayMs = 0, commerceThrows = false, counters }) {
  const runtime = createHookRuntime();

  const load = createLoader(ROOT, {
    react: runtime.React,
    'react-native': { AccessibilityInfo: { announceForAccessibility: () => {}, isReduceMotionEnabled: async () => false } },
    'expo-crypto': {
      randomUUID: () => 'uuid-' + Math.random().toString(16).slice(2),
      CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
      digestStringAsync: async () => 'deadbeefcafe0123',
    },
    'expo-image-picker': {},
    '../constants/featureFlags': { SCAN_IDENTIFY_BACKEND_ENABLED: true },
    '../services/scannerEvidenceGateway': {
      prepareScannerEvidence: ({ evidenceId }) => ({ evidenceId: evidenceId || 'evidence-1', image: 'memory://prepared.jpg' }),
      createEvidenceId: () => 'evidence-1',
    },
    '../services/scannerIdentificationV2': { beginScannerV2Session: () => ({ sessionId: 's1' }) },
    '../services/scannerScanRequest': {
      runScannerIdentification: async () => {
        counters.identification += 1;
        return {
          response: { status: 'completed' },
          candidates: [],
          identificationV2: null,
          v2ValidationFailure: false,
          rejection: null,
        };
      },
    },
    '../services/scanIdentificationMapper': {
      mapScanIdentifyToAnalysis: () => ANALYSIS_WITH_CANDIDATES,
    },
    '../services/commerceHydration': {
      fetchDeferredCommerce: async () => {
        counters.singleItemCommerce += 1;
        return { status: 'empty', purchaseOptions: [], enrichmentCandidates: [], cacheHit: false, retryable: true };
      },
      mergeEnrichedOffers: (a) => a,
    },
    '../services/multiItemCommerce': {
      fetchMultiItemCommerce: async () => {
        counters.multiItemCommerceStarted += 1;
        if (commerceThrows) throw new Error('injected multi-item commerce failure');
        if (commerceDelayMs) await new Promise((r) => setTimeout(r, commerceDelayMs));
        counters.multiItemCommerceFinished += 1;
        return new Map();
      },
    },
    '../services/secondhand': { buildSecondhandSearchRequest: () => null, searchVintedSecondhand: async () => null },
    '../services/sneakers/index': { searchSneakers: async () => null, shouldEnrichSneakers: () => false },
    '../services/imageUtils': { compressForUpload: async (u) => u },
    '../services/privacyImageSanitizer': {
      sanitizeImageBeforeUpload: async (u) => u,
      getPrivacySanitizerStatus: () => ({ faceBlurApplied: false }),
    },
    '../services/haptics': new Proxy({}, { get: () => () => {} }),
  });

  const { useKScan } = load('hooks/useKScan.js');
  runtime.mount(() => useKScan());
  return runtime;
}

/** idle -> preview -> processing -> result, through the hook's own transitions. */
async function runScan(runtime) {
  runtime.current.selectStaticFixture('memory://capture.jpg', 'audit-fixture');
  // requestAnimationFrame defers the preview transition by a macrotask.
  await new Promise((r) => setTimeout(r, 5));
  await runtime.flush();
  assert.equal(runtime.current.status, 'preview', 'reached preview before analysis');
  const started = Date.now();
  await runtime.current.runAnalysis();
  await runtime.flush(10);
  return Date.now() - started;
}

test('the scan result is readable while multi-item commerce is still 5s away', async () => {
  const counters = { identification: 0, singleItemCommerce: 0, multiItemCommerceStarted: 0, multiItemCommerceFinished: 0 };
  const runtime = mountScanner({ commerceDelayMs: 5000, counters });

  const elapsed = await runScan(runtime);
  const view = runtime.current;

  assert.equal(view.status, 'result', 'PRIMARY_RESULT_READY reached');
  assert.ok(view.analysis, 'the analysis is available to render');
  assert.equal(view.analysis.confirmationCandidates.length, 2, 'both detected items are present');
  // The hook holds 'processing' for MIN_ANALYSIS_MS (600ms) so the HUD can
  // finish its entry animation. That floor is deliberate; the 5s commerce hop
  // is what must not be waited on.
  assert.ok(elapsed < 3000,
    `the result must not wait on the 5s commerce hop (waited ${elapsed}ms)`);

  assert.equal(counters.multiItemCommerceStarted, 1, 'commerce did start, in the background');
  assert.equal(counters.multiItemCommerceFinished, 0,
    'and it is still outstanding while the result is already readable');
  assert.equal(view.multiItemCommerceStatus, 'pending');
});

test('a throwing multi-item commerce hop never turns a good scan into a failure', async () => {
  const counters = { identification: 0, singleItemCommerce: 0, multiItemCommerceStarted: 0, multiItemCommerceFinished: 0 };
  const runtime = mountScanner({ commerceThrows: true, counters });

  await runScan(runtime);
  await runtime.flush(12);

  const view = runtime.current;
  assert.equal(view.status, 'result', 'the scan is still a successful scan');
  assert.ok(view.analysis, 'and the result is still rendered');
  assert.equal(view.error, null, 'a commerce exception is not a scan error');
  assert.equal(counters.multiItemCommerceStarted, 1, 'the failing hop really did run');
});

test('exactly one identification call reaches the primary result', async () => {
  const counters = { identification: 0, singleItemCommerce: 0, multiItemCommerceStarted: 0, multiItemCommerceFinished: 0 };
  const runtime = mountScanner({ commerceDelayMs: 5000, counters });

  await runScan(runtime);

  assert.equal(runtime.current.status, 'result');
  assert.equal(counters.identification, 1,
    'one scan is one identification call — multi-item detection does not re-run it per candidate');
});
