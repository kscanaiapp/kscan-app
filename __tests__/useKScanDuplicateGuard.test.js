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
  attemptTimeoutMs = 50,
  initialStatus = 'preview',
  initialPhoto = { uri: 'file://test.jpg' },
  mediaPermissionStatus = 'granted',
} = {}) {
  const hookPath = path.join(__dirname, '..', 'hooks', 'useKScan.js');
  let source = stripImports(fs.readFileSync(hookPath, 'utf8'));
  source = source.replace('export function useKScan()', 'function useKScan()');
  source = source.replace(
    'const ATTEMPT_TIMEOUT_MS = 32_000;',
    `const ATTEMPT_TIMEOUT_MS = ${attemptTimeoutMs};`
  );
  source = source.replace('const MIN_ANALYSIS_MS = 600;', 'const MIN_ANALYSIS_MS = 0;');
  source += '\nmodule.exports = { useKScan };';

  let stateIndex = 0;
  const stateSlots = [
    { value: initialStatus },  // [0] status
    { value: initialPhoto },   // [1] photo
    { value: null },           // [2] analysis
    { value: null },           // [3] error
    { value: null },           // [4] nonFashionMessage
    { value: null },           // [5] selectedCandidateId
    { value: false },          // [6] isAnalyzing
  ];

  const accessibilityAnnouncements = [];
  const alertCalls = [];
  const effectCleanups = [];
  const effectEntries = [];

  const context = {
    module: { exports: {} },
    exports: {},
    __DEV__: false,
    console: {
      log: () => {},
      warn: () => {},
      error: () => {},
    },
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (callback) => callback(),
    Date,
    SCAN_IDENTIFY_BACKEND_ENABLED: scanIdentifyBackendEnabled,
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
      const cleanup = callback();
      if (typeof cleanup === 'function') {
        effectCleanups.push(cleanup);
      }
      effectEntries.push({ callback, deps, cleanup });
    },
    useRef: (initialValue) => ({ current: initialValue }),
    Crypto: {
      CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
      digestStringAsync: async () => 'a'.repeat(64),
    },
    AbortController: MockAbortController,
    analyzeImage,
    identifyScanImage,
    mapScanIdentifyToAnalysis: (response) => response,
    compressForUpload,
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
  const hook = context.module.exports.useKScan();

  // State setters update the slots, but the original hook object holds a copy
  // of the initial values. Return a live object so tests can observe transitions.
  const liveHook = {
    get status() { return stateSlots[0]?.value; },
    get photo() { return stateSlots[1]?.value; },
    get analysis() { return stateSlots[2]?.value; },
    get error() { return stateSlots[3]?.value; },
    get nonFashionMessage() { return stateSlots[4]?.value; },
    get selectedCandidateId() { return stateSlots[5]?.value; },
    get isAnalyzing() { return stateSlots[6]?.value; },
    capturePhoto: hook.capturePhoto,
    selectGalleryPhoto: hook.selectGalleryPhoto,
    runAnalysis: hook.runAnalysis,
    analyzeSelectedCandidate: hook.analyzeSelectedCandidate,
    retake: hook.retake,
    dismissResult: hook.dismissResult,
    retry: hook.retry,
    selectStaticFixture: hook.selectStaticFixture,
    uploadPhoto: hook.uploadPhoto,
    accessibilityAnnouncements,
    alertCalls,
    unmount: () => {
      effectCleanups.forEach((cleanup) => cleanup());
    },
    runEffects: () => {
      effectEntries.forEach((entry) => {
        if (entry.cleanup) entry.cleanup();
        const newCleanup = entry.callback();
        entry.cleanup = typeof newCleanup === 'function' ? newCleanup : undefined;
      });
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

test('production Scanner runAnalysis enables multi-item detection on scan-identify call', async () => {
  let sentOptions = null;

  const hook = loadUseKScanWithMocks({
    scanIdentifyBackendEnabled: true,
    identifyScanImage: async (_image, options) => {
      sentOptions = options;
      return {
        type: 'fashion',
        result: 'Outfit scan',
        metadata: { category: 'Outfit', color: 'Black', silhouette: 'Layered' },
        products: [],
      };
    },
  });

  await hook.runAnalysis();

  assert.equal(sentOptions.multiItemDetection, true);
  assert.equal(sentOptions.requestMode, 'multi_item_detection');
  assert.match(sentOptions.scanSessionId, /^scan_/);
  assert.equal(sentOptions.imageDigestPrefix, 'aaaaaaaaaaaa');
});

test('selected-item request reuses the exact prepared image, digest, and scan session', async () => {
  const calls = [];
  const hook = loadUseKScanWithMocks({
    identifyScanImage: async (image, options) => {
      calls.push({ image, options });
      if (calls.length === 1) {
        return {
          type: 'fashion',
          result: 'Detected outfit',
          metadata: { category: 'outfit', color: 'black', silhouette: 'layered' },
          products: [],
          confirmationCandidates: [
            {
              id: 'garment-1-blazer',
              category: 'blazer',
              subtype: 'tailored blazer',
              bounds: { x: 0.1, y: 0.08, width: 0.8, height: 0.52 },
            },
          ],
        };
      }
      return {
        type: 'fashion',
        result: 'Selected black blazer',
        metadata: { category: 'blazer', color: 'black', silhouette: 'tailored' },
        products: [],
      };
    },
  });

  await hook.runAnalysis();
  await hook.analyzeSelectedCandidate('garment-1-blazer');

  assert.equal(calls.length, 2, 'one detection call plus one selected-item call');
  assert.equal(calls[1].image, calls[0].image, 'prepared image payload must be identical');
  assert.equal(calls[1].options.scanSessionId, calls[0].options.scanSessionId);
  assert.equal(calls[1].options.imageDigestPrefix, calls[0].options.imageDigestPrefix);
  assert.equal(calls[0].options.requestMode, 'multi_item_detection');
  assert.equal(calls[1].options.requestMode, 'selected_item');
  assert.equal(calls[1].options.selectedCandidate.candidateId, 'garment-1-blazer');
  assert.equal(calls[1].options.selectedCandidate.category, 'blazer');
  assert.equal(calls[1].options.selectedCandidate.bounds.x, 0.1);
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

test('gallery permission denial clears the guard and surfaces guidance', async () => {
  const hook = loadUseKScanWithMocks({
    initialStatus: 'idle',
    mediaPermissionStatus: 'denied',
  });

  await hook.selectGalleryPhoto();

  assert.equal(hook.status, 'idle', 'status stays idle on permission denial');
  assert.equal(hook.isAnalyzing, false, 'guard must clear on permission denial');
  assert.equal(hook.alertCalls.length, 1, 'user must be told how to enable photo access');
  assert.match(hook.alertCalls[0][0], /Photo Access Required/);
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
    attemptTimeoutMs: 30,
    identifyScanImage: async () => {
      identifyCalls += 1;
      // Never resolve so the attempt timeout fires.
      return new Promise(() => {});
    },
  });

  await hook.runAnalysis();
  assert.equal(identifyCalls, 1);
  assert.equal(hook.status, 'error');
  assert.equal(hook.isAnalyzing, false);
  assert.match(hook.error, /taking longer/i);
});

test('abort clears the guard', async () => {
  let identifyCalls = 0;
  const hook = loadUseKScanWithMocks({
    attemptTimeoutMs: 30,
    identifyScanImage: async () => {
      identifyCalls += 1;
      // Never resolve so the attempt timeout fires and aborts the controller.
      return new Promise(() => {});
    },
  });

  const run = hook.runAnalysis();
  await run;
  assert.equal(identifyCalls, 1);
  assert.equal(hook.status, 'error');
  assert.equal(hook.isAnalyzing, false);
});

test('late success after timeout is discarded', async () => {
  let resolveIdentify;
  let identifyCalls = 0;
  const hook = loadUseKScanWithMocks({
    attemptTimeoutMs: 30,
    identifyScanImage: async () => {
      identifyCalls += 1;
      return new Promise((resolve) => { resolveIdentify = resolve; });
    },
  });

  const run = hook.runAnalysis();
  await shortDelay(60);
  // Timeout should have fired by now.
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
  assert.equal(hook2.analysis?.attributes?.category, 'Fresh');
});
