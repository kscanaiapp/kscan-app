/**
 * Build 34 Scanner audit — SCAN-NC-002b (audit section 9: async response
 * ordering, for the multi-item shelf specifically).
 *
 *   scan A starts
 *   scan B starts
 *   B finishes first
 *   A finishes late
 *
 * A's late answer must not overwrite B's shelf. The single-item hydration
 * guard (`commerceGenerationRef`) is covered by commerceHydrationV127; the
 * INDEPENDENT multi-item guard (`multiItemCommerceGenerationRef`) was not, and
 * deleting it passed every existing suite.
 *
 * Drives the real hooks/useKScan.js through a deterministic hook runtime, with
 * a multi-item commerce transport whose first call resolves LAST.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');

globalThis.__DEV__ = false;
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);

function detectionResponse(marker) {
  return {
    status: 'completed',
    attributes: { category: 'outerwear', itemType: 'jacket', colorPalette: ['black'], confidenceScore: 0.9 },
    identification: {
      visual_observation: `Scan ${marker}.`,
      item_type: 'outerwear',
      subtype: 'leather jacket',
      primary_color: 'black',
      confidence_score: 0.9,
      non_fashion: false,
    },
    recommendedProducts: [],
    userMessage: 'Detected multiple fashion items.',
    scanId: `scan-${marker}`,
    scanSessionId: `sess-${marker}`,
    imageDigestPrefix: `digest${marker}`,
    commerce: {
      provider: 'deferred', query: '', count: 0, providersTried: [],
      catalogCount: 0, similarityMatches: 0, commerceSkipped: true,
      deferred: true, reason: 'deferred_to_commerce_only_request',
    },
    detectedGarments: [
      {
        candidateId: 'garment-1-outerwear-leather-jacket',
        order: 0, label: 'leather jacket', category: 'outerwear', subtype: 'leather jacket',
        bounds: { x: 0.1, y: 0.1, width: 0.6, height: 0.6 },
        confidenceScore: 0.9,
        attributes: { category: 'outerwear', itemType: 'leather jacket', colorPalette: ['black'] },
        identification: { item_type: 'outerwear', subtype: 'leather jacket', primary_color: 'black', confidence_score: 0.9 },
      },
    ],
  };
}

function createLoader(root, mocks) {
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

function createHookRuntime() {
  const slots = [];
  let cursor = 0;
  let renderScheduled = false;
  let renderFn = null;
  const pendingEffects = [];
  const cleanups = new Map();
  let lastResult = null;

  const scheduleRender = () => {
    if (renderScheduled) return;
    renderScheduled = true;
    queueMicrotask(() => { renderScheduled = false; render(); });
  };
  function useState(initial) {
    const i = cursor++;
    if (!(i in slots)) slots[i] = { value: typeof initial === 'function' ? initial() : initial };
    const slot = slots[i];
    return [slot.value, (next) => {
      const value = typeof next === 'function' ? next(slot.value) : next;
      if (Object.is(value, slot.value)) return;
      slot.value = value;
      scheduleRender();
    }];
  }
  function useRef(initial) {
    const i = cursor++;
    if (!(i in slots)) slots[i] = { current: initial };
    return slots[i];
  }
  const depsChanged = (prev, next) => {
    if (!prev || !next) return true;
    if (prev.length !== next.length) return true;
    return prev.some((d, i) => !Object.is(d, next[i]));
  };
  function useCallback(fn, deps) {
    const i = cursor++;
    const slot = slots[i] || (slots[i] = { fn: null, deps: null });
    if (depsChanged(slot.deps, deps)) { slot.fn = fn; slot.deps = deps; }
    return slot.fn;
  }
  function useMemo(fn, deps) {
    const i = cursor++;
    const slot = slots[i] || (slots[i] = { value: undefined, deps: null });
    if (depsChanged(slot.deps, deps)) { slot.value = fn(); slot.deps = deps; }
    return slot.value;
  }
  function useEffect(fn, deps) {
    const i = cursor++;
    const slot = slots[i] || (slots[i] = { deps: null });
    if (depsChanged(slot.deps, deps)) { slot.deps = deps; pendingEffects.push({ key: i, fn }); }
  }
  function render() {
    cursor = 0;
    lastResult = renderFn();
    const effects = pendingEffects.splice(0, pendingEffects.length);
    for (const effect of effects) {
      const prior = cleanups.get(effect.key);
      if (typeof prior === 'function') { try { prior(); } catch { /* ignore */ } }
      const cleanup = effect.fn();
      cleanups.set(effect.key, typeof cleanup === 'function' ? cleanup : null);
    }
    return lastResult;
  }
  return {
    React: { useState, useRef, useCallback, useMemo, useEffect },
    mount(fn) { renderFn = fn; return render(); },
    get current() { return lastResult; },
    async flush(rounds = 10) {
      for (let i = 0; i < rounds; i++) {
        await new Promise((r) => setTimeout(r, 2));
        render();
      }
    },
  };
}

const plain = createLoader(ROOT, {});
const { normalizeScanIdentifyResponse } = plain('services/scanIdentification.ts');

/**
 * Mounts useKScan where multi-item commerce call #1 resolves LAST.
 * Call n answers with a shelf that names itself, so an overwrite is visible.
 */
function mount() {
  const runtime = createHookRuntime();
  let call = 0;
  let releaseFirst = null;
  let scanMarker = 'A';

  const load = createLoader(ROOT, {
    react: runtime.React,
    'react-native': {
      AccessibilityInfo: { announceForAccessibility: () => {}, isReduceMotionEnabled: async () => false },
    },
    'expo-crypto': {
      randomUUID: () => 'uuid',
      CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
      digestStringAsync: async () => 'deadbeefcafe',
    },
    'expo-image-picker': {},
    '../constants/featureFlags': { SCAN_IDENTIFY_BACKEND_ENABLED: true },
    '../services/scannerEvidenceGateway': {
      prepareScannerEvidence: ({ evidenceId }) => ({ evidenceId: evidenceId || 'ev', imageBase64: 'x', source: 'camera' }),
      createEvidenceId: () => 'ev',
    },
    '../services/scannerIdentificationV2': { beginScannerV2Session: () => ({ enabled: false }) },
    '../services/scannerScanRequest': {
      runScannerIdentification: async () => ({
        contractPath: 'legacy',
        response: normalizeScanIdentifyResponse(detectionResponse(scanMarker)),
        candidates: [], identificationV2: null, fallbackUsed: false,
      }),
    },
    '../services/commerceHydration': {
      fetchDeferredCommerce: async () => ({ status: 'empty', purchaseOptions: [], enrichmentCandidates: [], retryable: true }),
      mergeEnrichedOffers: (a) => a,
    },
    '../services/multiItemCommerce': {
      fetchMultiItemCommerce: async () => {
        call += 1;
        const which = call;
        const shelf = new Map([[
          'garment-1-outerwear-leather-jacket',
          {
            candidateId: 'garment-1-outerwear-leather-jacket',
            status: 'ready',
            bestMatch: { id: `p${which}`, title: `SHELF FROM SCAN ${which}` },
            alternatives: [],
            retryable: false,
          },
        ]]);
        // Scan A's hop is held open until the test explicitly releases it, so
        // the ordering under test is deterministic rather than timer-raced.
        if (which === 1) {
          await new Promise((resolve) => { releaseFirst = resolve; });
        }
        return shelf;
      },
    },
    '../services/secondhand': { buildSecondhandSearchRequest: () => null, searchVintedSecondhand: async () => null },
    '../services/sneakers/index': { searchSneakers: async () => null, shouldEnrichSneakers: () => false },
    '../services/imageUtils': { compressForUpload: async (u) => u },
    '../services/privacyImageSanitizer': {
      sanitizeImageBeforeUpload: async (u) => u,
      getPrivacySanitizerStatus: () => ({ faceBlurApplied: false, plateMaskApplied: false, mode: 'test', faceDetectionAvailable: false }),
    },
    '../services/haptics': new Proxy({}, { get: () => () => {} }),
  });

  const { useKScan } = load('hooks/useKScan.js');
  runtime.mount(() => useKScan());
  return {
    runtime,
    setMarker: (m) => { scanMarker = m; },
    calls: () => call,
    release: () => { if (releaseFirst) releaseFirst(); },
  };
}

async function runScan(runtime, uri) {
  runtime.current.uploadPhoto(uri);
  await runtime.flush(3);
  assert.equal(runtime.current.status, 'preview');
  await runtime.current.runAnalysis();
  await runtime.flush(6);
}

test("scan A's late multi-item shelf never lands on scan B", async () => {
  const { runtime, setMarker, calls, release } = mount();

  // Scan A — its commerce hop will take 260ms.
  await runScan(runtime, 'memory://a.jpg');
  assert.equal(runtime.current.status, 'result', 'scan A produced a result');
  assert.equal(runtime.current.multiItemCommerceStatus, 'pending', "A's shelf is still in flight");

  // Scan B starts and completes while A's commerce is still outstanding.
  setMarker('B');
  runtime.current.dismissResult();
  await runtime.flush(2);
  await runScan(runtime, 'memory://b.jpg');
  assert.equal(runtime.current.status, 'result', 'scan B produced a result');

  // Now release scan A's hop. Its answer arrives strictly after B settled.
  release();
  await runtime.flush(30);

  assert.equal(calls(), 2, 'both scans really did dispatch commerce');
  const shelf = runtime.current.multiItemCommerce;
  assert.ok(Array.isArray(shelf));
  for (const card of shelf) {
    assert.notEqual(
      card.bestMatch && card.bestMatch.title,
      'SHELF FROM SCAN 1',
      "scan A's superseded shelf overwrote scan B's — a stale answer became the visible result",
    );
  }
});

test('a superseded scan leaves no pending shelf behind on the new scan', async () => {
  const { runtime, setMarker } = mount();

  await runScan(runtime, 'memory://a.jpg');
  assert.equal(runtime.current.multiItemCommerceStatus, 'pending');

  setMarker('B');
  runtime.current.dismissResult();
  await runtime.flush(2);

  // A new scan must start from a cleared shelf, never inherit the previous
  // scan's cards or its pending state.
  runtime.current.uploadPhoto('memory://b.jpg');
  await runtime.flush(3);
  assert.deepEqual(runtime.current.multiItemCommerce, [],
    'the new scan starts with no cards carried over from the superseded one');
});
