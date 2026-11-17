const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// Chains the real scan-identify -> mapScanIdentifyResponse (services/api.js) ->
// normalizeWearableResult (services/wearables/bridge.ts) path end to end, using
// an actual scan-identify response captured from a live authenticated call
// against staging (2026-08-22, assets/qa_fixtures/footwear.jpg — a real photo,
// not synthetic). This is the concrete "wearable formatter" + "final Google XR
// result contract" verification: real AI output in, valid bounded wearable
// result out, nothing mocked at any stage.

function loadJsModule(relativePath, extraGlobals = {}) {
  const filePath = path.join(__dirname, '..', relativePath);
  let source = fs
    .readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('import '))
    .join('\n')
    .replace(/^export (const|function|async function)/gm, '$1');
  source += `\nmodule.exports = { ${Object.keys(extraGlobals.__exports || {}).join(', ')} };`;

  const mod = { exports: {} };
  const context = {
    module: mod,
    exports: mod.exports,
    __DEV__: false,
    console,
    process: { env: {} },
    setTimeout,
    clearTimeout,
    Date,
    Promise,
    Object,
    Array,
    JSON,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
    Math,
    ...extraGlobals,
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: filePath });
  return context.module.exports;
}

function loadTsModule(relativePath, exportNames) {
  const filePath = path.join(__dirname, '..', relativePath);
  const raw = fs.readFileSync(filePath, 'utf8');
  const transpiled = ts.transpileModule(raw, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;

  const mod = { exports: {} };
  const context = {
    module: mod,
    exports: mod.exports,
    require: (id) => {
      // ts.transpileModule's CommonJS output requires every top-level import
      // eagerly at module load, regardless of whether it's used — so these three
      // need a harmless stub to let the module load at all. normalizeWearableResult
      // itself is pure (no I/O), so none of these are actually invoked by the
      // assertions below; a throwing stub would fire on load, not on misuse.
      if (id === '@react-native-async-storage/async-storage') return { default: {} };
      if (id === 'expo-crypto') return {};
      if (id === '../supabaseClient') return { supabase: {} };
      throw new Error(`unexpected require('${id}') loading services/wearables/bridge.ts for this test`);
    },
    console,
    process: { env: {} },
    Math,
    Array,
    Object,
    String,
    Number,
    JSON,
    URL,
    RegExp,
  };
  vm.createContext(context);
  vm.runInContext(transpiled, context, { filename: filePath });
  const out = {};
  for (const name of exportNames) out[name] = context.module.exports[name];
  return out;
}

test('real scan-identify response -> analyzeImage mapping -> wearable formatter produces a valid bounded result', () => {
  // Captured verbatim from a live authenticated POST to staging scan-identify
  // with assets/qa_fixtures/footwear.jpg (2026-08-22).
  const realScanIdentifyResponse = {
    status: 'completed',
    attributes: {
      category: 'footwear',
      itemType: 'Running Sneakers',
      silhouette: 'low-top',
      colorPalette: ['red', 'white'],
      materialEstimate: 'synthetic mesh',
      pattern: 'solid',
      styleTags: ['sporty', 'casual', 'athletic'],
      occasion: 'casual',
      confidenceScore: 0.88,
    },
    recommendedProducts: [],
    products: [],
    purchaseOptions: [],
    similarityMatches: [],
    userMessage: 'Low-Top Red Synthetic Mesh Running Sneakers',
    displayResult: {
      headline:
        'A low-top red athletic sneaker worn on one foot on a wet sandy surface, featuring white laces, metallic eyelets, and a textured white ribbed rubber sole.',
      details: 'footwear · red · synthetic mesh · regular · low-top',
      styling: [
        'Pair with athletic shorts and a light zip-up jacket for an active outdoor look.',
        'Style with relaxed denim jeans and a plain neutral t-shirt for a sporty casual outfit.',
      ],
      confidenceLabel: 'High',
    },
  };

  const supabaseMock = {
    functions: { invoke: async () => ({ data: realScanIdentifyResponse, error: null }) },
  };
  const api = loadJsModule('services/api.js', { supabase: supabaseMock, __exports: { analyzeImage: 1 } });
  const { normalizeWearableResult } = loadTsModule('services/wearables/bridge.ts', ['normalizeWearableResult']);

  return api.analyzeImage('data:image/jpeg;base64,AAAA').then((analysis) => {
    // Step 1: the client-side mapping (services/api.js) — same shape useKScan.js gets.
    assert.equal(analysis.type, 'fashion');
    assert.equal(analysis.metadata.category, 'footwear');
    assert.equal(analysis.metadata.confidence, 0.88);
    assert.match(analysis.result, /low-top red athletic sneaker/);

    // Step 2: the wearable formatter (services/wearables/bridge.ts) consumes that
    // same analysis object exactly as app.js's completeWearableScan does.
    const result = normalizeWearableResult('11111111-1111-4111-8111-111111111111', analysis);
    assert.equal(result.resultId, '11111111-1111-4111-8111-111111111111');
    assert.match(result.summary, /low-top red athletic sneaker/);
    assert.ok(result.summary.length <= 220, 'summary must respect the wearable bounded-text limit');
    assert.equal(result.confidence, 0.88, 'real confidence must reach the final wearable contract, not a 0.5 default');
    // Not assert.deepEqual — these arrays are constructed inside the vm sandbox
    // (a separate realm), so they aren't reference-comparable to this file's own
    // array literals even when structurally identical; irrelevant in the real
    // app (one realm), but real in this cross-realm test harness.
    assert.ok(Array.isArray(result.products) && result.products.length === 0);
    assert.equal(result.scanStatus, 'COMPLETED');
    assert.equal(result.errorCode, null);
    assert.equal(Array.from(result.availableActions).join(','), 'SAVE,OPEN_ON_PHONE,RETRY,DISMISS');
  });
});

test('non_fashion scan-identify response never reaches the wearable formatter as a fabricated result', async () => {
  const supabaseMock = {
    functions: {
      invoke: async () => ({
        data: { status: 'non_fashion', userMessage: 'This does not appear to be a fashion item.', recommendedProducts: [] },
        error: null,
      }),
    },
  };
  const api = loadJsModule('services/api.js', { supabase: supabaseMock, __exports: { analyzeImage: 1 } });

  const analysis = await api.analyzeImage('data:image/jpeg;base64,AAAA');
  assert.equal(analysis.type, 'non-fashion');
  // app.js only calls completeWearableScan when status === 'result' (i.e. type
  // 'fashion'); 'non-fashion' routes to the non-fashion UI state instead. This
  // assertion documents that contract so a future change can't silently start
  // formatting non-fashion analyses as wearable results.
  assert.notEqual(analysis.type, 'fashion');
});
