const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

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

function loadUseKScanWithMocks({
  // useEffect in the harness is intentionally simple. Tests that need effects to
  // re-run on state changes can call hook.runEffects() after mutating state.

  scanIdentifyBackendEnabled = true,
  identifyScanImage = async () => {
    throw new Error('unexpected identifyScanImage call');
  },
  analyzeImage = async () => {
    throw new Error('analyzeImage should not be called');
  },
  compressForUpload = async () => 'data:image/jpeg;base64,test-payload',
  imagePickerResult = { canceled: false, assets: [{ uri: 'file://gallery.jpg' }] },
  launchImageLibraryAsync,
  initialStatus = 'preview',
  initialPhoto = { uri: 'file://test.jpg' },
  mediaPermissionStatus = 'granted',
  initialActorId = 'user-a',
} = {}) {
  const hookPath = path.join(__dirname, '..', 'hooks', 'useKScan.js');
  let source = stripImports(fs.readFileSync(hookPath, 'utf8'));
  source = source.replace(
    /export function useKScan\([^)]*\)/,
    'function useKScan(actorId = null)',
  );
  source = source.replace('const MIN_ANALYSIS_MS = 600;', 'const MIN_ANALYSIS_MS = 0;');
  source += '\nmodule.exports = { useKScan };';

  let stateIndex = 0;
  const stateSlots = [
    { value: initialStatus },
    { value: initialPhoto },
    { value: [] },
    { value: null },
    { value: [] },
    { value: null },
    { value: null },
    { value: null },
    { value: null },
    { value: false },
  ];

  const accessibilityAnnouncements = [];
  const alertCalls = [];
  const effectSlots = [];
  const refSlots = [];
  let refIndex = 0;
  // Deterministic evidence ids: the real generator is crypto-backed, which
  // would make request assertions unstable.
  let evidenceIdCounter = 0;
  let effectIndex = 0;
  let renderActorId = initialActorId;
  let currentHook;
  let timerId = 0;
  const timers = new Map();

  const setHookTimeout = (callback, delay) => {
    const id = ++timerId;
    timers.set(id, { callback, delay });
    return id;
  };
  const clearHookTimeout = (id) => timers.delete(id);
  const runNextHookTimer = () => {
    const next = [...timers.entries()].sort((left, right) => (
      left[1].delay - right[1].delay || left[0] - right[0]
    ))[0];
    if (!next) return false;
    timers.delete(next[0]);
    next[1].callback();
    return true;
  };

  const depsChanged = (left, right) => {
    if (!left || !right || left.length !== right.length) return true;
    return left.some((value, index) => !Object.is(value, right[index]));
  };

  const context = {
    module: { exports: {} },
    exports: {},
    __DEV__: false,
    console: {
      log: () => {},
      warn: () => {},
      error: () => {},
    },
    setTimeout: setHookTimeout,
    clearTimeout: clearHookTimeout,
    requestAnimationFrame: (callback) => callback(),
    Date,
    SCAN_IDENTIFY_BACKEND_ENABLED: scanIdentifyBackendEnabled,
    MULTI_IMAGE_SCANNER_ENABLED: false,
    MAX_SCAN_IMAGES: 5,
    AccessibilityInfo: {
      announceForAccessibility: (message) => {
        accessibilityAnnouncements.push(message);
      },
    },
    Alert: {
      alert: (...args) => {
        alertCalls.push(args);
      },
    },
    ImagePicker: {
      MediaTypeOptions: { Images: 'Images' },
      requestMediaLibraryPermissionsAsync: async () => ({ status: mediaPermissionStatus }),
      launchImageLibraryAsync: launchImageLibraryAsync ?? (async () => imagePickerResult),
    },
    useState: (initialValue) => {
      const slot = stateSlots[stateIndex] ?? { value: initialValue };
      stateSlots[stateIndex] = slot;
      stateIndex += 1;
      return [
        slot.value,
        (nextValue) => {
          slot.value = typeof nextValue === 'function'
            ? nextValue(slot.value)
            : nextValue;
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
    analyzeImage,
    identifyScanImage,
    // Phase 2B.2 seam. The hook no longer calls identifyScanImage directly; it
    // goes through the Scanner adapter. These stubs keep every existing
    // assertion in this file meaningful — each Scanner request still lands on
    // the injected identifyScanImage exactly once — while exercising the new
    // path. The session flag defaults to DISABLED here, so this file continues
    // to describe the legacy behaviour it was written for.
    beginScannerV2Session: () => ({ enabled: false }),
    createEvidenceId: () => `test-evidence-${(evidenceIdCounter += 1)}`,
    prepareScannerEvidence: ({ preparedImage, source, evidenceId }) => {
      if (typeof preparedImage !== 'string' || !preparedImage) return null;
      return {
        evidenceId: evidenceId || `test-evidence-${(evidenceIdCounter += 1)}`,
        imageBase64: preparedImage.replace(/^data:[^;]+;base64,/, '').trim(),
        mimeType: 'image/jpeg',
        source: source === 'gallery' ? 'gallery' : 'camera',
      };
    },
    runScannerIdentification: async (input) => ({
      contractPath: 'legacy',
      response: await identifyScanImage(input.evidence.imageBase64, {
        source: input.evidence.source === 'gallery' ? 'upload' : 'camera',
        localPrivacyFiltered: input.localPrivacyFiltered === true,
        multiItemDetection: true,
        requestMode: input.mode === 'identify_selected_item'
          ? 'selected_item'
          : 'multi_item_detection',
        ...(input.legacyCorrelation?.scanSessionId
          ? { scanSessionId: input.legacyCorrelation.scanSessionId }
          : {}),
        ...(input.legacyCorrelation?.imageDigestPrefix
          ? { imageDigestPrefix: input.legacyCorrelation.imageDigestPrefix }
          : {}),
        ...(input.selectedCandidate
          ? {
            selectedCandidate: {
              candidateId: input.selectedCandidate.candidateId,
              category: input.selectedCandidate.category,
              ...(input.selectedCandidate.subtype
                ? { subtype: input.selectedCandidate.subtype }
                : {}),
              ...(input.selectedCandidate.bounds
                ? { bounds: input.selectedCandidate.bounds }
                : {}),
            },
          }
          : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      }),
      identificationV2: null,
      candidates: [],
      fallbackUsed: false,
    }),
    normalizeImageSelections: (assets, source) => {
      if (!Array.isArray(assets) || assets.some((asset) => !asset?.uri)) {
        throw new Error('MALFORMED_IMAGE');
      }
      return assets.map((asset, index) => ({
        id: `image-${index}`,
        uri: asset.uri,
        source,
      }));
    },
    removeImageSelection: (images, imageId) => images.filter((image) => image.id !== imageId),
    buildMultiScanCandidates: (batches) => batches.flatMap(({ image, preparedImage, response }) => (
      response?.status === 'completed' ? [{
        id: `${image.id}-item-0`,
        sourceImageId: image.id,
        sourceImageIndex: 0,
        sourceImageUri: image.uri,
        source: image.source,
        preparedImage,
        detectionResponse: response,
        selectedCandidate: null,
        garment: null,
      }] : []
    )),
    candidateLabel: () => 'Detected item',
    mapScanIdentifyToAnalysis: (response) => response,
    compressForUpload,
    preparePrivacyAdaptedImage: async (uri) => ({
      uri,
      mode: 'passthrough',
      localPrivacyFiltered: false,
    }),
    recordScanLatencyMarker: () => {},
    sanitizeImageBeforeUpload: async (image) => image,
    getPrivacySanitizerStatus: () => ({
      mode: 'test',
      faceDetectionAvailable: false,
      faceBlurApplied: false,
    }),
    buildSecondhandSearchRequest: () => null,
    searchVintedSecondhand: async () => ({ enabled: false, items: [] }),
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

  // State setters update the slots, but the original hook object holds a copy
  // of the initial values. Return a live object so tests can observe transitions.
  const liveHook = {
    get status() { return stateSlots[0]?.value; },
    get photo() { return stateSlots[1]?.value; },
    get analysis() { return stateSlots[3]?.value; },
    get analysisActorId() { return stateSlots[6]?.value; },
    get error() { return stateSlots[7]?.value; },
    get nonFashionMessage() { return stateSlots[8]?.value; },
    get isAnalyzing() { return stateSlots[9]?.value; },
    get scanItems() { return stateSlots[4]?.value; },
    get selectedScanItemId() { return stateSlots[5]?.value; },
    get scanCandidates() { return stateSlots[10]?.value; },
    get selectedCandidateIds() { return stateSlots[11]?.value; },
    get scanStage() { return stateSlots[12]?.value; },
    get itemStates() { return stateSlots[13]?.value; },
    get queueActive() { return stateSlots[14]?.value; },
    get queueHalted() { return stateSlots[15]?.value; },
    get detectionNotice() { return stateSlots[16]?.value; },
    get queueNotice() { return stateSlots[17]?.value; },
    capturePhoto: (...args) => currentHook.capturePhoto(...args),
    selectGalleryPhoto: (...args) => currentHook.selectGalleryPhoto(...args),
    runAnalysis: (...args) => currentHook.runAnalysis(...args),
    retake: (...args) => currentHook.retake(...args),
    dismissResult: (...args) => currentHook.dismissResult(...args),
    retry: (...args) => currentHook.retry(...args),
    selectStaticFixture: (...args) => currentHook.selectStaticFixture(...args),
    uploadPhoto: (...args) => currentHook.uploadPhoto(...args),
    toggleScanCandidate: (...args) => currentHook.toggleScanCandidate(...args),
    confirmSelectedCandidates: (...args) => currentHook.confirmSelectedCandidates(...args),
    removeSelectedImage: (...args) => currentHook.removeSelectedImage(...args),
    accessibilityAnnouncements,
    alertCalls,
    runNextHookTimer,
    unmount: () => {
      effectSlots.forEach((entry) => entry?.cleanup?.());
    },
    rerender: () => render(),
    setActor: (actorId) => {
      renderActorId = actorId;
      render();
    },
  };
  return liveHook;
}

async function waitFor(predicate, timeoutMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(predicate(), true);
}

async function shortDelay(ms = 10) {
  await new Promise((r) => setTimeout(r, ms));
}

test('when SCAN_IDENTIFY_BACKEND_ENABLED is true, duplicate runAnalysis calls only invoke identifyScanImage once', async () => {
  let identifyCalls = 0;
  let analyzeCalls = 0;
  let resolveIdentify;
  const identifyPromise = new Promise((resolve) => {
    resolveIdentify = resolve;
  });

  const hook = loadUseKScanWithMocks({
    scanIdentifyBackendEnabled: true,
    identifyScanImage: async () => {
      identifyCalls += 1;
      return identifyPromise;
    },
    analyzeImage: async () => {
      analyzeCalls += 1;
      throw new Error('render should not be reached');
    },
  });

  const firstRun = hook.runAnalysis();
  await waitFor(() => identifyCalls === 1);

  const secondRun = hook.runAnalysis();

  assert.equal(
    identifyCalls,
    1,
    'identifyScanImage must be called once while the first analysis remains in flight',
  );
  assert.equal(analyzeCalls, 0, 'analyzeImage must not be called as a fallback');

  resolveIdentify({
    status: 'completed',
    attributes: { category: 'Tops', color: 'Black', silhouette: 'Fitted' },
    recommendedProducts: [],
  });
  await firstRun;
  await secondRun;
});

test('when SCAN_IDENTIFY_BACKEND_ENABLED is true and Supabase fails, analyzeImage is not called', async () => {
  let identifyCalls = 0;
  let analyzeCalls = 0;

  const hook = loadUseKScanWithMocks({
    scanIdentifyBackendEnabled: true,
    identifyScanImage: async () => {
      identifyCalls += 1;
      throw new Error('supabase error');
    },
    analyzeImage: async () => {
      analyzeCalls += 1;
      throw new Error('render should not be reached');
    },
  });

  await hook.runAnalysis();

  assert.equal(identifyCalls, 1, 'identifyScanImage must be called once');
  assert.equal(analyzeCalls, 0, 'analyzeImage must not be called when scan-identify fails');
});

test('completed analysis remains bound to the actor that started it', async () => {
  const hook = loadUseKScanWithMocks({
    initialActorId: 'user-a',
    identifyScanImage: async () => ({
      status: 'completed',
      attributes: { category: 'Tops', color: 'Black', silhouette: 'Fitted' },
      recommendedProducts: [],
    }),
  });

  await hook.runAnalysis();

  assert.equal(hook.status, 'result');
  assert.equal(hook.analysisActorId, 'user-a');
});

test('actor switch aborts and discards a deferred analysis result', async () => {
  let resolveIdentify;
  let requestSignal;
  const identifyPromise = new Promise((resolve) => {
    resolveIdentify = resolve;
  });
  const hook = loadUseKScanWithMocks({
    initialActorId: 'user-a',
    identifyScanImage: async (_image, options) => {
      requestSignal = options.signal;
      return identifyPromise;
    },
  });

  const run = hook.runAnalysis();
  await waitFor(() => Boolean(requestSignal));
  hook.setActor('user-b');

  assert.equal(requestSignal.aborted, true);
  assert.equal(hook.status, 'idle');
  assert.equal(hook.photo, null);
  assert.equal(hook.analysis, null);
  assert.equal(hook.analysisActorId, null);

  resolveIdentify({
    status: 'completed',
    attributes: { category: 'Tops', color: 'Black', silhouette: 'Fitted' },
    recommendedProducts: [{ id: 'late-a' }],
  });
  await run;

  assert.equal(hook.status, 'idle');
  assert.equal(hook.analysis, null);
  assert.equal(hook.analysisActorId, null);
});

test('sign-out aborts and discards a deferred analysis result', async () => {
  let resolveIdentify;
  const identifyPromise = new Promise((resolve) => {
    resolveIdentify = resolve;
  });
  const hook = loadUseKScanWithMocks({
    initialActorId: 'user-a',
    identifyScanImage: async () => identifyPromise,
  });

  const run = hook.runAnalysis();
  await shortDelay(5);
  hook.setActor(null);
  resolveIdentify({
    status: 'completed',
    attributes: { category: 'Tops', color: 'Black', silhouette: 'Fitted' },
    recommendedProducts: [{ id: 'late-a' }],
  });
  await run;

  assert.equal(hook.status, 'idle');
  assert.equal(hook.analysis, null);
  assert.equal(hook.analysisActorId, null);
});

test('when SCAN_IDENTIFY_BACKEND_ENABLED is false, analyzeImage is not called', async () => {
  let analyzeCalls = 0;

  const hook = loadUseKScanWithMocks({
    scanIdentifyBackendEnabled: false,
    analyzeImage: async () => {
      analyzeCalls += 1;
      throw new Error('render should not be reached');
    },
  });

  await hook.runAnalysis();

  assert.equal(analyzeCalls, 0, 'analyzeImage must not be called when backend is disabled');
});

// ── Capture and guard ────────────────────────────────────────────────────────

test('first camera action starts capture', async () => {
  let captureCalls = 0;
  const cameraRef = {
    current: {
      takePictureAsync: async () => {
        captureCalls += 1;
        return { uri: 'file://camera.jpg' };
      },
    },
  };

  const hook = loadUseKScanWithMocks({ initialStatus: 'idle' });
  await hook.capturePhoto(cameraRef);

  assert.equal(captureCalls, 1, 'takePictureAsync must be called once');
  assert.equal(hook.status, 'preview');
});

test('immediate second camera action is ignored', async () => {
  let captureCalls = 0;
  let resolveCapture;
  const capturePromise = new Promise((resolve) => { resolveCapture = resolve; });
  const cameraRef = {
    current: {
      takePictureAsync: async () => {
        captureCalls += 1;
        return capturePromise;
      },
    },
  };

  const hook = loadUseKScanWithMocks({ initialStatus: 'idle' });
  const first = hook.capturePhoto(cameraRef);
  const second = hook.capturePhoto(cameraRef);

  assert.equal(captureCalls, 1, 'only one capture must start');

  resolveCapture({ uri: 'file://camera.jpg' });
  await first;
  await second;
});

test('five synchronous camera actions produce one capture', async () => {
  let captureCalls = 0;
  let resolveCapture;
  const capturePromise = new Promise((resolve) => { resolveCapture = resolve; });
  const cameraRef = {
    current: {
      takePictureAsync: async () => {
        captureCalls += 1;
        return capturePromise;
      },
    },
  };

  const hook = loadUseKScanWithMocks({ initialStatus: 'idle' });
  const runs = [
    hook.capturePhoto(cameraRef),
    hook.capturePhoto(cameraRef),
    hook.capturePhoto(cameraRef),
    hook.capturePhoto(cameraRef),
    hook.capturePhoto(cameraRef),
  ];

  assert.equal(captureCalls, 1, 'rapid taps must not queue captures');

  resolveCapture({ uri: 'file://camera.jpg' });
  await Promise.all(runs);
});

test('gallery action is blocked during camera work', async () => {
  let captureCalls = 0;
  let pickerCalls = 0;
  let resolveCapture;
  const capturePromise = new Promise((resolve) => { resolveCapture = resolve; });
  const cameraRef = {
    current: {
      takePictureAsync: async () => {
        captureCalls += 1;
        return capturePromise;
      },
    },
  };

  const hook = loadUseKScanWithMocks({
    initialStatus: 'idle',
    launchImageLibraryAsync: async () => {
      pickerCalls += 1;
      return { canceled: false, assets: [{ uri: 'file://gallery.jpg' }] };
    },
  });

  const captureRun = hook.capturePhoto(cameraRef);
  const galleryRun = hook.selectGalleryPhoto();

  assert.equal(captureCalls, 1, 'camera must start');
  assert.equal(pickerCalls, 0, 'gallery picker must be blocked while camera is in flight');
  assert.equal(hook.isAnalyzing, true, 'guard stays active during camera work');

  resolveCapture({ uri: 'file://camera.jpg' });
  await captureRun;
  await galleryRun;
});

test('camera action is blocked during gallery work', async () => {
  let captureCalls = 0;
  let resolveGallery;
  const galleryPromise = new Promise((resolve) => { resolveGallery = resolve; });

  const hook = loadUseKScanWithMocks({
    initialStatus: 'idle',
    imagePickerResult: galleryPromise,
  });

  // Override launchImageLibraryAsync to return a deferred promise.
  // The harness already resolved imagePickerResult as a promise, but launchImageLibraryAsync
  // was invoked via the async function. Re-loading with a function result is cleaner;
  // here we just verify the synchronous guard blocks before the picker resolves.
  const galleryRun = hook.selectGalleryPhoto();
  const cameraRef = {
    current: {
      takePictureAsync: async () => {
        captureCalls += 1;
        return { uri: 'file://camera.jpg' };
      },
    },
  };

  const captureRun = hook.capturePhoto(cameraRef);

  // Gallery should hold the guard until the picker resolves.
  await shortDelay(5);
  assert.equal(captureCalls, 0, 'camera must be blocked while gallery picker is open');

  resolveGallery({ canceled: false, assets: [{ uri: 'file://gallery.jpg' }] });
  await galleryRun;
  await captureRun;
});

test('guard covers compression/preparation', async () => {
  let compressCalls = 0;
  let resolveCompress;
  const compressPromise = new Promise((resolve) => { resolveCompress = resolve; });

  const hook = loadUseKScanWithMocks({
    initialStatus: 'preview',
    initialPhoto: { uri: 'file://test.jpg' },
    compressForUpload: async () => {
      compressCalls += 1;
      return compressPromise;
    },
  });

  const first = hook.runAnalysis();
  await shortDelay(5);
  const second = hook.runAnalysis();

  assert.equal(compressCalls, 1, 'compression must start once');

  resolveCompress('data:image/jpeg;base64,compressed');
  await first;
  await second;
});

test('picker cancellation clears the guard', async () => {
  let pickerCalls = 0;
  const hook = loadUseKScanWithMocks({
    initialStatus: 'idle',
    imagePickerResult: { canceled: true, assets: [] },
  });

  await hook.selectGalleryPhoto();

  assert.equal(hook.status, 'idle', 'status stays idle when picker is cancelled');
  assert.equal(hook.isAnalyzing, false, 'guard clears after picker cancellation');
});

for (const imagePickerResult of [
  { canceled: false, assets: [] },
  { canceled: false, assets: [{}] },
  { canceled: false, assets: [{ uri: 'file://video.mp4', type: 'video' }] },
]) {
  test(`malformed picker result ${JSON.stringify(imagePickerResult)} fails safely`, async () => {
    const hook = loadUseKScanWithMocks({
      initialStatus: 'idle',
      initialPhoto: null,
      imagePickerResult,
    });

    await hook.selectGalleryPhoto();

    assert.equal(hook.status, 'error');
    assert.equal(hook.photo, null);
    assert.equal(hook.isAnalyzing, false);
  });
}

test('picker rejection fails safely and remains retryable', async () => {
  const hook = loadUseKScanWithMocks({
    initialStatus: 'idle',
    initialPhoto: null,
    launchImageLibraryAsync: async () => { throw new Error('picker failed'); },
  });

  await hook.selectGalleryPhoto();

  assert.equal(hook.status, 'error');
  assert.equal(hook.photo, null);
  assert.equal(hook.isAnalyzing, false);
});

test('gallery selection reaches preview with the uploaded image', async () => {
  const hook = loadUseKScanWithMocks({
    initialStatus: 'idle',
    imagePickerResult: { canceled: false, assets: [{ uri: 'file://picked.jpg' }] },
  });

  await hook.selectGalleryPhoto();

  assert.equal(hook.status, 'preview', 'accepted gallery selection lands on preview');
  assert.equal(hook.photo?.uri, 'file://picked.jpg');
  assert.equal(hook.photo?.source, 'upload');
  assert.equal(hook.isAnalyzing, false, 'guard clears after a completed selection');
});

test('rapid gallery taps produce one picker', async () => {
  let pickerCalls = 0;
  let resolvePicker;
  const pickerPromise = new Promise((resolve) => { resolvePicker = resolve; });

  const hook = loadUseKScanWithMocks({
    initialStatus: 'idle',
    launchImageLibraryAsync: async () => {
      pickerCalls += 1;
      return pickerPromise;
    },
  });

  const runs = [
    hook.selectGalleryPhoto(),
    hook.selectGalleryPhoto(),
    hook.selectGalleryPhoto(),
  ];
  await shortDelay(5);

  assert.equal(pickerCalls, 1, 'rapid gallery taps must open exactly one picker');

  resolvePicker({ canceled: false, assets: [{ uri: 'file://picked.jpg' }] });
  await Promise.all(runs);
});

test('denied broad media permission does not block the permission-light picker', async () => {
  const hook = loadUseKScanWithMocks({
    initialStatus: 'idle',
    mediaPermissionStatus: 'denied',
    imagePickerResult: { canceled: false, assets: [{ uri: 'file://picked.jpg' }] },
  });

  await hook.selectGalleryPhoto();

  assert.equal(hook.status, 'preview');
  assert.equal(hook.photo?.uri, 'file://picked.jpg');
  assert.equal(hook.isAnalyzing, false);
  assert.equal(hook.alertCalls.length, 0);
});

// ── Analysis lifecycle ───────────────────────────────────────────────────────

test('analysis begins once', async () => {
  let identifyCalls = 0;
  const hook = loadUseKScanWithMocks({
    identifyScanImage: async () => {
      identifyCalls += 1;
      return { status: 'completed', attributes: { category: 'Shoes' }, recommendedProducts: [] };
    },
  });

  await hook.runAnalysis();
  assert.equal(identifyCalls, 1);
});

test('guard remains active while promise is unresolved', async () => {
  let resolveIdentify;
  const hook = loadUseKScanWithMocks({
    identifyScanImage: async () => new Promise((resolve) => { resolveIdentify = resolve; }),
  });

  const run = hook.runAnalysis();
  await shortDelay(5);
  assert.equal(hook.isAnalyzing, true, 'isAnalyzing must be true while analysis is unresolved');

  resolveIdentify({ status: 'completed', attributes: { category: 'Shoes' }, recommendedProducts: [] });
  await run;
  assert.equal(hook.isAnalyzing, false, 'isAnalyzing must clear after success');
});

test('success clears the guard', async () => {
  const hook = loadUseKScanWithMocks({
    identifyScanImage: async () => ({ status: 'completed', attributes: { category: 'Shoes' }, recommendedProducts: [] }),
  });

  await hook.runAnalysis();
  assert.equal(hook.status, 'result');
  assert.equal(hook.isAnalyzing, false);
});

test('rejection clears the guard', async () => {
  const hook = loadUseKScanWithMocks({
    identifyScanImage: async () => { throw new Error('boom'); },
  });

  await hook.runAnalysis();
  assert.equal(hook.status, 'error');
  assert.equal(hook.isAnalyzing, false);
});

test('handled failure clears the guard', async () => {
  const hook = loadUseKScanWithMocks({
    identifyScanImage: async () => {
      const err = new Error('backend failed');
      err.userMessage = 'We couldn’t complete the scan. Please try again.';
      throw err;
    },
  });

  await hook.runAnalysis();
  assert.equal(hook.status, 'error');
  assert.equal(hook.isAnalyzing, false);
});

test('timeout clears the guard', async () => {
  let identifyCalls = 0;
  const hook = loadUseKScanWithMocks({
    identifyScanImage: async () => {
      identifyCalls += 1;
      // Never resolve so the attempt timeout fires.
      return new Promise(() => {});
    },
  });

  const run = hook.runAnalysis();
  await shortDelay();
  assert.equal(hook.runNextHookTimer(), true);
  await run;
  assert.equal(identifyCalls, 1);
  assert.equal(hook.status, 'error');
  assert.equal(hook.isAnalyzing, false);
  assert.match(hook.error, /taking longer/i);
});

test('abort clears the guard', async () => {
  let identifyCalls = 0;
  const hook = loadUseKScanWithMocks({
    identifyScanImage: async () => {
      identifyCalls += 1;
      // Never resolve so the attempt timeout fires and aborts the controller.
      return new Promise(() => {});
    },
  });

  const run = hook.runAnalysis();
  await shortDelay();
  assert.equal(hook.runNextHookTimer(), true);
  await run;
  assert.equal(identifyCalls, 1);
  assert.equal(hook.status, 'error');
  assert.equal(hook.isAnalyzing, false);
});

test('late success after timeout is discarded', async () => {
  let resolveIdentify;
  let identifyCalls = 0;
  const hook = loadUseKScanWithMocks({
    identifyScanImage: async () => {
      identifyCalls += 1;
      return new Promise((resolve) => { resolveIdentify = resolve; });
    },
  });

  const run = hook.runAnalysis();
  await shortDelay();
  assert.equal(hook.runNextHookTimer(), true);
  await shortDelay();
  assert.equal(hook.status, 'error');

  resolveIdentify({ status: 'completed', attributes: { category: 'Tops' }, recommendedProducts: [] });
  await run;

  // Status must remain error; late result discarded.
  assert.equal(hook.status, 'error');
  assert.equal(hook.isAnalyzing, false);
});

test('late failure after unmount is discarded', async () => {
  let rejectIdentify;
  const hook = loadUseKScanWithMocks({
    identifyScanImage: async () => new Promise((_, reject) => { rejectIdentify = reject; }),
  });

  const run = hook.runAnalysis();
  await shortDelay(10);

  // Simulate component unmount: cleanup should invalidate the operation.
  hook.unmount();

  rejectIdentify(new Error('late failure'));
  await run;

  // No state update should have occurred after unmount. isAnalyzing stays as
  // it was because the component is no longer mounted to receive state updates.
  assert.equal(hook.status, 'processing');
  assert.equal(hook.isAnalyzing, true);
});

// ── Retry ────────────────────────────────────────────────────────────────────

test('retry works after recoverable failure', async () => {
  const hook = loadUseKScanWithMocks({
    initialStatus: 'error',
    initialPhoto: { uri: 'file://test.jpg' },
  });

  hook.retry();
  assert.equal(hook.status, 'preview', 'retry must reset to preview when a photo exists');
  assert.equal(hook.error, null, 'retry must clear the error');
});

test('rapid retry taps produce one request', async () => {
  let analyzeCalls = 0;
  const hook = loadUseKScanWithMocks({
    initialStatus: 'error',
    initialPhoto: { uri: 'file://test.jpg' },
    identifyScanImage: async () => {
      analyzeCalls += 1;
      return { status: 'completed', attributes: { category: 'Shoes' }, recommendedProducts: [] };
    },
  });

  hook.retry();
  hook.retry();
  hook.retry();
  assert.equal(hook.status, 'preview', 'rapid retry taps settle on one preview state');
  assert.equal(analyzeCalls, 0, 'retry must not start analysis directly');
});

test('non-recoverable failure clears guard even without retry', async () => {
  const hook = loadUseKScanWithMocks({
    identifyScanImage: async () => { throw new Error('unrecoverable'); },
  });

  await hook.runAnalysis();
  assert.equal(hook.status, 'error');
  assert.equal(hook.isAnalyzing, false);
});

// ── UI / Accessibility ───────────────────────────────────────────────────────

test('processing label is exposed', async () => {
  let resolveIdentify;
  const hook = loadUseKScanWithMocks({
    identifyScanImage: async () => new Promise((resolve) => { resolveIdentify = resolve; }),
  });

  const run = hook.runAnalysis();
  await shortDelay(5);
  assert.equal(hook.isAnalyzing, true);
  assert.equal(hook.status, 'processing');

  resolveIdentify({ status: 'completed', attributes: { category: 'Shoes' }, recommendedProducts: [] });
  await run;
});

test('accessibility announcement is wired for false to true transition', () => {
  // The hook uses AccessibilityInfo.announceForAccessibility inside a useEffect
  // keyed on isAnalyzing. Verify the source still contains the correct contract.
  const hookPath = path.join(__dirname, '..', 'hooks', 'useKScan.js');
  const source = fs.readFileSync(hookPath, 'utf8');
  assert.match(source, /AccessibilityInfo\.announceForAccessibility/);
  assert.match(source, /Scan analysis in progress/);
});

test('success clears processing state', async () => {
  const hook = loadUseKScanWithMocks({
    identifyScanImage: async () => ({ status: 'completed', attributes: { category: 'Shoes' }, recommendedProducts: [] }),
  });

  await hook.runAnalysis();
  assert.equal(hook.status, 'result');
  assert.equal(hook.isAnalyzing, false);
});

test('failure clears processing state', async () => {
  const hook = loadUseKScanWithMocks({
    identifyScanImage: async () => { throw new Error('boom'); },
  });

  await hook.runAnalysis();
  assert.equal(hook.status, 'error');
  assert.equal(hook.isAnalyzing, false);
});

test('no stale result overwrites a newer state', async () => {
  let resolveFirst;
  let identifyCalls = 0;
  const hook = loadUseKScanWithMocks({
    initialStatus: 'preview',
    initialPhoto: { uri: 'file://test.jpg' },
    identifyScanImage: async () => {
      identifyCalls += 1;
      return new Promise((resolve) => { resolveFirst = resolve; });
    },
  });

  const firstRun = hook.runAnalysis();
  await shortDelay(5);

  // Simulate the first attempt being replaced (e.g., by unmount/timeout). The
  // timeout path will fire and invalidate the operation.
  assert.equal(hook.runNextHookTimer(), true);
  await firstRun;
  assert.equal(hook.status, 'error');

  // A new attempt should succeed independently.
  const hook2 = loadUseKScanWithMocks({
    initialStatus: 'preview',
    initialPhoto: { uri: 'file://test.jpg' },
    identifyScanImage: async () => ({ status: 'completed', attributes: { category: 'Fresh' }, recommendedProducts: [] }),
  });
  await hook2.runAnalysis();
  assert.equal(hook2.status, 'result');
  // New architecture: detection lands on the deliberate review stage with no
  // commerce analysis. Confirming the single candidate (the N=1 flow) yields
  // the displayed analysis.
  assert.equal(hook2.scanStage, 'review');
  assert.equal(hook2.analysis, null);
  hook2.toggleScanCandidate(hook2.scanCandidates[0].id);
  hook2.confirmSelectedCandidates();
  await waitFor(() => hook2.analysis !== null);
  assert.equal(hook2.analysis?.attributes?.category, 'Fresh');
});
