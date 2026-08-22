const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createDeferred() {
  let resolve;
  let reject;

  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

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

function loadUseKScanWithMocks({ analyzeImage, compressForUpload, log }) {
  const hookPath = path.join(__dirname, '..', 'hooks', 'useKScan.js');
  let source = stripImports(fs.readFileSync(hookPath, 'utf8'));
  source = source.replace(/export function useKScan\([^)]*\)/, 'function useKScan(options = {})');
  source += '\nmodule.exports = { useKScan };';

  let stateIndex = 0;
  const stateSlots = [
    { value: 'preview' },
    { value: { uri: 'file://duplicate-guard.jpg' } },
    { value: null },
    { value: null },
    { value: null },
  ];

  const context = {
    module: { exports: {} },
    exports: {},
    __DEV__: true,
    console: {
      log,
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
    compressForUpload,
    buildSecondhandSearchRequest: () => null,
    searchVintedSecondhand: async () => ({ enabled: false, items: [] }),
    errorPulse: () => {},
    softImpact: () => {},
    successPulse: () => {},
    warningPulse: () => {},
  };

  vm.runInNewContext(source, context, { filename: hookPath });
  return context.module.exports.useKScan();
}

async function waitFor(predicate) {
  for (let i = 0; i < 10; i += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  assert.equal(predicate(), true);
}

test('runAnalysis blocks duplicate invocation while first analyze request is unresolved', async () => {
  const deferredAnalyze = createDeferred();
  const logs = [];
  let analyzeCalls = 0;

  const hook = loadUseKScanWithMocks({
    log: (message) => logs.push(String(message)),
    compressForUpload: async () => 'data:image/jpeg;base64,test-payload',
    analyzeImage: async () => {
      analyzeCalls += 1;
      return deferredAnalyze.promise;
    },
  });

  const firstRun = hook.runAnalysis();
  await waitFor(() => analyzeCalls === 1);

  const secondRun = hook.runAnalysis();

  assert.equal(
    analyzeCalls,
    1,
    'analyzeImage must be called once while the first analysis remains in flight',
  );

  const joinedLogs = logs.join('\n');
  assert.match(joinedLogs, /"event":"analyze_trigger_accepted"/);
  assert.match(joinedLogs, /"event":"duplicate_analyze_blocked"/);

  deferredAnalyze.resolve({
    type: 'fashion',
    result: 'Black fitted top',
    metadata: { category: 'Tops', color: 'Black', silhouette: 'Fitted' },
    products: [],
  });

  await firstRun;
  await secondRun;
});
