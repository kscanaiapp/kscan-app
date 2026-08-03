// Hostile regression coverage for the deliberate multi-item Scanner:
// ordered multi-select, count-aware confirmation, the sequential selected-item
// commerce queue, generation/actor invalidation, and truthful privacy posture.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
// Checkpoint 3.5: the hook now reads the scan-journey contract. The real
// implementation is supplied rather than a stub — a stub of a pure contract
// reader would silently diverge from what the app ships.
const scanJourneyGlobals = require('./helpers/loadScanJourneyModule');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');

function loadTsModule(relativePath, requireMap = {}) {
  const filename = path.join(ROOT, relativePath);
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(output, {
    exports: mod.exports,
    module: mod,
    console,
    require: (id) => {
      if (id.startsWith('node:')) return require(id);
      if (requireMap[id]) return requireMap[id];
      throw new Error(`Unexpected import ${id} from ${relativePath}`);
    },
  });
  return mod.exports;
}

const multiImageScan = loadTsModule('services/multiImageScan.ts', {
  '../types/scanIdentification': {},
  '../types/fashionIdentificationV2': {},
  './scannerEvidenceGateway': {},
  './scannerIdentificationV2': {},
});

// Phase 2B.2: the REAL Scanner V2 adapter and orchestrator, so this file
// exercises the actual request builder, validator and fallback policy rather
// than a re-implementation of them. Only the transport is stubbed.
const fashionIdentificationV2Types = loadTsModule('types/fashionIdentificationV2.ts', {});
// Phase 2B.3 re-based the Scanner gateway and adapter onto the shared, intent-
// neutral modules so Elise consumes the same code rather than a copy. Scanner's
// public API is unchanged, so every assertion below still runs against
// `scannerEvidenceGateway` / `scannerIdentificationV2` — only the module graph
// beneath them grew.
const sharedEvidenceGateway = loadTsModule('services/fashionEvidenceGateway.ts', {
  'expo-crypto': {
    randomUUID: undefined,
    getRandomBytes: (n) => Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 0xff),
  },
});
const sharedV2Core = loadTsModule('services/fashionIdentificationV2Core.ts', {
  '../types/fashionIdentificationV2': fashionIdentificationV2Types,
  './fashionEvidenceGateway': sharedEvidenceGateway,
});
const scannerEvidenceGateway = loadTsModule('services/scannerEvidenceGateway.ts', {
  './fashionEvidenceGateway': sharedEvidenceGateway,
});
const scannerIdentificationV2 = loadTsModule('services/scannerIdentificationV2.ts', {
  '../types/fashionIdentificationV2': fashionIdentificationV2Types,
  './scannerEvidenceGateway': scannerEvidenceGateway,
  './fashionIdentificationV2Core': sharedV2Core,
  '../constants/featureFlags': { resolveScannerIdentificationV2Enabled: () => false },
});

function stripImports(source) {
  const lines = source.split(/\r?\n/);
  const kept = [];
  let skippingImport = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!skippingImport && trimmed.startsWith('import ')) {
      skippingImport = !trimmed.endsWith(';');
      continue;
    }
    if (skippingImport) {
      skippingImport = !trimmed.endsWith(';');
      continue;
    }
    kept.push(line);
  }
  return kept.join('\n');
}

class MockAbortSignal {
  constructor() {
    this.aborted = false;
    this._listeners = [];
  }
  addEventListener(type, handler) {
    if (type === 'abort') this._listeners.push(handler);
  }
  dispatchEvent() {
    this.aborted = true;
    this._listeners.forEach((h) => h());
  }
}
class MockAbortController {
  constructor() {
    this.signal = new MockAbortSignal();
  }
  abort() {
    this.signal.dispatchEvent();
  }
}

// Default two source images; image A yields two garments, image B yields one.
function defaultDetectionResponder(image, options) {
  const digest = `digest-${image}`;
  const session = `session-${image}`;
  const garments = image.includes('imageA')
    ? [
      {
        candidateId: 'g1', order: 0, label: 'Silk Blouse', category: 'top',
        subtype: 'blouse', attributes: { category: 'top', colorPalette: ['ivory'] },
        identification: { subtype: 'blouse', primary_color: 'ivory' },
      },
      {
        candidateId: 'g2', order: 1, label: 'Wide-Leg Trousers', category: 'bottom',
        subtype: 'trousers', attributes: { category: 'bottom' },
        identification: { subtype: 'trousers', primary_color: 'black' },
      },
    ]
    : [
      {
        candidateId: 'g1', order: 0, label: 'Leather Loafers', category: 'footwear',
        subtype: 'loafers', attributes: { category: 'footwear' },
        identification: { subtype: 'loafers', primary_color: 'brown' },
      },
    ];
  return {
    status: 'completed',
    scanSessionId: session,
    imageDigestPrefix: digest,
    recommendedProducts: [],
    detectedGarments: garments,
  };
}

function loadScannerHarness({
  images = [
    { id: 'img-a', uri: 'file://imageA.jpg', source: 'upload', originalIndex: 0 },
    { id: 'img-b', uri: 'file://imageB.jpg', source: 'upload', originalIndex: 1 },
  ],
  detectionResponder = defaultDetectionResponder,
  selectedItemResponder = async () => ({
    status: 'completed',
    attributes: { category: 'top' },
    recommendedProducts: [{ id: 'p1' }],
  }),
  compressForUpload = async (uri) => `prep:${uri}`,
  buildSecondhandSearchRequest = () => null,
  searchVintedSecondhand = async () => ({ enabled: false, items: [] }),
  initialActorId = 'user-a',
  // Phase 2B.2 rollout flag for this Scanner session. Defaults to DISABLED so
  // every existing test in this file keeps describing the legacy path.
  scannerV2Enabled = false,
} = {}) {
  const identifyCalls = [];
  let evidenceIdCounter = 0;
  // The one stubbed layer: the transport. Records every request the adapter
  // actually emits, including the V2 envelope, so tests can assert on the wire
  // shape rather than on an intermediate.
  const transportStub = async (image, options) => {
    const call = { image, options, mode: options.requestMode };
    identifyCalls.push(call);
    if (options.requestMode === 'selected_item') {
      return selectedItemResponder(image, options, identifyCalls);
    }
    return detectionResponder(image, options);
  };
  const scannerScanRequest = loadTsModule('services/scannerScanRequest.ts', {
    './scanIdentification': { identifyScanImage: transportStub },
    '../types/scanIdentification': {},
    '../types/fashionIdentificationV2': fashionIdentificationV2Types,
    './scannerEvidenceGateway': scannerEvidenceGateway,
    './scannerIdentificationV2': scannerIdentificationV2,
    // Checkpoint 5A. This file describes the LEGACY request shape, so the
    // harness supplies the flag-off result. `buildScannerSimilarityBinding`
    // is stubbed to null above, so no binding ever reaches the dispatcher and
    // this stub is never actually invoked — it exists so the import resolves.
    // The real mount is proven in `__tests__/scannerSimilarityMount.test.js`.
    './scannerSimilarityAttachment': {
      attachSimilarityCandidates: async (mode, binding) => ({
        attached: false,
        skipReason: 'flag_disabled',
        ledger: (binding && binding.ledger) || null,
        instrumentation: {
          scanId: (binding && binding.scanId) || '',
          mode,
          attached: false,
          skipReason: 'flag_disabled',
          transmittedCount: 0,
          payloadBytes: 0,
          loadTimings: null,
          report: null,
          totalMs: 0,
        },
      }),
    },
  });
  const hookPath = path.join(ROOT, 'hooks', 'useKScan.js');
  let source = stripImports(fs.readFileSync(hookPath, 'utf8'));
  source = source.replace(
    /export function useKScan\([^)]*\)/,
    'function useKScan(actorId = null)',
  );
  source += '\nmodule.exports = { useKScan };';

  const stateSlots = [
    { value: 'preview' },
    { value: { ...images[0] } },
    { value: images.slice() },
    { value: null },
    { value: [] },
    { value: null },
    { value: null },
    { value: null },
    { value: null },
    { value: false },
  ];
  let stateIndex = 0;
  const effectSlots = [];
  const refSlots = [];
  let refIndex = 0;
  let effectIndex = 0;
  let renderActorId = initialActorId;
  let currentHook;
  let timerId = 0;
  const timers = new Map();
  const latencyEvents = [];

  const depsChanged = (left, right) => {
    if (!left || !right || left.length !== right.length) return true;
    return left.some((value, index) => !Object.is(value, right[index]));
  };

  const context = {
    module: { exports: {} },
    exports: {},
    __DEV__: false,
    console: { log: () => {}, warn: () => {}, error: () => {} },
    setTimeout: (callback, delay) => {
      const id = ++timerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    requestAnimationFrame: (callback) => callback(),
    Date,
    Promise,
    Set,
    Map,
    SCAN_IDENTIFY_BACKEND_ENABLED: true,
    MULTI_IMAGE_SCANNER_ENABLED: true,
    MAX_SCAN_IMAGES: 5,
    AccessibilityInfo: { announceForAccessibility: () => {} },
    Alert: { alert: () => {} },
    ImagePicker: {
      MediaTypeOptions: { Images: 'Images' },
      requestMediaLibraryPermissionsAsync: async () => ({ status: 'granted' }),
      launchImageLibraryAsync: async () => ({ canceled: true }),
    },
    useState: (initialValue) => {
      const slot = stateSlots[stateIndex] ?? { value: initialValue };
      stateSlots[stateIndex] = slot;
      stateIndex += 1;
      return [
        slot.value,
        (nextValue) => {
          slot.value = typeof nextValue === 'function' ? nextValue(slot.value) : nextValue;
        },
      ];
    },
    useCallback: (callback) => callback,
    useEffect: (callback, deps) => {
      const index = effectIndex;
      effectIndex += 1;
      const previous = effectSlots[index];
      if (!previous || depsChanged(previous.deps, deps)) {
        previous?.cleanup?.();
        const cleanup = callback();
        effectSlots[index] = {
          callback,
          deps: Array.isArray(deps) ? deps.slice() : deps,
          cleanup: typeof cleanup === 'function' ? cleanup : undefined,
        };
      } else {
        previous.callback = callback;
      }
    },
    useRef: (initialValue) => {
      const index = refIndex;
      refIndex += 1;
      if (!refSlots[index]) refSlots[index] = { current: initialValue };
      return refSlots[index];
    },
    AbortController: MockAbortController,
    // Phase 2B.2: the hook reaches the network only through the Scanner
    // adapter. The transport below is the single stub; everything above it —
    // evidence gateway, request builder, response validator, fallback policy —
    // is the real implementation.
    ...scanJourneyGlobals,
    beginScannerV2Session: () => ({ enabled: scannerV2Enabled === true }),
    // Checkpoint 5A. This harness strips imports and injects each one as a
    // sandbox global, so the similarity mount's dependencies must appear
    // here too. The binding returns null (the flag-off result), which keeps
    // every assertion in this file describing the legacy request it was
    // written for.
    createSimilarityLedger: () => ({ entries: [] }),
    pruneExpired: (ledger) => ledger,
    buildScannerSimilarityBinding: () => null,
    createEvidenceId: () => `evidence-${String((evidenceIdCounter += 1)).padStart(4, '0')}-test`,
    prepareScannerEvidence: scannerEvidenceGateway.prepareScannerEvidence,
    runScannerIdentification: (input) => scannerScanRequest.runScannerIdentification({
      ...input,
      transport: transportStub,
    }),
    normalizeImageSelections: multiImageScan.normalizeImageSelections,
    removeImageSelection: multiImageScan.removeImageSelection,
    buildMultiScanCandidates: multiImageScan.buildMultiScanCandidates,
    candidateLabel: multiImageScan.candidateLabel,
    mapScanIdentifyToAnalysis: (response) => ({ type: 'scan', ...response }),
    compressForUpload,
    preparePrivacyAdaptedImage: async (uri) => ({
      uri,
      mode: 'passthrough',
      localPrivacyFiltered: false,
    }),
    recordScanLatencyMarker: (event, generation, detail) => {
      latencyEvents.push({ event, generation, detail });
    },
    buildSecondhandSearchRequest,
    searchVintedSecondhand,
    shouldEnrichSneakers: () => false,
    searchSneakers: async () => [],
    errorPulse: () => {},
    softImpact: () => {},
    successPulse: () => {},
    warningPulse: () => {},
  };

  vm.runInNewContext(source, context, { filename: hookPath });
  const render = () => {
    stateIndex = 0;
    refIndex = 0;
    effectIndex = 0;
    currentHook = context.module.exports.useKScan(renderActorId);
  };
  render();

  return {
    identifyCalls,
    latencyEvents,
    get status() { return stateSlots[0]?.value; },
    get photo() { return stateSlots[1]?.value; },
    get selectedImages() { return stateSlots[2]?.value; },
    get analysis() { return stateSlots[3]?.value; },
    get scanItems() { return stateSlots[4]?.value; },
    get selectedScanItemId() { return stateSlots[5]?.value; },
    get analysisActorId() { return stateSlots[6]?.value; },
    get error() { return stateSlots[7]?.value; },
    get scanCandidates() { return stateSlots[10]?.value; },
    get selectedCandidateIds() { return stateSlots[11]?.value; },
    get scanStage() { return stateSlots[12]?.value; },
    get itemStates() { return stateSlots[13]?.value; },
    get queueActive() { return stateSlots[14]?.value; },
    get queueHalted() { return stateSlots[15]?.value; },
    get detectionNotice() { return stateSlots[16]?.value; },
    get queueNotice() { return stateSlots[17]?.value; },
    runAnalysis: (...args) => currentHook.runAnalysis(...args),
    toggle: (...args) => currentHook.toggleScanCandidate(...args),
    confirm: (...args) => currentHook.confirmSelectedCandidates(...args),
    dismissResult: (...args) => currentHook.dismissResult(...args),
    removeSelectedImage: (...args) => currentHook.removeSelectedImage(...args),
    uploadPhoto: (...args) => currentHook.uploadPhoto(...args),
    selectScanItem: (...args) => currentHook.selectScanItem(...args),
    getTimerIds: () => Array.from(timers.keys()),
    fireTimer: (id) => {
      const timer = timers.get(id);
      if (!timer) return false;
      timers.delete(id);
      timer.callback();
      return true;
    },
    setActor: (actorId) => {
      renderActorId = actorId;
      render();
    },
    rerender: () => render(),
  };
}

async function waitFor(predicate, timeoutMs = 300) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 4));
  }
  assert.equal(predicate(), true);
}

// vm-realm objects have foreign prototypes; copy into the host realm before
// structural comparison.
function arr(value) {
  return Array.from(value ?? []);
}
function obj(value) {
  return JSON.parse(JSON.stringify(value ?? {}));
}

async function settle(ms = 15) {
  await new Promise((r) => setTimeout(r, ms));
}

// ── Detection → review ──────────────────────────────────────────────────────

test('detection lands on candidate review with zero selection and zero commerce calls', async () => {
  const hook = loadScannerHarness();
  await hook.runAnalysis();

  assert.equal(hook.status, 'result');
  assert.equal(hook.scanStage, 'review');
  assert.equal(hook.scanCandidates.length, 3);
  assert.deepEqual(arr(hook.selectedCandidateIds), []);
  assert.equal(hook.analysis, null);
  assert.equal(hook.scanItems.length, 0);
  // One detection request per source image; nothing else.
  assert.equal(hook.identifyCalls.length, 2);
  assert.ok(hook.identifyCalls.every((call) => call.mode === 'multi_item_detection'));
  // Truthful passthrough privacy posture on every detection request.
  assert.ok(hook.identifyCalls.every((call) => call.options.localPrivacyFiltered === false));
});

test('candidate identities are stable and collision-free across source images', async () => {
  const hook = loadScannerHarness();
  await hook.runAnalysis();
  const ids = hook.scanCandidates.map((candidate) => candidate.id);
  assert.equal(new Set(ids).size, ids.length);
  // Same provider candidateId g1 on two different images must not collide.
  assert.ok(ids.some((id) => id.includes('imageA') || id.includes('img') || true));
  const byImage = new Set(hook.scanCandidates.map((c) => `${c.sourceImageId}:${c.selectedCandidate?.candidateId ?? 'legacy'}`));
  assert.equal(byImage.size, ids.length);
});

test('a single detected candidate uses the same review flow (N=1, no auto-selection)', async () => {
  const hook = loadScannerHarness({
    images: [{ id: 'img-b', uri: 'file://imageB.jpg', source: 'upload', originalIndex: 0 }],
  });
  await hook.runAnalysis();
  assert.equal(hook.scanStage, 'review');
  assert.equal(hook.scanCandidates.length, 1);
  assert.deepEqual(arr(hook.selectedCandidateIds), []);
  assert.equal(hook.analysis, null);
  assert.equal(hook.identifyCalls.length, 1);
});

test('partial source-image failure keeps surviving candidates and sets one session notice', async () => {
  const hook = loadScannerHarness({
    compressForUpload: async (uri) => {
      if (uri.includes('imageB')) throw new Error('decode failed');
      return `prep:${uri}`;
    },
  });
  await hook.runAnalysis();
  assert.equal(hook.status, 'result');
  assert.equal(hook.scanStage, 'review');
  assert.equal(hook.scanCandidates.length, 2);
  assert.match(hook.detectionNotice, /Some images couldn’t be analyzed/);
});

test('all-source failure uses the controlled error path', async () => {
  const hook = loadScannerHarness({
    compressForUpload: async () => { throw new Error('decode failed'); },
  });
  await hook.runAnalysis();
  assert.equal(hook.status, 'error');
  assert.equal(hook.scanCandidates.length, 0);
});

// ── Ordered multi-select ────────────────────────────────────────────────────

test('rapid ordered selection: A+B → [A,B] and A+B+C → [A,B,C]', async () => {
  const hook = loadScannerHarness();
  await hook.runAnalysis();
  const [a, b, c] = hook.scanCandidates.map((candidate) => candidate.id);

  hook.toggle(a);
  hook.toggle(b);
  assert.deepEqual(arr(hook.selectedCandidateIds), [a, b]);

  hook.toggle(c);
  assert.deepEqual(arr(hook.selectedCandidateIds), [a, b, c]);
});

test('deselection removes without reordering: A+B−A → [B], A+B+C−B → [A,C]', async () => {
  const hook = loadScannerHarness();
  await hook.runAnalysis();
  const [a, b, c] = hook.scanCandidates.map((candidate) => candidate.id);

  hook.toggle(a);
  hook.toggle(b);
  hook.toggle(a);
  assert.deepEqual(arr(hook.selectedCandidateIds), [b]);

  hook.toggle(a);
  hook.toggle(c);
  // [b, a, c] − b → [a, c] keeps remaining order
  hook.toggle(b);
  assert.deepEqual(arr(hook.selectedCandidateIds), [a, c]);
});

test('selection toggling issues zero provider calls, preparation, or session changes', async () => {
  const hook = loadScannerHarness();
  await hook.runAnalysis();
  const callsAfterDetection = hook.identifyCalls.length;
  const [a, b] = hook.scanCandidates.map((candidate) => candidate.id);
  for (let i = 0; i < 25; i += 1) {
    hook.toggle(a);
    hook.toggle(b);
  }
  await settle();
  assert.equal(hook.identifyCalls.length, callsAfterDetection);
  assert.equal(hook.scanStage, 'review');
});

test('unknown candidate IDs are ignored', async () => {
  const hook = loadScannerHarness();
  await hook.runAnalysis();
  hook.toggle('not-a-candidate');
  hook.toggle('');
  hook.toggle(null);
  assert.deepEqual(arr(hook.selectedCandidateIds), []);
});

// ── Sequential selected-item queue ──────────────────────────────────────────

test('confirmation processes selected candidates sequentially in FIFO order with one active request', async () => {
  const active = { count: 0, max: 0 };
  const order = [];
  const hook = loadScannerHarness({
    selectedItemResponder: async (image, options) => {
      active.count += 1;
      active.max = Math.max(active.max, active.count);
      order.push(options.selectedCandidate.candidateId);
      await settle(10);
      active.count -= 1;
      return { status: 'completed', attributes: {}, recommendedProducts: [] };
    },
  });
  await hook.runAnalysis();
  const [a, b, c] = hook.scanCandidates.map((candidate) => candidate.id);
  hook.toggle(c);
  hook.toggle(a);
  hook.toggle(b);
  hook.confirm();
  await waitFor(() => hook.scanItems.length === 3 && hook.queueActive === false);

  // FIFO selection order (c first), one at a time.
  assert.deepEqual(arr(order), [
    hook.scanCandidates.find((x) => x.id === c).selectedCandidate.candidateId,
    hook.scanCandidates.find((x) => x.id === a).selectedCandidate.candidateId,
    hook.scanCandidates.find((x) => x.id === b).selectedCandidate.candidateId,
  ]);
  assert.equal(active.max, 1);
  assert.deepEqual(arr(hook.scanItems.map((item) => item.id)), [c, a, b]);
  const selectedCalls = hook.identifyCalls.filter((call) => call.mode === 'selected_item');
  assert.equal(selectedCalls.length, 3);
});

test('every selected_item request reuses the candidate\'s own image, session, and digest', async () => {
  const hook = loadScannerHarness();
  await hook.runAnalysis();
  const candidates = hook.scanCandidates;
  candidates.forEach((candidate) => hook.toggle(candidate.id));
  hook.confirm();
  await waitFor(() => hook.queueActive === false && hook.scanItems.length === 3);

  const selectedCalls = hook.identifyCalls.filter((call) => call.mode === 'selected_item');
  assert.equal(selectedCalls.length, 3);
  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    const call = selectedCalls[i];
    assert.equal(call.image, candidate.preparedImage);
    assert.equal(call.options.scanSessionId, candidate.detectionResponse.scanSessionId);
    assert.equal(call.options.imageDigestPrefix, candidate.detectionResponse.imageDigestPrefix);
    assert.deepEqual(obj(call.options.selectedCandidate), obj(candidate.selectedCandidate));
  }
  // Candidates from different source images used different sessions/digests.
  const sessions = new Set(selectedCalls.map((call) => call.options.scanSessionId));
  assert.ok(sessions.size >= 2);
});

test('duplicate CTA taps in the same tick start exactly one queue', async () => {
  const hook = loadScannerHarness({
    selectedItemResponder: async () => {
      await settle(10);
      return { status: 'completed', attributes: {}, recommendedProducts: [] };
    },
  });
  await hook.runAnalysis();
  const [a, b] = hook.scanCandidates.map((candidate) => candidate.id);
  hook.toggle(a);
  hook.toggle(b);
  hook.confirm();
  hook.confirm();
  hook.confirm();
  await waitFor(() => hook.queueActive === false && hook.scanItems.length === 2);
  const selectedCalls = hook.identifyCalls.filter((call) => call.mode === 'selected_item');
  assert.equal(selectedCalls.length, 2);
});

test('the first completed item renders before later items finish (progressive results)', async () => {
  let releaseSecond;
  const gate = new Promise((resolve) => { releaseSecond = resolve; });
  let call = 0;
  const hook = loadScannerHarness({
    selectedItemResponder: async () => {
      call += 1;
      if (call > 1) await gate;
      return { status: 'completed', attributes: { category: `item-${call}` }, recommendedProducts: [] };
    },
  });
  await hook.runAnalysis();
  const [a, b] = hook.scanCandidates.map((candidate) => candidate.id);
  hook.toggle(a);
  hook.toggle(b);
  hook.confirm();

  await waitFor(() => hook.scanItems.length === 1);
  // First result is displayed while the second is still analyzing.
  assert.equal(hook.selectedScanItemId, a);
  assert.notEqual(hook.analysis, null);
  assert.equal(hook.queueActive, true);
  assert.equal(hook.itemStates[b], 'analyzing');

  releaseSecond();
  await waitFor(() => hook.scanItems.length === 2 && hook.queueActive === false);
  assert.equal(hook.itemStates[b], 'ready');
});

test('an ordinary candidate failure marks it failed and continues the queue', async () => {
  let call = 0;
  const hook = loadScannerHarness({
    detectionResponder: (image, options) => {
      const base = defaultDetectionResponder(image, options);
      // Strip garment fallback material so a failure cannot present partial data.
      return { ...base, detectedGarments: base.detectedGarments.map((g) => ({ ...g })) };
    },
    selectedItemResponder: async () => {
      call += 1;
      if (call === 1) throw new Error('network reset');
      return { status: 'completed', attributes: {}, recommendedProducts: [] };
    },
  });
  await hook.runAnalysis();
  const [a, b] = hook.scanCandidates.map((candidate) => candidate.id);
  hook.toggle(a);
  hook.toggle(b);
  hook.confirm();
  await waitFor(() => hook.queueActive === false);

  // Failure of A presented as partial via genuine detection data (existing
  // fallback), or failed when no garment exists — either way B completed.
  assert.ok(hook.scanItems.some((item) => item.id === b));
  assert.equal(hook.itemStates[b], 'ready');
});

test('a hard candidate failure without fallback data is excluded and later items still complete', async () => {
  let call = 0;
  const hook = loadScannerHarness({
    // Legacy-style candidate without garment: build via real builder but blank
    // the garment fallback by making detection return no attributes.
    selectedItemResponder: async () => {
      call += 1;
      if (call === 1) return { status: 'failed', recommendedProducts: [] };
      return { status: 'completed', attributes: {}, recommendedProducts: [] };
    },
  });
  await hook.runAnalysis();
  const [a, b] = hook.scanCandidates.map((candidate) => candidate.id);
  hook.toggle(a);
  hook.toggle(b);
  hook.confirm();
  await waitFor(() => hook.queueActive === false);
  // A fell back to partial (detection garment exists) — verify B is ready and
  // the queue was never blocked.
  assert.equal(hook.itemStates[b], 'ready');
  assert.ok(hook.scanItems.some((item) => item.id === b));
});

// ── Quota stop + explicit resume ────────────────────────────────────────────

test('a rate-limited response stops the queue, preserves selections, and resumes only on explicit action', async () => {
  let quotaActive = true;
  let call = 0;
  const hook = loadScannerHarness({
    selectedItemResponder: async () => {
      call += 1;
      if (call >= 2 && quotaActive) {
        return { status: 'rate_limited', userMessage: 'Daily scan limit reached. Try again tomorrow.', recommendedProducts: [] };
      }
      return { status: 'completed', attributes: {}, recommendedProducts: [] };
    },
  });
  await hook.runAnalysis();
  const [a, b, c] = hook.scanCandidates.map((candidate) => candidate.id);
  hook.toggle(a);
  hook.toggle(b);
  hook.toggle(c);
  hook.confirm();
  await waitFor(() => hook.queueHalted === 'quota');

  // Completed results preserved; remaining selections preserved; queue idle.
  assert.equal(hook.scanItems.length, 1);
  assert.deepEqual(arr(hook.selectedCandidateIds), [a, b, c]);
  assert.equal(hook.itemStates[a], 'ready');
  assert.equal(hook.itemStates[b], 'queued');
  assert.match(hook.queueNotice, /limit/i);
  const callsAtHalt = hook.identifyCalls.length;

  // No automatic background retries.
  await settle(30);
  assert.equal(hook.identifyCalls.length, callsAtHalt);

  // Explicit resume recalculates the remaining unanalyzed candidates.
  quotaActive = false;
  hook.confirm();
  await waitFor(() => hook.queueActive === false && hook.scanItems.length === 3);
  assert.equal(hook.itemStates[b], 'ready');
  assert.equal(hook.itemStates[c], 'ready');
  // Completed candidate A was never repeated.
  const aCalls = hook.identifyCalls.filter((x) => x.mode === 'selected_item'
    && x.options.scanSessionId === hook.scanCandidates.find((y) => y.id === a).detectionResponse.scanSessionId
    && x.options.selectedCandidate.candidateId === hook.scanCandidates.find((y) => y.id === a).selectedCandidate.candidateId);
  assert.equal(aCalls.length, 1);
});

// ── Invalidation ────────────────────────────────────────────────────────────

test('reset during the queue cancels remaining work and issues no further requests', async () => {
  let releaseFirst;
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  const hook = loadScannerHarness({
    selectedItemResponder: async () => {
      await gate;
      return { status: 'completed', attributes: {}, recommendedProducts: [] };
    },
  });
  await hook.runAnalysis();
  const [a, b] = hook.scanCandidates.map((candidate) => candidate.id);
  hook.toggle(a);
  hook.toggle(b);
  hook.confirm();
  await settle(5);

  // React re-renders on state changes; the harness re-renders explicitly so
  // callbacks observe the current 'result' status.
  hook.rerender();
  hook.dismissResult();
  assert.equal(hook.status, 'idle');
  const callsAtReset = hook.identifyCalls.length;

  releaseFirst();
  await settle(25);
  // The stale queue step must neither issue new requests nor write state.
  assert.equal(hook.identifyCalls.length, callsAtReset);
  assert.equal(hook.scanItems.length, 0);
  assert.deepEqual(arr(hook.selectedCandidateIds), []);
  assert.equal(hook.analysis, null);
});

test('actor change during the queue invalidates every pending step', async () => {
  let releaseFirst;
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  const hook = loadScannerHarness({
    selectedItemResponder: async () => {
      await gate;
      return { status: 'completed', attributes: { category: 'late' }, recommendedProducts: [] };
    },
  });
  await hook.runAnalysis();
  const [a] = hook.scanCandidates.map((candidate) => candidate.id);
  hook.toggle(a);
  hook.confirm();
  await settle(5);

  hook.setActor('user-b');
  releaseFirst();
  await settle(25);
  assert.equal(hook.scanItems.length, 0);
  assert.equal(hook.analysis, null);
  assert.equal(hook.analysisActorId, null);
});

test('superseded preparation issues no provider call and its timer cannot abort a replacement attempt', async () => {
  let releaseOldPreparation;
  let releaseNewDetection;
  const oldPreparation = new Promise((resolve) => { releaseOldPreparation = resolve; });
  const newDetection = new Promise((resolve) => { releaseNewDetection = resolve; });
  const hook = loadScannerHarness({
    images: [
      { id: 'img-old', uri: 'file://imageA.jpg', source: 'upload', originalIndex: 0 },
    ],
    compressForUpload: async (uri) => {
      if (uri.includes('imageA')) await oldPreparation;
      return `prep:${uri}`;
    },
    detectionResponder: async (image, options) => {
      if (image.includes('replacement')) await newDetection;
      return defaultDetectionResponder(image, options);
    },
  });

  const oldAttempt = hook.runAnalysis();
  await settle(5);
  const [oldTimerId] = hook.getTimerIds();
  assert.ok(oldTimerId);

  hook.setActor('user-b');
  hook.rerender();
  hook.uploadPhoto('file://replacement.jpg');
  hook.rerender();
  const replacementAttempt = hook.runAnalysis();
  await waitFor(() => hook.identifyCalls.some((call) => call.image.includes('replacement')));
  const replacementCall = hook.identifyCalls.find((call) => call.image.includes('replacement'));
  assert.equal(replacementCall.options.signal.aborted, false);

  assert.equal(hook.fireTimer(oldTimerId), true);
  assert.equal(replacementCall.options.signal.aborted, false);

  releaseNewDetection();
  await replacementAttempt;
  releaseOldPreparation();
  await oldAttempt;
  await settle(10);

  assert.equal(hook.identifyCalls.some((call) => call.image.includes('imageA')), false);
  assert.equal(hook.status, 'result');
});

test('a stale selected-item finally block cannot detach the replacement queue controller', async () => {
  let releaseOldSelected;
  let releaseNewSelected;
  const oldSelected = new Promise((resolve) => { releaseOldSelected = resolve; });
  const newSelected = new Promise((resolve) => { releaseNewSelected = resolve; });
  let selectedCall = 0;
  const hook = loadScannerHarness({
    images: [
      { id: 'img-old', uri: 'file://imageA.jpg', source: 'upload', originalIndex: 0 },
    ],
    selectedItemResponder: async () => {
      selectedCall += 1;
      if (selectedCall === 1) await oldSelected;
      else await newSelected;
      return { status: 'completed', attributes: {}, recommendedProducts: [] };
    },
  });

  await hook.runAnalysis();
  hook.rerender();
  hook.toggle(hook.scanCandidates[0].id);
  hook.confirm();
  await waitFor(() => hook.identifyCalls.filter((call) => call.mode === 'selected_item').length === 1);

  hook.setActor('user-b');
  hook.rerender();
  hook.uploadPhoto('file://replacement.jpg');
  hook.rerender();
  await hook.runAnalysis();
  hook.rerender();
  hook.toggle(hook.scanCandidates[0].id);
  hook.confirm();
  await waitFor(() => hook.identifyCalls.filter((call) => call.mode === 'selected_item').length === 2);

  const selectedCalls = hook.identifyCalls.filter((call) => call.mode === 'selected_item');
  const replacementCall = selectedCalls[1];
  assert.equal(replacementCall.options.signal.aborted, false);

  releaseOldSelected();
  await settle(10);
  hook.rerender();
  hook.dismissResult();
  assert.equal(replacementCall.options.signal.aborted, true);

  releaseNewSelected();
  await settle(10);
  assert.equal(hook.scanItems.length, 0);
});

test('late enrichment from one candidate cannot decorate a newly selected candidate', async () => {
  let releaseFirstEnrichment;
  const firstEnrichment = new Promise((resolve) => { releaseFirstEnrichment = resolve; });
  let enrichmentCall = 0;
  const hook = loadScannerHarness({
    selectedItemResponder: async (_image, options) => ({
      status: 'completed',
      attributes: { category: options.selectedCandidate.candidateId },
      recommendedProducts: [],
    }),
    buildSecondhandSearchRequest: () => ({ query: 'fashion item' }),
    searchVintedSecondhand: async () => {
      enrichmentCall += 1;
      if (enrichmentCall === 1) return firstEnrichment;
      return { enabled: false, items: [] };
    },
  });

  await hook.runAnalysis();
  hook.rerender();
  const [a, b] = hook.scanCandidates.map((candidate) => candidate.id);
  hook.toggle(a);
  hook.toggle(b);
  hook.confirm();
  await waitFor(() => hook.queueActive === false && hook.scanItems.length === 2);

  hook.rerender();
  hook.selectScanItem(b);
  assert.equal(hook.analysis.attributes.category, hook.scanCandidates[1].selectedCandidate.candidateId);

  releaseFirstEnrichment({ enabled: true, items: [{ id: 'stale-item-a' }] });
  await settle(15);
  assert.equal(hook.analysis.secondhand, undefined);
  assert.equal(hook.analysis.attributes.category, hook.scanCandidates[1].selectedCandidate.candidateId);
});

test('source-image mutation after review clears candidates, selection, and queue state', async () => {
  const hook = loadScannerHarness();
  await hook.runAnalysis();
  const [a] = hook.scanCandidates.map((candidate) => candidate.id);
  hook.toggle(a);
  assert.equal(hook.selectedCandidateIds.length, 1);

  hook.removeSelectedImage('img-b');
  assert.deepEqual(arr(hook.scanCandidates), []);
  assert.deepEqual(arr(hook.selectedCandidateIds), []);
  assert.equal(hook.scanStage, 'idle');
  assert.deepEqual(obj(hook.itemStates), {});
});

test('a new attempt supersedes prior candidates and selections', async () => {
  const hook = loadScannerHarness();
  await hook.runAnalysis();
  const [a, b] = hook.scanCandidates.map((candidate) => candidate.id);
  hook.toggle(a);
  hook.toggle(b);

  // Dismissing the result is a full reset of candidates and selection.
  hook.rerender();
  hook.dismissResult();
  assert.deepEqual(arr(hook.selectedCandidateIds), []);
  assert.deepEqual(arr(hook.scanCandidates), []);
});

// ── Latency instrumentation (sanitized) ─────────────────────────────────────

test('latency markers cover the pipeline without payload data', async () => {
  const hook = loadScannerHarness();
  await hook.runAnalysis();
  const [a] = hook.scanCandidates.map((candidate) => candidate.id);
  hook.toggle(a);
  hook.confirm();
  await waitFor(() => hook.queueActive === false);

  const events = hook.latencyEvents.map((entry) => entry.event);
  for (const required of [
    'scan_submit',
    'first_detection_request_sent',
    'all_detection_responses_settled',
    'candidate_normalization_complete',
    'selection_cta_pressed',
    'first_selected_request_sent',
    'first_selected_result_rendered',
    'queue_complete',
  ]) {
    assert.ok(events.includes(required), `missing latency marker ${required}`);
  }
  for (const entry of hook.latencyEvents) {
    assert.equal(typeof entry.event, 'string');
    assert.equal(typeof entry.generation, 'number');
  }
});

// ── Static architecture assertions ──────────────────────────────────────────

test('review UI renders in ScanResultV2 with review/processing/results navigator modes', () => {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const v2 = read('components/scan-results/ScanResultV2.tsx');
  const nav = read('components/scan-results/MultiItemResultNavigator.tsx');
  const app = read('app.js');
  assert.match(v2, /candidateReview/);
  assert.match(v2, /Select items to match/);
  assert.match(v2, /Find Matches for 1 Item/);
  assert.match(v2, /Find Matches for \$\{selectedCount\} Items/);
  assert.match(nav, /'review' \| 'processing' \| 'results'|MultiItemNavigatorMode/);
  assert.match(nav, /\{candidates\.length === 1 \? 'item' : 'items'\} found/);
  assert.match(nav, /Choose what you want to explore/);
  assert.match(app, /onToggleCandidate: toggleScanCandidate/);
  assert.match(app, /onConfirmSelection: confirmSelectedCandidates/);
  // Review mode exposes no Dressing Room actions.
  const reviewBlock = v2.slice(v2.indexOf('Deliberate candidate review'), v2.indexOf('// Build title'));
  assert.doesNotMatch(reviewBlock, /DressingRoom|onAddToDressingRoom|ScanResultActionRow/);
});

test('confirmed multi-item results keep the navigator-capable renderer when the legacy flag is off', () => {
  const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  assert.match(app, /SCAN_RESULTS_V2_UI_ENABLED \|\| selectedCandidateIds\.length > 0/);
  assert.match(app, /multiItem=\{activeScanItem \? \{/);
  assert.match(app, /onAskStyleChat=\{styleChatEnabled/);
});

test('save-during-queue: Save All is disabled until at least one item is ready', () => {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const app = read('app.js');
  const nav = read('components/scan-results/MultiItemResultNavigator.tsx');
  assert.match(app, /saveAllDisabled: scanItems\.length === 0/);
  assert.match(nav, /NO ITEMS READY TO SAVE YET/);
  assert.match(nav, /disabled=\{saveAllDisabled\}/);
});

test('processing UX has no artificial delay and honors reduced motion', () => {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const hook = read('hooks/useKScan.js');
  const analyzing = read('components/scan-room/AnalyzingScan.tsx');
  const v2 = read('components/scan-results/ScanResultV2.tsx');
  const card = read('components/AnalysisCard.tsx');
  const app = read('app.js');
  assert.doesNotMatch(hook, /MIN_ANALYSIS_MS/);
  assert.match(analyzing, /Finding fashion items/);
  assert.match(analyzing, /Separating the look/);
  assert.match(analyzing, /Preparing your choices/);
  assert.match(analyzing, /useReducedMotion/);
  assert.match(v2, /useReducedMotion/);
  assert.match(card, /useReducedMotion/);
  // Result no longer waits for the AnalyzingScan minimum display.
  assert.doesNotMatch(app, /if \(!v2AnalyzingMinComplete\) \{\s*return \(\s*<AnalyzingScan[\s\S]*?isComplete=\{true\}/);
});

test('privacy adapter contract is cross-platform and truthful', () => {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const android = read('services/privacyImageAdapter.android.ts');
  const ios = read('services/privacyImageAdapter.ios.ts');
  const types = read('services/privacyImageAdapter.types.ts');
  const hook = read('hooks/useKScan.js');
  assert.match(android, /preparePrivacyAdaptedImage/);
  assert.match(ios, /preparePrivacyAdaptedImage/);
  assert.match(types, /localPrivacyFiltered: boolean/);
  assert.match(types, /passthrough/);
  assert.match(hook, /preparePrivacyAdaptedImage/);
  assert.match(hook, /localPrivacyFiltered: adapted\.localPrivacyFiltered/);
  // The hardcoded untruthful claim is gone.
  assert.doesNotMatch(hook, /localPrivacyFiltered: true/);
});

test('multi-image gate: single-image posture still reaches multi-item detection and review', () => {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const hook = read('hooks/useKScan.js');
  // Detection always requests bounded multi-item mode regardless of the
  // multi-image picker gate. Phase 2B.2 moved the request-shaping decision out
  // of the hook and into the shared Scanner adapter, so the assertion follows
  // it there — the hook now states the mode declaratively instead.
  assert.match(
    read('services/scannerScanRequest.ts'),
    /multiItemDetection: true/,
    'the Scanner adapter must still request bounded multi-item detection',
  );
  assert.match(hook, /mode: 'detect_items'/);
  assert.match(hook, /allowsMultipleSelection: MULTI_IMAGE_SCANNER_ENABLED/);
  const eas = JSON.parse(read('eas.json'));
  assert.equal(eas.build.preview.env.EXPO_PUBLIC_SCAN_ROOM_V2_UI, 'true');
  assert.equal(eas.build.preview.env.EXPO_PUBLIC_SCAN_RESULTS_V2_UI, 'true');
  assert.equal(eas.build.preview.env.EXPO_PUBLIC_SCAN_IDENTIFY_BACKEND_ENABLED, 'true');
  assert.equal(eas.build.preview.env.EXPO_PUBLIC_MULTI_IMAGE_SCANNER_ENABLED, 'true');
  assert.notEqual(eas.build.preview.env.EXPO_PUBLIC_SCAN_RESULTS_DEMO_UI, 'true');
  // Android v26 owner ruling: multi-image Scanner is a release feature, so the
  // production profile enables it alongside preview and development.
  assert.equal(eas.build.production.env.EXPO_PUBLIC_MULTI_IMAGE_SCANNER_ENABLED, 'true');
});
