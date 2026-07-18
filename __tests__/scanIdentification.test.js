// Unit tests for the Scan Identification client adapter + mapper (KS-REL-008C).
// TS modules are transpiled in-process and run in a VM sandbox so we can stub
// the Supabase client without pulling in React Native runtime dependencies.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

// VM-sandboxed modules create arrays in a separate realm, so deepStrictEqual
// against a host [] fails on prototype identity. Assert emptiness structurally.
function assertEmptyArray(value) {
  assert.ok(Array.isArray(value), 'expected an array');
  assert.equal(value.length, 0, 'expected an empty array');
}

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
  const sandbox = {
    __DEV__: false,
    console,
    exports: mod.exports,
    module: mod,
    AbortController,
    setTimeout,
    clearTimeout,
    Date,
    Math,
    Number,
    Object,
    Array,
    JSON,
    require: (id) => {
      if (id in requireMap) return requireMap[id];
      if (id.startsWith('node:')) return require(id);
      throw new Error(`Unexpected require: ${id}`);
    },
  };
  vm.runInNewContext(output, sandbox, { filename });
  return mod.exports;
}

// Part 2: the mapper now has runtime imports of services/scanResultObject.ts
// and services/scanTitleBuilder.ts. Both are dependency-free and load cleanly
// with no requireMap.
const scanResultObjectModule = loadTsModule('services/scanResultObject.ts');
const scanTitleBuilderModule = loadTsModule('services/scanTitleBuilder.ts');
const mapper = loadTsModule('services/scanIdentificationMapper.ts', {
  './scanResultObject': scanResultObjectModule,
  './scanTitleBuilder': scanTitleBuilderModule,
  '../constants/build': { SCAN_IDENTITY_DEBUG: false },
});

function loadAdapter(supabaseStub) {
  return loadTsModule('services/scanIdentification.ts', {
    './supabaseClient': { supabase: supabaseStub },
    '../constants/build': { SCAN_DIAGNOSTICS_ENABLED: false },
  });
}

// ── Mapper ───────────────────────────────────────────────────────────────────

test('mapper: completed → legacy fashion shape with [] products', () => {
  const out = mapper.mapScanIdentifyToAnalysis({
    status: 'completed',
    recommendedProducts: [],
    userMessage: 'A tan trench coat.',
    attributes: {
      category: 'Outerwear',
      silhouette: 'Relaxed straight fit',
      colorPalette: ['Tan', 'Camel'],
      itemType: 'Trench coat',
      confidenceScore: 0.86,
    },
  });
  assert.equal(out.type, 'fashion');
  assert.equal(out.result, 'A tan trench coat.');
  assert.equal(out.metadata.category, 'Outerwear');
  assert.equal(out.metadata.color, 'Tan, Camel');
  assert.equal(out.metadata.silhouette, 'Relaxed straight fit');
  assert.equal(out.metadata.itemType, 'Trench coat');
  assertEmptyArray(out.products);
});

test('mapper: non_fashion → non-fashion message', () => {
  const out = mapper.mapScanIdentifyToAnalysis({
    status: 'non_fashion',
    recommendedProducts: [],
    userMessage: 'Not a fashion item.',
  });
  assert.equal(out.type, 'non-fashion');
  assert.equal(out.message, 'Not a fashion item.');
});

test('mapper: failed → throws user-safe error', () => {
  assert.throws(
    () => mapper.mapScanIdentifyToAnalysis({ status: 'failed', recommendedProducts: [], userMessage: 'Try again.' }),
    (err) => {
      assert.equal(err.userMessage, 'Try again.');
      return true;
    },
  );
});

test('mapper: completed with no attributes still yields safe metadata', () => {
  const out = mapper.mapScanIdentifyToAnalysis({ status: 'completed', recommendedProducts: [] });
  assert.equal(out.type, 'fashion');
  assert.equal(out.metadata.category, '');
  assert.equal(out.metadata.color, '');
  assertEmptyArray(out.products);
});

// ── Adapter normalization (pure) ───────────────────────────────────────────────

test('normalizeScanIdentifyResponse: garbage → failed', () => {
  const adapter = loadAdapter({});
  assert.equal(adapter.normalizeScanIdentifyResponse(null).status, 'failed');
  assert.equal(adapter.normalizeScanIdentifyResponse('nope').status, 'failed');
  assertEmptyArray(adapter.normalizeScanIdentifyResponse(null).recommendedProducts);
});

test('normalizeScanIdentifyResponse: completed without attributes → failed', () => {
  const adapter = loadAdapter({});
  assert.equal(adapter.normalizeScanIdentifyResponse({ status: 'completed' }).status, 'failed');
});

test('normalizeScanIdentifyResponse: generic failed neutralizes lighting copy (Task 1A)', () => {
  const adapter = loadAdapter({});
  const out = adapter.normalizeScanIdentifyResponse({
    status: 'failed',
    userMessage:
      "We couldn't complete this scan. Please try again in better light or retake the photo.",
  });
  assert.equal(out.status, 'failed');
  assert.equal(out.userMessage, "We couldn't complete this scan. Please try again.");
  assert.ok(!/better light/i.test(out.userMessage), 'generic failure must not blame lighting');
});

test('normalizeScanIdentifyResponse: explicit image-quality failed keeps retake guidance (Task 1A)', () => {
  const adapter = loadAdapter({});
  const out = adapter.normalizeScanIdentifyResponse({ status: 'failed', reason: 'image_quality' });
  assert.equal(out.status, 'failed');
  assert.match(out.userMessage, /better light/i);
});

test('normalizeScanIdentifyResponse: missing attributes uses neutral message (Task 1A)', () => {
  const adapter = loadAdapter({});
  const out = adapter.normalizeScanIdentifyResponse({ status: 'completed' });
  assert.equal(out.status, 'failed');
  assert.equal(out.userMessage, "We couldn't complete this scan. Please try again.");
});

test('normalizeScanIdentifyResponse: drops out-of-range confidence to clamp', () => {
  const adapter = loadAdapter({});
  const out = adapter.normalizeScanIdentifyResponse({
    status: 'completed',
    attributes: { category: 'Tops', confidenceScore: 5 },
  });
  assert.equal(out.status, 'completed');
  assert.equal(out.attributes.confidenceScore, 1);
  assertEmptyArray(out.recommendedProducts);
});

// ── Adapter network behavior (stubbed Supabase) ────────────────────────────────

const TINY_DATA_URI = 'data:image/jpeg;base64,QUJD'; // "ABC"

test('identifyScanImage: no session → sign-in failure, no invoke', async () => {
  let invoked = false;
  const adapter = loadAdapter({
    auth: { getSession: async () => ({ data: { session: null } }) },
    functions: { invoke: async () => { invoked = true; return { data: null, error: null }; } },
  });
  const out = await adapter.identifyScanImage(TINY_DATA_URI, { source: 'camera' });
  assert.equal(out.status, 'failed');
  assert.match(out.userMessage, /sign in/i);
  assert.equal(invoked, false);
});

test('identifyScanImage: oversized payload → too large, no invoke', async () => {
  let invoked = false;
  const adapter = loadAdapter({
    auth: { getSession: async () => ({ data: { session: { user: { id: 'u1' } } } }) },
    functions: { invoke: async () => { invoked = true; return { data: null, error: null }; } },
  });
  const big = 'data:image/jpeg;base64,' + 'A'.repeat(2 * 1024 * 1024 + 10);
  const out = await adapter.identifyScanImage(big, { source: 'camera' });
  assert.equal(out.status, 'failed');
  assert.match(out.userMessage, /too large/i);
  assert.equal(invoked, false);
});

test('identifyScanImage: success path returns normalized completed', async () => {
  let sentBody = null;
  let invokedFn = null;
  const adapter = loadAdapter({
    auth: { getSession: async () => ({ data: { session: { user: { id: 'u1' } } } }) },
    functions: {
      invoke: async (fn, opts) => {
        invokedFn = fn;
        sentBody = opts.body;
        return {
          data: { status: 'completed', recommendedProducts: [], attributes: { category: 'Footwear' }, userMessage: 'Sneakers.' },
          error: null,
        };
      },
    },
  });
  const out = await adapter.identifyScanImage(TINY_DATA_URI, { source: 'upload', localPrivacyFiltered: true });
  assert.equal(out.status, 'completed');
  assert.equal(out.attributes.category, 'Footwear');
  assertEmptyArray(out.recommendedProducts);
  assert.equal(invokedFn, 'scan-identify', 'Camera route must invoke scan-identify Edge Function');
  // data-URI prefix stripped before sending
  assert.equal(sentBody.imageBase64, 'QUJD');
  assert.equal(sentBody.source, 'upload');
  assert.equal(sentBody.localPrivacyFiltered, true);
  assert.equal(typeof sentBody.clientTimestamp, 'string');
});

test('identifyScanImage: invoke error → failed', async () => {
  const adapter = loadAdapter({
    auth: { getSession: async () => ({ data: { session: { user: { id: 'u1' } } } }) },
    functions: { invoke: async () => ({ data: null, error: { message: 'boom' } }) },
  });
  const out = await adapter.identifyScanImage(TINY_DATA_URI, { source: 'camera' });
  assert.equal(out.status, 'failed');
});

// ── Abort signal lifecycle (KC05 audit F1) ─────────────────────────────────────

test('identifyScanImage: already-aborted external signal short-circuits before invoke', async () => {
  let invoked = false;
  const adapter = loadAdapter({
    auth: { getSession: async () => ({ data: { session: { user: { id: 'u1' } } } }) },
    functions: {
      invoke: async () => {
        invoked = true;
        return {
          data: { status: 'completed', recommendedProducts: [], attributes: { category: 'Tops' } },
          error: null,
        };
      },
    },
  });

  const controller = new AbortController();
  controller.abort();

  const out = await adapter.identifyScanImage(TINY_DATA_URI, {
    source: 'camera',
    signal: controller.signal,
  });

  assert.equal(invoked, false, 'must not invoke the edge function for an already-aborted signal');
  assert.equal(out.status, 'failed');
  assert.match(out.userMessage, /taking longer/i);
});

test('identifyScanImage: external abort during request cancels the invoke', async () => {
  let receivedSignal = null;
  const adapter = loadAdapter({
    auth: { getSession: async () => ({ data: { session: { user: { id: 'u1' } } } }) },
    functions: {
      invoke: (_fn, opts) =>
        new Promise((_resolve, reject) => {
          receivedSignal = opts.signal;
          opts.signal.addEventListener('abort', () => {
            const err = new Error('The operation was aborted.');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    },
  });

  const controller = new AbortController();
  const pending = adapter.identifyScanImage(TINY_DATA_URI, {
    source: 'camera',
    signal: controller.signal,
  });
  // Let execution reach the invoke call (auth getSession + controller setup run
  // first) before aborting, so this exercises abort-during-request, not the
  // already-aborted short-circuit above.
  await new Promise((r) => setTimeout(r, 10));
  controller.abort();
  const out = await pending;

  assert.ok(receivedSignal, 'invoke must receive an abort signal');
  assert.equal(receivedSignal.aborted, true, 'external abort must propagate to the invoke signal');
  assert.equal(out.status, 'failed');
  assert.match(out.userMessage, /taking longer/i);
});

test('identifyScanImage: successful request with external signal still completes', async () => {
  let invoked = false;
  const adapter = loadAdapter({
    auth: { getSession: async () => ({ data: { session: { user: { id: 'u1' } } } }) },
    functions: {
      invoke: async () => {
        invoked = true;
        return {
          data: { status: 'completed', recommendedProducts: [], attributes: { category: 'Footwear' } },
          error: null,
        };
      },
    },
  });

  const controller = new AbortController();
  const out = await adapter.identifyScanImage(TINY_DATA_URI, {
    source: 'camera',
    signal: controller.signal,
  });

  assert.equal(invoked, true);
  assert.equal(out.status, 'completed');
  // A late abort after settlement must be harmless (listener already removed).
  controller.abort();
});

// ── New identification mapping tests (Day-1 prompt upgrade) ───────────────────

test('mapper: identification.visual_observation preferred for result', () => {
  const out = mapper.mapScanIdentifyToAnalysis({
    status: 'completed',
    recommendedProducts: [],
    userMessage: 'A tan trench coat.',
    attributes: {
      category: 'Outerwear',
      silhouette: 'Relaxed straight fit',
      colorPalette: ['Tan', 'Camel'],
      itemType: 'Trench coat',
      confidenceScore: 0.86,
    },
    identification: {
      visual_observation: 'A classic tan double-breasted trench coat with wide lapels and a belted waist.',
      item_type: 'trench coat',
      subtype: 'double-breasted trench coat',
      primary_color: 'tan',
      secondary_colors: ['camel'],
      pattern: 'solid',
      material_estimate: 'cotton gabardine',
      silhouette: 'structured',
      fit: 'relaxed',
      length: 'knee length',
      sleeve_length: 'long sleeve',
      neckline_or_lapel: 'notch lapel',
      closure: 'double-breasted buttons',
      distinctive_features: ['belted waist', 'storm flap'],
      style_tags: ['classic', 'timeless', 'polished'],
      occasion_tags: ['workwear', 'rainwear', 'travel'],
      visible_brand_text: null,
      logo_detected: false,
      brand_guess: null,
      confidence_score: 0.91,
      search_queries: [
        'tan double breasted trench coat belted waist',
        'classic tan trench coat storm flap',
      ],
      non_fashion: false,
    },
  });
  assert.equal(out.type, 'fashion');
  assert.equal(out.result, 'A classic tan double-breasted trench coat with wide lapels and a belted waist.');
  assert.equal(out.metadata.category, 'trench coat');
  assert.equal(out.metadata.color, 'tan, camel');
  assert.equal(out.metadata.silhouette, 'structured');
  assert.equal(out.metadata.itemType, 'double-breasted trench coat');
  assert.equal(out.metadata.materialEstimate, 'cotton gabardine');
  assert.equal(out.metadata.pattern, 'solid');
  assert.equal(out.metadata.occasion, 'workwear');
  assert.deepStrictEqual(out.metadata.styleTags, ['classic', 'timeless', 'polished']);
  assert.equal(out.metadata.confidenceScore, 0.91);
  assertEmptyArray(out.products);
});

test('mapper: identification color preferred over legacy colorPalette', () => {
  const out = mapper.mapScanIdentifyToAnalysis({
    status: 'completed',
    recommendedProducts: [],
    attributes: {
      category: 'Tops',
      colorPalette: ['Red', 'White'],
    },
    identification: {
      visual_observation: 'A red silk blouse.',
      primary_color: 'crimson',
      secondary_colors: ['ivory'],
    },
  });
  assert.equal(out.type, 'fashion');
  assert.equal(out.result, 'A red silk blouse.');
  assert.equal(out.metadata.color, 'crimson, ivory');
});

test('adapter: normalizeScanIdentifyResponse passes identification through', () => {
  const adapter = loadAdapter({});
  const out = adapter.normalizeScanIdentifyResponse({
    status: 'completed',
    recommendedProducts: [],
    attributes: { category: 'Footwear' },
    identification: {
      visual_observation: 'White leather sneakers.',
      item_type: 'sneakers',
      confidence_score: 0.87,
    },
  });
  assert.equal(out.status, 'completed');
  assert.equal(out.identification.visual_observation, 'White leather sneakers.');
  assert.equal(out.identification.item_type, 'sneakers');
  assert.equal(out.identification.confidence_score, 0.87);
});

test('adapter: normalizeScanIdentifyResponse clamps identification confidence_score', () => {
  const adapter = loadAdapter({});
  const out = adapter.normalizeScanIdentifyResponse({
    status: 'completed',
    recommendedProducts: [],
    attributes: { category: 'Footwear' },
    identification: {
      visual_observation: 'White leather sneakers.',
      confidence_score: 1.5,
    },
  });
  assert.equal(out.identification.confidence_score, 1);
});


// ── recommendedProducts pass-through (v3 readiness) ─────────────────────────

test('adapter: normalizeScanIdentifyResponse preserves recommendedProducts', () => {
  const adapter = loadAdapter({});
  const out = adapter.normalizeScanIdentifyResponse({
    status: 'completed',
    attributes: { category: 'Outerwear' },
    recommendedProducts: [
      { id: 'p1', name: 'Trench Coat', matchScore: 0.92 },
      { id: 'p2', name: 'Blazer', matchScore: 0.84 },
    ],
  });
  assert.equal(out.status, 'completed');
  assert.equal(out.recommendedProducts.length, 2);
  assert.equal(out.recommendedProducts[0].id, 'p1');
  assert.equal(out.recommendedProducts[1].name, 'Blazer');
});

test('adapter: normalizeScanIdentifyResponse preserves similarityMatches separately', () => {
  const adapter = loadAdapter({});
  const out = adapter.normalizeScanIdentifyResponse({
    status: 'completed',
    attributes: { category: 'Outerwear' },
    recommendedProducts: [
      { id: 'live-1', title: 'Live Commerce Coat', type: 'retail' },
    ],
    similarityMatches: [
      { id: 'sim-1', name: 'Catalog Similar Coat', matchScore: 82 },
    ],
  });
  assert.equal(out.status, 'completed');
  assert.equal(out.recommendedProducts.length, 1);
  assert.equal(out.recommendedProducts[0].id, 'live-1');
  assert.equal(out.similarityMatches.length, 1);
  assert.equal(out.similarityMatches[0].id, 'sim-1');
});

test('adapter: normalizeScanIdentifyResponse normalizes displayResult', () => {
  const adapter = loadAdapter({});
  const out = adapter.normalizeScanIdentifyResponse({
    status: 'completed',
    attributes: { category: 'Blazer' },
    displayResult: {
      headline: 'Black double-breasted blazer',
      details: 'blazer · black · wool blend · tailored',
      styling: ['Pair with trousers.', 'Layer over a dress.'],
      confidenceLabel: 'High',
    },
  });
  assert.equal(out.displayResult?.headline, 'Black double-breasted blazer');
  assert.equal(out.displayResult?.details, 'blazer · black · wool blend · tailored');
  assert.deepStrictEqual(out.displayResult?.styling, ['Pair with trousers.', 'Layer over a dress.']);
  assert.equal(out.displayResult?.confidenceLabel, 'High');
});

test('adapter: normalizeScanIdentifyResponse strips malformed displayResult', () => {
  const adapter = loadAdapter({});
  const out = adapter.normalizeScanIdentifyResponse({
    status: 'completed',
    attributes: { category: 'Blazer' },
    displayResult: { headline: '', styling: ['', 123, null] },
  });
  assert.equal(out.displayResult, undefined);
});

// ── Mapper pass-through (v3 readiness) ───────────────────────────────────────

test('mapper: recommendedProducts passed through as products', () => {
  const out = mapper.mapScanIdentifyToAnalysis({
    status: 'completed',
    recommendedProducts: [
      { id: 'p1', displayName: 'Black Blazer', matchScore: 0.92 },
    ],
    userMessage: 'Black blazer.',
    attributes: { category: 'blazer' },
  });
  assert.equal(out.type, 'fashion');
  assert.equal(out.products.length, 1);
  assert.equal(out.products[0].displayName, 'Black Blazer');
});

test('mapper: similarityMatches drive products and recommendedProducts become purchaseOptions', () => {
  const out = mapper.mapScanIdentifyToAnalysis({
    status: 'completed',
    recommendedProducts: [
      { id: 'live-1', title: 'Live Commerce Coat', type: 'retail' },
    ],
    similarityMatches: [
      { id: 'sim-1', name: 'Catalog Similar Coat', matchScore: 82 },
    ],
    userMessage: 'A coat.',
    attributes: { category: 'Outerwear' },
  });
  assert.equal(out.type, 'fashion');
  assert.equal(out.products.length, 1);
  assert.equal(out.products[0].id, 'sim-1');
  assert.equal(out.purchaseOptions.length, 1);
  assert.equal(out.purchaseOptions[0].id, 'live-1');
});

test('mapper: explicit null similarityMatches hides catalog products but preserves purchaseOptions', () => {
  const out = mapper.mapScanIdentifyToAnalysis({
    status: 'completed',
    recommendedProducts: [
      { id: 'live-1', title: 'Live Commerce Coat', type: 'retail' },
    ],
    similarityMatches: null,
    userMessage: 'A coat.',
    attributes: { category: 'Outerwear' },
  });
  assert.equal(out.type, 'fashion');
  assertEmptyArray(out.products);
  assert.equal(out.purchaseOptions.length, 1);
  assert.equal(out.purchaseOptions[0].id, 'live-1');
});

test('mapper: displayResult preserved on fashion analysis', () => {
  const out = mapper.mapScanIdentifyToAnalysis({
    status: 'completed',
    recommendedProducts: [],
    userMessage: 'Black blazer.',
    attributes: { category: 'blazer' },
    displayResult: {
      headline: 'Black blazer',
      confidenceLabel: 'High',
    },
  });
  assert.equal(out.type, 'fashion');
  assert.equal(out.displayResult?.headline, 'Black blazer');
  assert.equal(out.displayResult?.confidenceLabel, 'High');
});

test('mapper: scanQualityNote and stylingSuggestions in metadata', () => {
  const out = mapper.mapScanIdentifyToAnalysis({
    status: 'completed',
    recommendedProducts: [],
    userMessage: 'Blazer.',
    attributes: { category: 'blazer' },
    identification: {
      visual_observation: 'A blazer.',
      item_type: 'blazer',
      confidence_score: 0.65,
      scan_quality_note: 'Too far away.',
      styling_suggestions: ['Pair with jeans.', 'Add a belt.'],
    },
  });
  assert.equal(out.metadata.confidenceScore, 0.65);
  assert.equal(out.metadata.scanQualityNote, 'Too far away.');
  assert.deepStrictEqual(out.metadata.stylingSuggestions, ['Pair with jeans.', 'Add a belt.']);
});


// ── recommendedProducts data-contract coverage (v3 readiness) ────────────────

test('adapter: normalizeScanIdentifyResponse preserves snake_case product fields', () => {
  const adapter = loadAdapter({});
  const out = adapter.normalizeScanIdentifyResponse({
    status: 'completed',
    attributes: { category: 'Bags' },
    recommendedProducts: [
      {
        id: 'bag-1',
        name: 'Leather Tote',
        retailer: 'Staging Retailer',
        image_url: 'https://placehold.co/400x600?text=Tote',
        product_url: 'https://example.com/tote',
        canonical_category: 'handbag',
        category: 'Handbag',
        price: 249,
      },
    ],
  });
  assert.equal(out.status, 'completed');
  assert.equal(out.recommendedProducts.length, 1);
  const p = out.recommendedProducts[0];
  assert.equal(p.id, 'bag-1');
  assert.equal(p.retailer, 'Staging Retailer');
  assert.equal(p.image_url, 'https://placehold.co/400x600?text=Tote');
  assert.equal(p.product_url, 'https://example.com/tote');
  assert.equal(p.canonical_category, 'handbag');
  assert.equal(p.category, 'Handbag');
  assert.equal(p.price, 249);
});

test('adapter: normalizeScanIdentifyResponse falls back to [] for missing/null/invalid recommendedProducts', () => {
  const adapter = loadAdapter({});
  const completed = { status: 'completed', attributes: { category: 'Tops' } };
  assertEmptyArray(adapter.normalizeScanIdentifyResponse({ ...completed, recommendedProducts: undefined }).recommendedProducts);
  assertEmptyArray(adapter.normalizeScanIdentifyResponse({ ...completed, recommendedProducts: null }).recommendedProducts);
  assertEmptyArray(adapter.normalizeScanIdentifyResponse({ ...completed, recommendedProducts: 'nope' }).recommendedProducts);
  assertEmptyArray(adapter.normalizeScanIdentifyResponse({ ...completed, recommendedProducts: {} }).recommendedProducts);
});

test('adapter: normalizeScanIdentifyResponse drops malformed product entries but keeps valid ones', () => {
  const adapter = loadAdapter({});
  const out = adapter.normalizeScanIdentifyResponse({
    status: 'completed',
    attributes: { category: 'Footwear' },
    recommendedProducts: [
      { id: 'good', name: 'Sneaker' },
      null,
      'not-an-object',
      { id: 'also-good', retailer: 'Retailer' },
    ],
  });
  assert.equal(out.recommendedProducts.length, 2);
  assert.equal(out.recommendedProducts[0].id, 'good');
  assert.equal(out.recommendedProducts[1].id, 'also-good');
});

test('mapper: completed with empty recommendedProducts is still a success', () => {
  const out = mapper.mapScanIdentifyToAnalysis({
    status: 'completed',
    recommendedProducts: [],
    userMessage: 'A black dress.',
    attributes: { category: 'Dresses' },
  });
  assert.equal(out.type, 'fashion');
  assert.equal(out.result, 'A black dress.');
  assert.equal(out.metadata.category, 'Dresses');
  assertEmptyArray(out.products);
});

test('mapper: recommendedProducts preserve image/link/retailer/category fields', () => {
  const out = mapper.mapScanIdentifyToAnalysis({
    status: 'completed',
    recommendedProducts: [
      {
        id: 'shoe-1',
        name: 'White Sneaker',
        retailer: 'Test Retailer',
        image_url: 'https://placehold.co/400x600?text=Sneaker',
        product_url: 'https://example.com/sneaker',
        category: 'Footwear',
        price: 89.99,
      },
    ],
    userMessage: 'White sneaker.',
    attributes: { category: 'Footwear' },
  });
  assert.equal(out.type, 'fashion');
  assert.equal(out.products.length, 1);
  const p = out.products[0];
  assert.equal(p.name, 'White Sneaker');
  assert.equal(p.retailer, 'Test Retailer');
  assert.equal(p.image_url, 'https://placehold.co/400x600?text=Sneaker');
  assert.equal(p.product_url, 'https://example.com/sneaker');
  assert.equal(p.category, 'Footwear');
  assert.equal(p.price, 89.99);
});

test('mapper: non_fashion maps products to empty array without crashing', () => {
  const out = mapper.mapScanIdentifyToAnalysis({
    status: 'non_fashion',
    recommendedProducts: [],
    userMessage: 'Not fashion.',
  });
  assert.equal(out.type, 'non-fashion');
});

// ── Part 2: scanResultObject mapper integration ───────────────────────────────

test('mapper: completed analysis includes scanResultObject', () => {
  const out = mapper.mapScanIdentifyToAnalysis({
    status: 'completed',
    recommendedProducts: [
      { id: 'p1', name: 'Leather Jacket', imageUrl: 'https://cdn.example.com/p1.jpg' },
    ],
    identification: {
      item_type: 'jacket',
      primary_color: 'Black',
      material_estimate: 'Leather',
      confidence_score: 0.9,
      brand_guess: 'AllSaints',
    },
  });
  assert.ok(out.scanResultObject, 'scanResultObject should be present');
  assert.equal(out.scanResultObject.item.category, 'jacket');
  assert.equal(out.scanResultObject.item.material, 'Leather');
});

test('mapper: existing fields remain unchanged when scanResultObject added', () => {
  const input = {
    status: 'completed',
    recommendedProducts: [
      { id: 'p1', name: 'Leather Jacket', imageUrl: 'https://cdn.example.com/p1.jpg' },
    ],
    identification: { visual_observation: 'A black jacket.', item_type: 'jacket', confidence_score: 0.8 },
    displayResult: { headline: 'Jacket', confidenceLabel: 'high' },
  };
  const out = mapper.mapScanIdentifyToAnalysis(input);
  assert.equal(out.type, 'fashion');
  assert.equal(out.result, 'A black jacket.');
  assert.equal(out.products.length, 1);
  assert.equal(out.products[0].id, 'p1');
  assert.equal(out.displayResult.confidenceLabel, 'high');
});

test('mapper: empty/partial scan still maps safely with scanResultObject', () => {
  const out = mapper.mapScanIdentifyToAnalysis({ status: 'completed', recommendedProducts: [] });
  assert.equal(out.type, 'fashion');
  assert.ok(out.scanResultObject);
  // partial input must not crash and must degrade to a usable object
  assert.equal(typeof out.scanResultObject.explainability.confidenceLabel, 'string');
});

test('mapper: scanResultObject privacy flags are false', () => {
  const out = mapper.mapScanIdentifyToAnalysis({
    status: 'completed',
    recommendedProducts: [{ id: 'p1', imageUrl: 'https://cdn.example.com/p1.jpg' }],
    identification: { item_type: 'jacket', confidence_score: 0.8 },
  });
  assert.equal(out.scanResultObject.privacy.rawImageStored, false);
  assert.equal(out.scanResultObject.privacy.cloudPhotoStorage, false);
});

test('mapper: heroImageUrl comes from recommendedProducts, not raw image fields', () => {
  const out = mapper.mapScanIdentifyToAnalysis({
    status: 'completed',
    recommendedProducts: [
      {
        id: 'p1',
        imageUrl: 'https://cdn.example.com/catalog.jpg',
        localImageUri: 'file:///raw.jpg',
        capturedImageUri: 'file:///captured.jpg',
      },
    ],
    identification: { item_type: 'jacket', confidence_score: 0.8 },
  });
  assert.equal(out.scanResultObject.visual.heroImageUrl, 'https://cdn.example.com/catalog.jpg');
});

test('mapper: empty recommendedProducts → matches empty and heroImageUrl null', () => {
  const out = mapper.mapScanIdentifyToAnalysis({
    status: 'completed',
    recommendedProducts: [],
    identification: { item_type: 'jacket', confidence_score: 0.8, brand_guess: 'X' },
  });
  assert.equal(out.scanResultObject.matches.length, 0);
  assert.equal(out.scanResultObject.visual.heroImageUrl, null);
});

test('mapper: produces clean display title without "Match" suffix', () => {
  const out = mapper.mapScanIdentifyToAnalysis({
    status: 'completed',
    recommendedProducts: [],
    userMessage: 'red polo shirt Match',
    identification: {
      item_type: 'polo shirt',
      primary_color: 'red',
      confidence_score: 0.86,
    },
  });
  assert.equal(out.type, 'fashion');
  assert.ok(out.title, 'title should be present');
  assert.doesNotMatch(out.title, /\bMatch\b/i);
  assert.equal(out.title, 'Red Polo Shirt');
});

test('mapper: high-confidence brand appears in title', () => {
  const out = mapper.mapScanIdentifyToAnalysis({
    status: 'completed',
    recommendedProducts: [
      { brand: 'Lacoste', retailer: 'A' },
      { brand: 'Lacoste', retailer: 'B' },
      { brand: 'Lacoste', retailer: 'C' },
    ],
    identification: {
      item_type: 'polo shirt',
      primary_color: 'red',
      brand_guess: 'Lacoste',
      confidence_score: 0.9,
    },
  });
  assert.equal(out.title, 'Red Lacoste Polo Shirt');
  assert.equal(out.metadata.brandConfidence, 'high');
});

test('adapter: v119 multi-item request sends exact detection fields', async () => {
  let invokedBody = null;
  const adapter = loadAdapter({
    auth: { getSession: async () => ({ data: { session: { access_token: 'test' } } }) },
    functions: {
      invoke: async (_name, options) => {
        invokedBody = options.body;
        return {
          data: {
            status: 'completed',
            attributes: { category: 'jacket', itemType: 'blazer' },
            identification: { item_type: 'jacket', subtype: 'blazer' },
            recommendedProducts: [],
            scanSessionId: 'session_1',
            imageDigestPrefix: 'a1b2c3d4',
            detectedGarments: [{
              candidateId: 'garment-1-jacket-blazer',
              order: 0,
              label: 'black blazer',
              category: 'jacket',
              subtype: 'blazer',
              bounds: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
              attributes: { category: 'jacket', itemType: 'blazer' },
              identification: { item_type: 'jacket', subtype: 'blazer' },
            }],
          },
          error: null,
        };
      },
    },
  });

  const result = await adapter.identifyScanImage('data:image/jpeg;base64,AAAA', {
    source: 'upload',
    localPrivacyFiltered: true,
    multiItemDetection: true,
    requestMode: 'multi_item_detection',
  });

  assert.equal(invokedBody.imageBase64, 'AAAA');
  assert.equal(invokedBody.multiItemDetection, true);
  assert.equal(invokedBody.requestMode, 'multi_item_detection');
  assert.equal(invokedBody.source, 'upload');
  assert.equal(result.detectedGarments.length, 1);
  assert.equal(result.scanSessionId, 'session_1');
  assert.equal(result.imageDigestPrefix, 'a1b2c3d4');
});

test('adapter: v119 selected-item request preserves correlation and candidate bounds', async () => {
  let invokedBody = null;
  const adapter = loadAdapter({
    auth: { getSession: async () => ({ data: { session: { access_token: 'test' } } }) },
    functions: {
      invoke: async (_name, options) => {
        invokedBody = options.body;
        return {
          data: {
            status: 'completed',
            attributes: { category: 'jacket', itemType: 'blazer' },
            identification: { item_type: 'jacket', subtype: 'blazer' },
            recommendedProducts: [],
          },
          error: null,
        };
      },
    },
  });
  const selectedCandidate = {
    candidateId: 'garment-1-jacket-blazer',
    category: 'jacket',
    subtype: 'blazer',
    bounds: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
  };

  await adapter.identifyScanImage('AAAA', {
    multiItemDetection: true,
    requestMode: 'selected_item',
    scanSessionId: 'session_1',
    imageDigestPrefix: 'a1b2c3d4',
    selectedCandidate,
  });

  assert.equal(invokedBody.requestMode, 'selected_item');
  assert.equal(invokedBody.scanSessionId, 'session_1');
  assert.equal(invokedBody.imageDigestPrefix, 'a1b2c3d4');
  assert.deepEqual(JSON.parse(JSON.stringify(invokedBody.selectedCandidate)), selectedCandidate);
});

test('adapter: detected garment sanitizer drops unknown fields and duplicate ids', () => {
  const adapter = loadAdapter({});
  const rawGarment = {
    candidateId: 'garment-1-jacket-blazer',
    order: 0,
    label: 'black blazer',
    category: 'jacket',
    subtype: 'blazer',
    attributes: { category: 'jacket', itemType: 'blazer', executable: 'drop-me' },
    identification: { item_type: 'jacket', subtype: 'blazer', system_prompt: 'drop-me' },
    executable: 'drop-me',
  };
  const result = adapter.normalizeScanIdentifyResponse({
    status: 'completed',
    attributes: { category: 'jacket', itemType: 'blazer' },
    identification: { item_type: 'jacket' },
    recommendedProducts: [],
    detectedGarments: [rawGarment, rawGarment],
  });
  assert.equal(result.detectedGarments.length, 1);
  assert.equal(result.detectedGarments[0].executable, undefined);
  assert.equal(result.detectedGarments[0].attributes.executable, undefined);
  assert.equal(result.detectedGarments[0].identification.system_prompt, undefined);
});
