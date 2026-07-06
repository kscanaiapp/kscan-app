const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

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
  const sandbox = {
    __DEV__: false,
    console,
    exports: mod.exports,
    module: mod,
    AbortController: globalThis.AbortController,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    require: (id) => {
      if (id in requireMap) return requireMap[id];
      if (id.startsWith('node:')) return require(id);
      throw new Error(`Unexpected require: ${id}`);
    },
  };
  vm.runInNewContext(output, sandbox, { filename });
  return mod.exports;
}

// ── 1. Canonical path regression: TextScan UI must not import legacy analyzeText ──

test('canonical path: TextScan UI imports analyzeTextWithEdge, not analyzeText', () => {
  const textScanScreen = fs.readFileSync(path.join(ROOT, 'app/text-scan/index.tsx'), 'utf8');
  assert.ok(
    textScanScreen.includes("import { analyzeTextWithEdge } from '../../services/textScanEdge'"),
    'TextScan screen must import analyzeTextWithEdge'
  );
  // The old legacy import should not be present
  const hasLegacyImport = textScanScreen.includes("import { analyzeText } from '../../services/api'");
  assert.equal(hasLegacyImport, false, 'TextScan screen must not import legacy analyzeText from services/api');
});

// ── 2. services/textScan.ts — toStyleMatch contract hardening ──

const textScan = loadTsModule('services/textScan.ts');
const { toStyleMatch } = textScan;

function makeResult(overrides = {}) {
  return {
    id: 'textscan-test-id',
    type: 'fashion_text',
    result: 'A structured black blazer.',
    metadata: {
      source: 'textscan',
      query: 'black oversized blazer',
      attributes: {
        category: 'Outerwear',
        color: 'Black',
        material: 'Wool',
        silhouette: 'Oversized',
        occasion: 'Work',
        styleDescriptors: ['minimal', 'structured'],
      },
    },
    products: [],
    confidence: 0.92,
    savedAt: new Date().toISOString(),
    ...overrides,
  };
}

test('toStyleMatch: returns canonical StyleMatch shape for full result', () => {
  const result = makeResult();
  const sm = toStyleMatch(result);

  assert.equal(sm.id, 'textscan-test-id');
  assert.equal(sm.source, 'textscan');
  assert.equal(sm.confidence, 0.92);
  assert.equal(sm.summary, 'A structured black blazer.');

  assert.equal(sm.intent.style, 'minimal, structured');
  assert.equal(sm.intent.occasion, 'Work');
  assert.equal(JSON.stringify(sm.intent.colors), JSON.stringify(['Black']));
  assert.equal(JSON.stringify(sm.intent.materials), JSON.stringify(['Wool']));
  assert.equal(sm.intent.silhouette, 'Oversized');
  assert.equal(JSON.stringify(sm.intent.keywords), JSON.stringify(['minimal', 'structured']));

  assert.ok(Array.isArray(sm.items.retail));
  assert.ok(Array.isArray(sm.items.resale));
  assert.ok(Array.isArray(sm.items.suggested));
  assert.equal(sm.items.retail.length, 0);
  assert.equal(sm.items.resale.length, 0);
  assert.equal(sm.items.suggested.length, 0);

  assert.equal(sm.actions.canSave, false);
  assert.equal(sm.actions.canOpenOnPhone, false);

  assert.equal(sm.meta.scanModeLabel, 'TextScan');
  assert.equal(sm.meta.confidenceLabel, '92%');
  assert.equal(sm.meta.isDemo, false);
});

test('toStyleMatch: handles missing category', () => {
  const result = makeResult({
    metadata: {
      source: 'textscan',
      query: 'test',
      attributes: { category: null, color: 'Blue', styleDescriptors: ['casual'] },
    },
  });
  const sm = toStyleMatch(result);
  assert.equal(sm.intent.style, 'casual');
  assert.equal(sm.intent.occasion, null);
  assert.equal(JSON.stringify(sm.intent.colors), JSON.stringify(['Blue']));
});

test('toStyleMatch: handles missing color', () => {
  const result = makeResult({
    metadata: {
      source: 'textscan',
      query: 'test',
      attributes: { category: 'Tops', color: null, styleDescriptors: [] },
    },
  });
  const sm = toStyleMatch(result);
  assert.equal(JSON.stringify(sm.intent.colors), JSON.stringify([]));
});

test('toStyleMatch: handles missing material', () => {
  const result = makeResult({
    metadata: {
      source: 'textscan',
      query: 'test',
      attributes: { category: 'Tops', material: null, styleDescriptors: [] },
    },
  });
  const sm = toStyleMatch(result);
  assert.equal(JSON.stringify(sm.intent.materials), JSON.stringify([]));
});

test('toStyleMatch: handles missing silhouette', () => {
  const result = makeResult({
    metadata: {
      source: 'textscan',
      query: 'test',
      attributes: { category: 'Tops', silhouette: null, styleDescriptors: [] },
    },
  });
  const sm = toStyleMatch(result);
  assert.equal(sm.intent.silhouette, null);
});

test('toStyleMatch: handles missing style tags', () => {
  const result = makeResult({
    metadata: {
      source: 'textscan',
      query: 'test',
      attributes: { category: 'Tops', styleDescriptors: [] },
    },
  });
  const sm = toStyleMatch(result);
  assert.equal(sm.intent.style, null);
  assert.equal(JSON.stringify(sm.intent.keywords), JSON.stringify([]));
});

test('toStyleMatch: handles non-fashion result', () => {
  const result = makeResult({
    type: 'non_fashion_text',
    confidence: 0,
    result: "This doesn't appear to be a fashion query.",
    metadata: {
      source: 'textscan',
      query: 'asdf random',
      attributes: {},
    },
  });
  const sm = toStyleMatch(result);
  assert.equal(sm.confidence, 0);
  assert.equal(sm.meta.confidenceLabel, '0%');
  assert.equal(sm.intent.style, null);
  assert.equal(JSON.stringify(sm.intent.colors), JSON.stringify([]));
});

test('toStyleMatch: handles low confidence result', () => {
  const result = makeResult({ confidence: 0.15 });
  const sm = toStyleMatch(result);
  assert.equal(sm.confidence, 0.15);
  assert.equal(sm.meta.confidenceLabel, '15%');
});

test('toStyleMatch: handles null confidence', () => {
  const result = makeResult({ confidence: null });
  const sm = toStyleMatch(result);
  assert.equal(sm.confidence, null);
  assert.equal(sm.meta.confidenceLabel, '—');
});

test('toStyleMatch: items arrays are always empty and safe', () => {
  const result = makeResult();
  const sm = toStyleMatch(result);
  assert.ok(Array.isArray(sm.items.retail));
  assert.ok(Array.isArray(sm.items.resale));
  assert.ok(Array.isArray(sm.items.suggested));
  assert.equal(sm.items.retail.length, 0);
  assert.equal(sm.items.resale.length, 0);
  assert.equal(sm.items.suggested.length, 0);
});

// ── 3. services/textScanEdge.ts — analyzeTextWithEdge contract ──

function createMockSupabaseClient(invokeResult) {
  return {
    auth: {
      getSession: () => Promise.resolve({ data: { session: { user: { id: 'test-user' } } } }),
    },
    functions: {
      invoke: async (fnName, options) => {
        const calls = invokeResult.calls || [];
        calls.push({ fnName, options });
        invokeResult.calls = calls;
        return invokeResult.response;
      },
    },
  };
}

async function loadTextScanEdgeWithMockSupabase(mockSupabase) {
  const requireMap = {
    './supabaseClient': { supabase: mockSupabase },
    './textScan': textScan,
  };
  return loadTsModule('services/textScanEdge.ts', requireMap);
}

test('analyzeTextWithEdge: sends correct request body', async () => {
  const calls = [];
  const mockSupabase = createMockSupabaseClient({
    calls,
    response: { data: { status: 'completed', attributes: { category: 'Tops' }, userMessage: 'Nice top', recommendedProducts: [] }, error: null },
  });
  const { analyzeTextWithEdge } = await loadTextScanEdgeWithMockSupabase(mockSupabase);

  const result = await analyzeTextWithEdge('black oversized blazer', { source: 'textscan' });

  assert.equal(calls.length, 1);
  const body = calls[0].options.body;
  assert.equal(body.mode, 'text');
  assert.equal(body.textQuery, 'black oversized blazer');
  assert.equal(body.source, 'textscan');
  assert.ok(body.clientTimestamp);
  assert.equal(body.imageBase64, undefined);
  assert.equal(result.type, 'fashion_text');
});

test('analyzeTextWithEdge: does not send imageBase64', async () => {
  const calls = [];
  const mockSupabase = createMockSupabaseClient({
    calls,
    response: { data: { status: 'completed', attributes: { category: 'Tops' }, userMessage: 'Nice top', recommendedProducts: [] }, error: null },
  });
  const { analyzeTextWithEdge } = await loadTextScanEdgeWithMockSupabase(mockSupabase);

  await analyzeTextWithEdge('summer linen outfit');
  const body = calls[0].options.body;
  assert.equal(body.imageBase64, undefined);
  assert.equal(body.mode, 'text');
});

test('analyzeTextWithEdge: default source is textscan', async () => {
  const calls = [];
  const mockSupabase = createMockSupabaseClient({
    calls,
    response: { data: { status: 'completed', attributes: { category: 'Tops' }, userMessage: 'Nice top', recommendedProducts: [] }, error: null },
  });
  const { analyzeTextWithEdge } = await loadTextScanEdgeWithMockSupabase(mockSupabase);

  await analyzeTextWithEdge('blue bag');
  const body = calls[0].options.body;
  assert.equal(body.source, 'textscan');
});

test('analyzeTextWithEdge: accepts future source values', async () => {
  const calls = [];
  const mockSupabase = createMockSupabaseClient({
    calls,
    response: { data: { status: 'completed', attributes: { category: 'Tops' }, userMessage: 'Nice top', recommendedProducts: [] }, error: null },
  });
  const { analyzeTextWithEdge } = await loadTextScanEdgeWithMockSupabase(mockSupabase);

  await analyzeTextWithEdge('voice query', { source: 'voice' });
  const body = calls[0].options.body;
  assert.equal(body.source, 'voice');

  await analyzeTextWithEdge('neural query', { source: 'neural' });
  const body2 = calls[1].options.body;
  assert.equal(body2.source, 'neural');
});

test('analyzeTextWithEdge: handles non-fashion edge response', async () => {
  const mockSupabase = createMockSupabaseClient({
    response: { data: { status: 'non_fashion', userMessage: 'Not fashion', recommendedProducts: [] }, error: null },
  });
  const { analyzeTextWithEdge } = await loadTextScanEdgeWithMockSupabase(mockSupabase);

  const result = await analyzeTextWithEdge('asdf random');
  assert.equal(result.type, 'non_fashion_text');
  assert.equal(result.confidence, 0);
});

test('analyzeTextWithEdge: handles failed edge response', async () => {
  const mockSupabase = createMockSupabaseClient({
    response: { data: { status: 'failed', userMessage: 'Server error', recommendedProducts: [] }, error: null },
  });
  const { analyzeTextWithEdge } = await loadTextScanEdgeWithMockSupabase(mockSupabase);

  const result = await analyzeTextWithEdge('black blazer');
  assert.equal(result.type, 'fashion_text');
  assert.equal(result.result, 'Server error');
});

test('analyzeTextWithEdge: handles invoke error safely', async () => {
  const mockSupabase = {
    auth: {
      getSession: () => Promise.resolve({ data: { session: { user: { id: 'test-user' } } } }),
    },
    functions: {
      invoke: async () => ({ data: null, error: { message: 'Supabase error' } }),
    },
  };
  const { analyzeTextWithEdge } = await loadTextScanEdgeWithMockSupabase(mockSupabase);

  try {
    await analyzeTextWithEdge('test query');
    assert.fail('Expected error');
  } catch (err) {
    assert.equal(err.message, 'TEXTSCAN_ANALYSIS_FAILED');
    assert.ok(err.userMessage);
  }
});

test('analyzeTextWithEdge: rejects unauthenticated requests', async () => {
  const mockSupabase = {
    auth: {
      getSession: () => Promise.resolve({ data: { session: null } }),
    },
    functions: { invoke: async () => ({ data: null, error: null }) },
  };
  const { analyzeTextWithEdge } = await loadTextScanEdgeWithMockSupabase(mockSupabase);

  try {
    await analyzeTextWithEdge('test query');
    assert.fail('Expected auth error');
  } catch (err) {
    assert.equal(err.message, 'TEXTSCAN_AUTH_REQUIRED');
    assert.ok(err.userMessage);
  }
});

test('analyzeTextWithEdge: trims query before sending', async () => {
  const calls = [];
  const mockSupabase = createMockSupabaseClient({
    calls,
    response: { data: { status: 'completed', attributes: { category: 'Tops' }, userMessage: 'Nice top', recommendedProducts: [] }, error: null },
  });
  const { analyzeTextWithEdge } = await loadTextScanEdgeWithMockSupabase(mockSupabase);

  await analyzeTextWithEdge('  black blazer  ');
  const body = calls[0].options.body;
  assert.equal(body.textQuery, 'black blazer');
});

// ── 4. mapEdgeResponseToTextScanResult via analyzeTextWithEdge ──

test('analyzeTextWithEdge: maps colorPalette from edge response', async () => {
  const mockSupabase = createMockSupabaseClient({
    response: {
      data: {
        status: 'completed',
        attributes: {
          category: 'Footwear',
          colorPalette: ['White', 'Off-white'],
          materialEstimate: 'Leather',
          styleTags: ['minimal', 'clean'],
          occasion: 'Everyday',
          confidenceScore: 0.88,
        },
        userMessage: 'Minimal white sneakers.',
        recommendedProducts: [],
      },
      error: null,
    },
  });
  const { analyzeTextWithEdge } = await loadTextScanEdgeWithMockSupabase(mockSupabase);
  const result = await analyzeTextWithEdge('white sneakers');
  assert.equal(result.metadata.attributes.color, 'White');
  assert.deepStrictEqual(result.metadata.attributes.styleDescriptors, ['minimal', 'clean']);
  assert.equal(result.confidence, 0.88);
});

test('analyzeTextWithEdge: maps missing fields safely', async () => {
  const mockSupabase = createMockSupabaseClient({
    response: {
      data: {
        status: 'completed',
        attributes: {
          category: 'Tops',
          confidenceScore: 0.75,
        },
        userMessage: 'A basic top.',
        recommendedProducts: [],
      },
      error: null,
    },
  });
  const { analyzeTextWithEdge } = await loadTextScanEdgeWithMockSupabase(mockSupabase);
  const result = await analyzeTextWithEdge('top');
  assert.equal(result.metadata.attributes.category, 'Tops');
  assert.equal(result.metadata.attributes.color, null);
  assert.equal(result.metadata.attributes.material, null);
  assert.equal(result.metadata.attributes.silhouette, null);
  assert.equal(result.metadata.attributes.occasion, null);
  assert.equal(JSON.stringify(result.metadata.attributes.styleDescriptors), JSON.stringify([]));
});

test('analyzeTextWithEdge: maps recommendedProducts to products', async () => {
  const mockSupabase = createMockSupabaseClient({
    response: {
      data: {
        status: 'completed',
        attributes: { category: 'Outerwear', colorPalette: ['Tan'] },
        userMessage: 'Tan trench coat.',
        recommendedProducts: [
          {
            id: 'serper-abc',
            title: 'Heritage Trench Coat',
            source: 'Burberry',
            price: '$2,590',
            type: 'retail',
            imageUrl: 'https://cdn.example.com/coat.jpg',
            productUrl: 'https://example.com/coat',
          },
          {
            id: 'brave-xyz',
            title: 'Similar Trench Coat',
            source: 'Web',
            type: 'similar',
            productUrl: 'https://example.com/similar',
          },
        ],
      },
      error: null,
    },
  });
  const { analyzeTextWithEdge } = await loadTextScanEdgeWithMockSupabase(mockSupabase);
  const result = await analyzeTextWithEdge('tan burberry trench coat');
  assert.equal(result.products.length, 2);
  assert.equal(result.products[0].title, 'Heritage Trench Coat');
  assert.equal(result.products[0].type, 'retail');
  assert.equal(result.products[0].productUrl, 'https://example.com/coat');
  assert.equal(result.products[1].type, 'similar');
  assert.equal(result.purchaseOptions?.length, 2);
});

test('analyzeTextWithEdge: maps alternate product arrays and aliases', async () => {
  const mockSupabase = createMockSupabaseClient({
    response: {
      data: {
        status: 'completed',
        attributes: { category: 'Dress' },
        analysis: 'A breezy white linen dress.',
        recommendedProducts: [],
        shoppingResults: [
          {
            productName: 'White Linen Midi Dress',
            merchant: 'Mango',
            thumbnail: 'https://cdn.example.com/linen.jpg',
            link: 'https://example.com/linen-dress',
            priceText: '$129',
            type: 'retail',
          },
        ],
      },
      error: null,
    },
  });
  const { analyzeTextWithEdge } = await loadTextScanEdgeWithMockSupabase(mockSupabase);
  const result = await analyzeTextWithEdge('white linen dress');

  assert.equal(result.result, 'A breezy white linen dress.');
  assert.equal(result.products.length, 1);
  assert.equal(result.products[0].title, 'White Linen Midi Dress');
  assert.equal(result.products[0].source, 'Mango');
  assert.equal(result.products[0].imageUrl, 'https://cdn.example.com/linen.jpg');
  assert.equal(result.products[0].productUrl, 'https://example.com/linen-dress');
  assert.equal(result.products[0].price, '$129');
  assert.equal(result.purchaseOptions?.length, 1);
});

test('analyzeTextWithEdge: falls back to identification aliases when attributes sparse', async () => {
  const mockSupabase = createMockSupabaseClient({
    response: {
      data: {
        status: 'completed',
        attributes: {},
        identification: {
          item_type: 'polo shirt',
          primary_color: 'white',
          material_estimate: 'piqué cotton',
          silhouette: 'classic fit',
          style_tags: ['preppy', 'casual'],
        },
        userMessage: 'White polo shirt.',
        recommendedProducts: [],
      },
      error: null,
    },
  });
  const { analyzeTextWithEdge } = await loadTextScanEdgeWithMockSupabase(mockSupabase);
  const result = await analyzeTextWithEdge('white polo shirt made by Polo with bear on the front');
  assert.equal(result.metadata.attributes.category, 'polo shirt');
  assert.equal(result.metadata.attributes.color, 'white');
  assert.equal(result.metadata.attributes.material, 'piqué cotton');
  assert.equal(result.metadata.attributes.silhouette, 'classic fit');
  assert.deepStrictEqual(result.metadata.attributes.styleDescriptors, ['preppy', 'casual']);
});

// ── 5. Regression fixture coverage ──

test('regression fixtures: all 12 queries are present', () => {
  const fixtures = require('./fixtures/textScanQueries.js');
  assert.equal(fixtures.TEXTSCAN_REGRESSION_QUERIES.length, 12);
  assert.equal(fixtures.TEXTSCAN_FASHION_QUERIES.length, 11);
  assert.equal(fixtures.TEXTSCAN_NON_FASHION_QUERIES.length, 3);
});

test('regression fixtures: mock edge responses are valid shapes', () => {
  const fixtures = require('./fixtures/textScanQueries.js');
  const responses = [
    fixtures.MOCK_EDGE_RESPONSE_COMPLETED,
    fixtures.MOCK_EDGE_RESPONSE_NON_FASHION,
    fixtures.MOCK_EDGE_RESPONSE_FAILED,
    fixtures.MOCK_EDGE_RESPONSE_MALFORMED,
    fixtures.MOCK_EDGE_RESPONSE_MARKDOWN_FENCED,
    fixtures.MOCK_EDGE_RESPONSE_LOW_CONFIDENCE,
    fixtures.MOCK_EDGE_RESPONSE_MISSING_FIELDS,
  ];
  for (const resp of responses) {
    assert.ok(typeof resp.status === 'string', 'Response must have status');
    assert.ok(Array.isArray(resp.recommendedProducts), 'Response must have recommendedProducts array');
  }
});

// ── 6. No-Render guard ──

test('guard: TextScan path does not use Render /api/analyze', async () => {
  const textScanScreen = fs.readFileSync(path.join(ROOT, 'app/text-scan/index.tsx'), 'utf8');
  const hasRenderCall = textScanScreen.includes('/api/analyze');
  assert.equal(hasRenderCall, false, 'TextScan screen must not call /api/analyze');

  const textScanEdge = fs.readFileSync(path.join(ROOT, 'services/textScanEdge.ts'), 'utf8');
  const hasRenderUrl = textScanEdge.includes('onrender');
  assert.equal(hasRenderUrl, false, 'textScanEdge must not reference onrender');
});

// ── 7. Source field preservation ──

test('guard: source field is preserved in request body', async () => {
  const calls = [];
  const mockSupabase = createMockSupabaseClient({
    calls,
    response: { data: { status: 'completed', attributes: { category: 'Tops' }, userMessage: 'Nice top', recommendedProducts: [] }, error: null },
  });
  const { analyzeTextWithEdge } = await loadTextScanEdgeWithMockSupabase(mockSupabase);

  await analyzeTextWithEdge('test', { source: 'manual' });
  const body = calls[0].options.body;
  assert.equal(body.source, 'manual');
});

// ── 8. Error shape safety ──

test('error safety: user-facing messages are short and safe', async () => {
  const mockSupabase = {
    auth: {
      getSession: () => Promise.resolve({ data: { session: { user: { id: 'test-user' } } } }),
    },
    functions: {
      invoke: async () => ({ data: null, error: { message: 'Internal server explosion with stack trace' } }),
    },
  };
  const { analyzeTextWithEdge } = await loadTextScanEdgeWithMockSupabase(mockSupabase);

  try {
    await analyzeTextWithEdge('test');
    assert.fail('Expected error');
  } catch (err) {
    assert.ok(err.userMessage.length < 120, 'User message should be concise');
    assert.equal(err.userMessage.includes('stack trace'), false, 'User message must not leak internals');
    assert.equal(err.userMessage.includes('explosion'), false, 'User message must not leak internals');
  }
});

// ── 9. Timeout / abort behavior ──

test('timeout: abort signal is passed to supabase invoke', async () => {
  const calls = [];
  const mockSupabase = createMockSupabaseClient({
    calls,
    response: { data: { status: 'completed', attributes: { category: 'Tops' }, userMessage: 'Nice top', recommendedProducts: [] }, error: null },
  });
  const { analyzeTextWithEdge } = await loadTextScanEdgeWithMockSupabase(mockSupabase);

  await analyzeTextWithEdge('test');
  const options = calls[0].options;
  assert.ok(options.signal instanceof AbortSignal || typeof options.signal === 'object', 'Abort signal should be passed');
});

// ── 10. Defense-in-depth: client-side validation before edge invoke ──

test('analyzeTextWithEdge: rejects invalid input before invoking edge', async () => {
  const calls = [];
  const mockSupabase = createMockSupabaseClient({
    calls,
    response: { data: { status: 'completed', attributes: { category: 'Tops' }, userMessage: 'Nice top', recommendedProducts: [] }, error: null },
  });
  const { analyzeTextWithEdge } = await loadTextScanEdgeWithMockSupabase(mockSupabase);

  try {
    await analyzeTextWithEdge('ab'); // too short
    assert.fail('Expected validation error');
  } catch (err) {
    assert.equal(err.message, 'TEXTSCAN_INVALID_INPUT');
    assert.ok(err.userMessage);
    assert.equal(calls.length, 0, 'Must not invoke edge for invalid input');
  }

  try {
    await analyzeTextWithEdge('test@example.com'); // email
    assert.fail('Expected validation error');
  } catch (err) {
    assert.equal(err.message, 'TEXTSCAN_INVALID_INPUT');
    assert.equal(calls.length, 0, 'Must not invoke edge for email input');
  }

  try {
    await analyzeTextWithEdge('```code```'); // code block
    assert.fail('Expected validation error');
  } catch (err) {
    assert.equal(err.message, 'TEXTSCAN_INVALID_INPUT');
    assert.equal(calls.length, 0, 'Must not invoke edge for code block input');
  }
});
