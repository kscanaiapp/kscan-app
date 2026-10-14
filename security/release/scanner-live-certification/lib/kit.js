'use strict';

/**
 * Screen kit: runs the REAL Scanner client against whatever `supabase` it is given.
 *
 * Real (transpiled from the repository on every run, nothing re-implemented):
 *   hooks/useKScan.js and its service graph (transport, normaliser, mapper, adapter),
 *   services/commerceHydration.ts, services/batchCommerceSelection.js,
 *   services/privacyImageSanitizer.js, services/library.js (over an in-memory
 *   filesystem), and the app.js batch regions below, extracted by marker and
 *   executed. A marker that stops matching throws; it never passes vacuously.
 *
 * Replaced (device edges only): the photo picker, expo-image-manipulator (the
 * caller supplies the prepared bytes), haptics, and the filesystem.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const { createGraph, mountUseKScan } = require(path.join(ROOT, '__tests__', 'helpers', 'scannerHookHarness.js'));

const APP = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

class KitMarkerError extends Error {
  constructor(message) {
    super(message);
    this.name = 'KitMarkerError';
  }
}

function region(startMarker, endMarker, { includeEnd = false } = {}) {
  const start = APP.indexOf(startMarker);
  if (start < 0) throw new KitMarkerError(`start marker not found in app.js: ${startMarker.slice(0, 80)}`);
  const end = APP.indexOf(endMarker, start + startMarker.length);
  if (end <= start) throw new KitMarkerError(`end marker not found after start in app.js: ${endMarker.slice(0, 80)}`);
  return APP.slice(start, includeEnd ? end + endMarker.length : end);
}

const REGIONS = {
  queue: () => region('const runBatchQueue = useCallback(', '\n  const persistBatchItem = useCallback('),
  persist: () => [
    region('const persistBatchItem = useCallback(', '\n  // B35-SCAN-014: hydrate MODE B'),
    region('const saveAllBatchItems = useCallback(', '\n  useEffect(() => () => {\n    batchGenerationRef'),
  ].join('\n'),
  commerce: () => region(
    'const hydrateBatchCommerceForItem = useCallback(',
    '\n  useEffect(() => {\n    if (!eligibleBatchSession) return;\n    for (const item of batchItems) {',
  ),
  commerceDispatchEffect: () => region(
    'useEffect(() => {\n    if (!eligibleBatchSession) return;\n    for (const item of batchItems) {',
    '}, [eligibleBatchSession, batchItems, hydrateBatchCommerceForItem]);',
    { includeEnd: true },
  ),
  attachEffect: () => region(
    'useEffect(() => {\n    for (const item of batchItems) {\n      const savedId = savedBatchScanIds[item.id];',
    '}, [batchItems, savedBatchScanIds]);',
    { includeEnd: true },
  ),
};

function evaluate(code, scope, returns = []) {
  const names = Object.keys(scope);
  const factory = new Function(...names, `${code}\nreturn { ${returns.join(', ')} };`);
  return factory(...names.map((name) => scope[name]));
}

/** Screen state shim: setters apply immediately; refs persist across simulated renders. */
function createStore(actorRequest, { groupId = 'live-multi-1' } = {}) {
  const state = {
    batchSelectedCandidateIds: [], batchItems: [], batchItemStates: {}, batchQueueActive: false,
    batchQueueNotice: null, batchRemainingCandidateIds: [], batchSelectedItemId: null,
    savedBatchScanIds: {}, batchCommerceStatuses: {}, addAllBatchToRoom: false, savedToast: false,
  };
  const refs = {
    batchGenerationRef: { current: 1 },
    batchQueueLockRef: { current: false },
    batchActorRequestRef: { current: actorRequest },
    batchSavedIdsRef: { current: {} },
    batchSavingItemIdsRef: { current: new Set() },
    batchGroupIdRef: { current: groupId },
    batchSessionKeyRef: { current: 'live-session-1' },
    batchCommerceFlightsRef: { current: new Map() },
    batchCommerceAttemptedRef: { current: new Set() },
    attachedBatchPurchaseOptionsRef: { current: new Set() },
  };
  const setters = {};
  for (const key of Object.keys(state)) {
    const name = `set${key[0].toUpperCase()}${key.slice(1)}`;
    setters[name] = (value) => { state[key] = typeof value === 'function' ? value(state[key]) : value; };
  }
  return { state, refs, setters };
}

// ── Real library over an in-memory filesystem ───────────────────────────────

function createMemoryFs() {
  const files = new Map();
  return {
    files,
    api: {
      documentDirectory: '/doc/',
      EncodingType: { UTF8: 'utf8' },
      async makeDirectoryAsync() {},
      async getInfoAsync(p) { return { exists: files.has(p) }; },
      async readAsStringAsync(p) { if (!files.has(p)) throw new Error(`ENOENT ${p}`); return files.get(p); },
      async writeAsStringAsync(p, contents) { files.set(p, contents); },
      async moveAsync({ from, to }) { files.set(to, files.get(from) ?? `bytes(${from})`); files.delete(from); },
      async deleteAsync(p) { files.delete(p); },
    },
  };
}

function loadLibrary(actor) {
  const memfs = createMemoryFs();
  // The real offer normalizer (a pure module): saved offers are filtered exactly as the app filters them.
  const dressingRoomCommerce = createGraph({ stubs: {} }).load('services/dressingRoomCommerce.ts');
  const compile = (rel) => ts.transpileModule(fs.readFileSync(path.join(ROOT, rel), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true, allowJs: true },
  }).outputText;
  const shim = (spec) => {
    if (spec === 'expo-file-system/legacy') return memfs.api;
    if (spec === 'expo-image-manipulator') {
      return { SaveFormat: { JPEG: 'jpeg' }, manipulateAsync: async (uri) => ({ uri: `${uri}#tmp${Math.random()}` }) };
    }
    if (spec === './savedScansCloud') return { saveScanToCloud: async () => ({ ok: true }), softDeleteCloudSavedScan: async () => ({ ok: true }) };
    if (spec === './identificationSnapshot') {
      return {
        hydrateScanHistory: (raw, hydrateOne) => {
          const records = [];
          for (const record of Array.isArray(raw) ? raw : []) { const hydrated = hydrateOne(record); if (hydrated) records.push(hydrated); }
          return { records, corruptedCount: 0 };
        },
      };
    }
    if (spec === './dressingRoomCommerce') return dressingRoomCommerce;
    if (spec === './actorContext') return actor;
    return {};
  };
  const mod = { exports: {} };
  vm.runInThisContext(`(function (exports, module, require) {\n${compile('services/library.js')}\n})`, { filename: 'services/library.js' })(mod.exports, mod, shim);
  return { library: mod.exports, memfs };
}

// ── Mount ───────────────────────────────────────────────────────────────────

function mountLive({ edge, prepared, actorId = 'actor-a', flags = {} }) {
  const privacy = createGraph({ stubs: {} }).load('services/privacyImageSanitizer.js');
  const commerceClient = createGraph({ stubs: { 'services/supabaseClient': { supabase: edge.supabase } } })
    .load('services/commerceHydration.ts');
  const m = mountUseKScan({
    actorId,
    flags,
    stubs: {
      'services/supabaseClient': { supabase: edge.supabase },
      'services/imageUtils': {
        compressForUpload: async (uri) => {
          const data = prepared.get(uri);
          if (!data) throw new Error(`no prepared fixture bytes for ${uri}`);
          return data;
        },
      },
      'services/privacyImageSanitizer': privacy,
      'services/commerceHydration': commerceClient,
    },
  });
  return { m, privacy, commerceClient };
}

/** One simulated screen render: fresh closures over the current state, persistent refs. */
function createScreen({ m, store, library, commerceClient }) {
  const batchCommerce = createGraph({ stubs: {} }).load('services/batchCommerceSelection.js');
  const effects = [];

  function render() {
    effects.length = 0;
    const common = {
      useCallback: (fn) => fn,
      useEffect: (fn) => { effects.push(fn); },
      eligibleBatchSession: true,
      isActorRequestCurrent: m.actor.isActorRequestCurrent,
      ...store.refs,
      ...store.setters,
      batchSelectedCandidateIds: store.state.batchSelectedCandidateIds,
      batchItemStates: store.state.batchItemStates,
      batchItems: store.state.batchItems,
      batchQueueActive: store.state.batchQueueActive,
      batchRemainingCandidateIds: store.state.batchRemainingCandidateIds,
      savedBatchScanIds: store.state.savedBatchScanIds,
      selectedImages: m.hook.selectedImages,
    };
    const queue = evaluate(REGIONS.queue(), {
      ...common,
      analyzeSelectedCandidates: (...args) => m.hook.analyzeSelectedCandidates(...args),
    }, ['runBatchQueue', 'resumeBatchQueue']);
    const persist = evaluate(REGIONS.persist(), { ...common, saveScan: library.saveScan }, ['persistBatchItem', 'saveAllBatchItems']);
    const commerceFns = evaluate(REGIONS.commerce(), {
      ...common,
      fetchDeferredCommerce: commerceClient.fetchDeferredCommerce,
      hydrateSelectedBatchCommerce: batchCommerce.hydrateSelectedBatchCommerce,
    }, ['hydrateBatchCommerceForItem']);
    // The two effects, executed as the real source writes them.
    const dispatchEffectFactory = evaluate(
      `${REGIONS.commerceDispatchEffect()}`,
      { ...common, hydrateBatchCommerceForItem: commerceFns.hydrateBatchCommerceForItem },
      [],
    );
    void dispatchEffectFactory;
    const dispatchEffect = effects[effects.length - 1];
    const attachScope = {
      ...common,
      selectPurchaseOptionsSnapshot: library.selectPurchaseOptionsSnapshot,
      purchaseOptionsFingerprint: library.purchaseOptionsFingerprint,
      attachScanPurchaseOptions: library.attachScanPurchaseOptions,
    };
    effects.length = 0;
    evaluate(REGIONS.attachEffect(), attachScope, []);
    const attachEffect = effects[effects.length - 1];
    return { ...queue, ...persist, ...commerceFns, dispatchEffect, attachEffect };
  }

  return { render, store };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, { timeoutMs = 60_000, stepMs = 25, idle = null } = {}) {
  const started = Date.now();
  for (;;) {
    if (idle) await idle();
    if (predicate()) return true;
    if (Date.now() - started > timeoutMs) return false;
    await sleep(stepMs);
  }
}

module.exports = {
  KitMarkerError,
  REGIONS,
  createMemoryFs,
  createScreen,
  createStore,
  evaluate,
  loadLibrary,
  mountLive,
  sleep,
  waitFor,
};
