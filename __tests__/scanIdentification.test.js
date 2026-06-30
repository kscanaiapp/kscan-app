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

// Mapper has only type-only imports (erased on transpile) → no requireMap needed.
const mapper = loadTsModule('services/scanIdentificationMapper.ts');

function loadAdapter(supabaseStub) {
  return loadTsModule('services/scanIdentification.ts', {
    './supabaseClient': { supabase: supabaseStub },
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
  const adapter = loadAdapter({
    auth: { getSession: async () => ({ data: { session: { user: { id: 'u1' } } } }) },
    functions: {
      invoke: async (_fn, opts) => {
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
