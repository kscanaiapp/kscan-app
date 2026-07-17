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

function loadUseKScanWithMocks({
  scanIdentifyBackendEnabled = true,
  identifyScanImage = async () => {
    throw new Error('unexpected identifyScanImage call');
  },
  analyzeImage = async () => {
    throw new Error('analyzeImage should not be called');
  },
  compressForUpload = async () => 'data:image/jpeg;base64,test-payload',
} = {}) {
  const hookPath = path.join(__dirname, '..', 'hooks', 'useKScan.js');
  let source = stripImports(fs.readFileSync(hookPath, 'utf8'));
  source = source.replace('export function useKScan()', 'function useKScan()');
  source += '\nmodule.exports = { useKScan };';

  let stateIndex = 0;
  const stateSlots = [
    { value: 'preview' },
    { value: { uri: 'file://test.jpg' } },
    { value: null },
    { value: null },
    { value: null },
  ];

  const context = {
    module: { exports: {} },
    exports: {},
    __DEV__: false,
    console: {
      log: () => {},
      warn: () => {},
      error: () => {},
    },
    setTimeout: (callback) => {
      callback();
      return 1;
    },
    clearTimeout: () => {},
    requestAnimationFrame: (callback) => callback(),
    Date,
    Math,
    Crypto: {
      CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
      digestStringAsync: async () => 'a'.repeat(64),
    },
    SCAN_IDENTIFY_BACKEND_ENABLED: scanIdentifyBackendEnabled,
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
    useEffect: () => {},
    useRef: (initialValue) => ({ current: initialValue }),
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
  return context.module.exports.useKScan();
}

async function waitFor(predicate) {
  for (let i = 0; i < 50; i += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  assert.equal(predicate(), true);
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
    type: 'fashion',
    result: 'Black fitted top',
    metadata: { category: 'Tops', color: 'Black', silhouette: 'Fitted' },
    products: [],
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
