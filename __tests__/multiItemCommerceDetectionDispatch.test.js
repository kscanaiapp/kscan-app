/**
 * Build 34 Scanner audit — SCAN-001.
 *
 * The multi-item commerce shelf must not tell the user "No strong shopping
 * match found." for a search that never ran.
 *
 * WHY THIS TEST EXISTS SEPARATELY FROM multiItemCommerceCriticalPath.test.js:
 * that suite stubs `mapScanIdentifyToAnalysis` with a literal that already
 * carries `commerceDeferred: true`, so it proves the dispatch works *given*
 * the marker — it cannot see whether the backend ever sets it. This test
 * removes that assumption: it feeds the response the deployed backend
 * actually returns for a multi-item DETECTION request through the real
 * `normalizeScanIdentifyResponse` + `mapScanIdentifyToAnalysis`, and then
 * through the real `hooks/useKScan.js`.
 *
 * The detection branch in supabase/functions/scan-identify/index.ts
 * (`else if (useMultiItemDetectionProvider)`) is evaluated BEFORE the v127
 * `else if (commerceFunnelEnabled)` branch, so a detection response carried
 * `commerce.commerceSkipped = true` and never `commerce.deferred = true`.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');

globalThis.__DEV__ = false;
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);

// ── The literal response shape the deployed detection path returns ──────────
//
// Mirrors `legacyFinalResponse` in scan-identify/index.ts for a
// `requestMode: 'multi_item_detection'` request with SCAN_MULTI_ITEM_ENABLED
// and BACKEND_COMMERCE_FUNNEL_V127_ENABLED both "true" on App Staging.
function detectionResponse(commerceMeta) {
  return {
    status: 'completed',
    attributes: {
      category: 'outerwear',
      itemType: 'blazer',
      colorPalette: ['black'],
      confidenceScore: 0.82,
    },
    identification: {
      visual_observation: 'Black structured blazer over a white shirt.',
      item_type: 'blazer',
      subtype: 'double-breasted blazer',
      primary_color: 'black',
      confidence_score: 0.82,
      non_fashion: false,
    },
    recommendedProducts: [],
    userMessage: 'Detected multiple fashion items.',
    scanId: 'scan-1',
    scanSessionId: 'scan_sess_1',
    imageDigestPrefix: 'abc123def456',
    commerce: commerceMeta,
    detectedGarments: [
      {
        candidateId: 'garment-1-outerwear-double-breasted-blazer',
        order: 0,
        label: 'black blazer',
        category: 'outerwear',
        subtype: 'double-breasted blazer',
        bounds: { x: 0.12, y: 0.08, width: 0.7, height: 0.5 },
        confidenceScore: 0.82,
        attributes: {
          category: 'outerwear',
          itemType: 'double-breasted blazer',
          colorPalette: ['black'],
        },
        identification: {
          item_type: 'outerwear',
          subtype: 'double-breasted blazer',
          primary_color: 'black',
          confidence_score: 0.82,
        },
      },
      {
        candidateId: 'garment-2-footwear-chelsea-boot',
        order: 1,
        label: 'brown chelsea boot',
        category: 'footwear',
        subtype: 'chelsea boot',
        bounds: { x: 0.3, y: 0.7, width: 0.3, height: 0.25 },
        confidenceScore: 0.71,
        attributes: {
          category: 'footwear',
          itemType: 'chelsea boot',
          colorPalette: ['brown'],
        },
        identification: {
          item_type: 'footwear',
          subtype: 'chelsea boot',
          primary_color: 'brown',
          confidence_score: 0.71,
        },
      },
    ],
  };
}

/** The detection branch's shoppingMeta once SCAN-001 is repaired. */
const DEFERRED_DETECTION_COMMERCE = {
  provider: 'deferred',
  query: '',
  count: 0,
  providersTried: [],
  catalogCount: 0,
  similarityMatches: 0,
  commerceSkipped: true,
  deferred: true,
  reason: 'deferred_to_commerce_only_request',
};

// ── TypeScript-aware production module loader ──────────────────────────────
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

// ── Minimal deterministic React hook runtime ────────────────────────────────
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

  function depsChanged(prev, next) {
    if (!prev || !next) return true;
    if (prev.length !== next.length) return true;
    return prev.some((d, i) => !Object.is(d, next[i]));
  }

  function useCallback(fn, deps) {
    const i = cursor++;
    const slot = slots[i] || (slots[i] = { fn: null, deps: null });
    if (depsChanged(slot.deps, deps)) {
      slot.fn = fn;
      slot.deps = deps;
    }
    return slot.fn;
  }

  function useMemo(fn, deps) {
    const i = cursor++;
    const slot = slots[i] || (slots[i] = { value: undefined, deps: null });
    if (depsChanged(slot.deps, deps)) {
      slot.value = fn();
      slot.deps = deps;
    }
    return slot.value;
  }

  function useEffect(fn, deps) {
    const i = cursor++;
    const slot = slots[i] || (slots[i] = { deps: null });
    if (depsChanged(slot.deps, deps)) {
      slot.deps = deps;
      pendingEffects.push({ key: i, fn });
    }
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
    async flush(rounds = 8) {
      for (let i = 0; i < rounds; i++) {
        await new Promise((r) => setTimeout(r, 1));
        render();
      }
    },
  };
}

const loadPlain = createLoader(ROOT, {});

test('a detection response that renders shoppable candidates marks commerce as deferred', () => {
  const { normalizeScanIdentifyResponse } = loadPlain('services/scanIdentification.ts');
  const { mapScanIdentifyToAnalysis } = loadPlain('services/scanIdentificationMapper.ts');

  const normalized = normalizeScanIdentifyResponse(
    detectionResponse(DEFERRED_DETECTION_COMMERCE),
  );
  assert.equal(normalized.status, 'completed');
  assert.equal(normalized.detectedGarments?.length, 2, 'both detected garments survive normalization');

  const analysis = mapScanIdentifyToAnalysis(normalized, { source: 'camera' });
  assert.equal(analysis.confirmationCandidates?.length, 2,
    'the scan result renders two detected-item candidates');

  assert.equal(analysis.commerceDeferred, true,
    'a detection response that renders shoppable candidates must mark commerce as deferred, ' +
    'otherwise hydrateMultiItemCommerce never dispatches and every item card states ' +
    '"No strong shopping match found." for a search that never ran');
});

test('multi-item commerce dispatches for a real detection response', async () => {
  const runtime = createHookRuntime();
  const calls = { multiItem: 0, singleItem: 0 };
  const { normalizeScanIdentifyResponse } = loadPlain('services/scanIdentification.ts');

  const load = createLoader(ROOT, {
    react: runtime.React,
    'react-native': {
      AccessibilityInfo: { announceForAccessibility: () => {}, isReduceMotionEnabled: async () => false },
    },
    'expo-crypto': {
      randomUUID: () => 'uuid-1',
      CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
      digestStringAsync: async () => 'deadbeefcafe0123',
    },
    'expo-image-picker': {},
    '../constants/featureFlags': { SCAN_IDENTIFY_BACKEND_ENABLED: true },
    '../services/scannerEvidenceGateway': {
      prepareScannerEvidence: ({ evidenceId }) => ({
        evidenceId: evidenceId || 'evidence-1',
        imageBase64: 'x',
        source: 'camera',
      }),
      createEvidenceId: () => 'evidence-1',
    },
    '../services/scannerIdentificationV2': { beginScannerV2Session: () => ({ enabled: false }) },
    '../services/scannerScanRequest': {
      runScannerIdentification: async () => ({
        contractPath: 'legacy',
        response: normalizeScanIdentifyResponse(detectionResponse(DEFERRED_DETECTION_COMMERCE)),
        candidates: [],
        identificationV2: null,
        fallbackUsed: false,
      }),
    },
    // The REAL scanIdentificationMapper is used — that is the point of the test.
    '../services/commerceHydration': {
      fetchDeferredCommerce: async () => {
        calls.singleItem += 1;
        return { status: 'empty', purchaseOptions: [], enrichmentCandidates: [], retryable: true };
      },
      mergeEnrichedOffers: (a) => a,
    },
    '../services/multiItemCommerce': {
      fetchMultiItemCommerce: async () => { calls.multiItem += 1; return new Map(); },
    },
    '../services/secondhand': {
      buildSecondhandSearchRequest: () => null,
      searchVintedSecondhand: async () => null,
    },
    '../services/sneakers/index': { searchSneakers: async () => null, shouldEnrichSneakers: () => false },
    '../services/imageUtils': { compressForUpload: async (u) => u },
    '../services/privacyImageSanitizer': {
      sanitizeImageBeforeUpload: async (u) => u,
      getPrivacySanitizerStatus: () => ({
        faceBlurApplied: false,
        plateMaskApplied: false,
        mode: 'test',
        faceDetectionAvailable: false,
      }),
    },
    '../services/haptics': new Proxy({}, { get: () => () => {} }),
  });

  const { useKScan } = load('hooks/useKScan.js');
  runtime.mount(() => useKScan());

  runtime.current.uploadPhoto('memory://capture.jpg');
  await runtime.flush(3);
  assert.equal(runtime.current.status, 'preview', 'reached preview');

  await runtime.current.runAnalysis();
  await runtime.flush(16);

  assert.equal(runtime.current.status, 'result', 'the scan succeeded');
  assert.equal(runtime.current.analysis?.confirmationCandidates?.length, 2,
    'two detected items are shown to the user');
  assert.equal(calls.multiItem, 1,
    'commerce must be fetched for the detected items the shelf renders — otherwise ' +
    'every card shows a no-match state for a search that never ran');
});
