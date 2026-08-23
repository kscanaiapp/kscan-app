const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// services/api.js's analyzeImage() calls supabase.functions.invoke('scan-identify', ...)
// instead of the retired legacy REST endpoint. These tests load the real source
// (only the `import { supabase } from './supabaseClient'` line is stripped and
// replaced with a mock injected into the vm context) so the actual request-body
// shape, response mapping, and error handling are exercised, not a re-implementation
// of them.

function loadApiModuleWithMockSupabase(invokeImpl) {
  const filePath = path.join(__dirname, '..', 'services', 'api.js');
  let source = fs.readFileSync(filePath, 'utf8');
  source = source
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('import '))
    .join('\n')
    .replace(/^export (const|function|async function)/gm, '$1');
  source += '\nmodule.exports = { analyzeImage, getApiBaseUrl, BASE_URL };';

  const invokeCalls = [];
  const supabase = {
    functions: {
      invoke: async (name, opts) => {
        invokeCalls.push({ name, opts });
        return invokeImpl(name, opts);
      },
    },
  };

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
    supabase,
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: filePath });
  return { api: context.module.exports, invokeCalls };
}

test('analyzeImage: completed status maps to fashion with attributes and userMessage', async () => {
  const { api } = loadApiModuleWithMockSupabase(async () => ({
    data: {
      status: 'completed',
      userMessage: 'A black leather jacket with a fitted silhouette.',
      recommendedProducts: [],
      attributes: { category: 'Outerwear', silhouette: 'Fitted', colorPalette: ['Black', 'Charcoal'] },
    },
    error: null,
  }));

  const out = await api.analyzeImage('data:image/jpeg;base64,AAAA');
  assert.equal(out.type, 'fashion');
  assert.equal(out.result, 'A black leather jacket with a fitted silhouette.');
  assert.equal(out.metadata.category, 'Outerwear');
  assert.equal(out.metadata.silhouette, 'Fitted');
  assert.equal(out.metadata.color, 'Black, Charcoal');
  // Not assert.deepEqual([]) — the vm sandbox is a separate realm, so an empty
  // array constructed inside it isn't reference-comparable to one built in this
  // test file even when structurally identical; irrelevant outside this harness
  // (the real app has one realm), but real here.
  assert.ok(Array.isArray(out.products) && out.products.length === 0);
});

test('analyzeImage: completed status with a displayResult uses headline + first styling suggestion as result', async () => {
  // Shape observed from a real live call against the deployed staging function
  // (2026-08-22) — richer than the userMessage alone and not present in this
  // repo's checked-in scan-identify source, which is stale relative to deploy.
  const { api } = loadApiModuleWithMockSupabase(async () => ({
    data: {
      status: 'completed',
      userMessage: 'Low-Top Red Synthetic Mesh Running Sneakers',
      recommendedProducts: [],
      products: [],
      attributes: { category: 'footwear', silhouette: 'low-top', colorPalette: ['red', 'white'] },
      displayResult: {
        headline: 'A low-top red athletic sneaker with white laces and a ribbed sole.',
        details: 'footwear · red · synthetic mesh · regular · low-top',
        styling: [
          'Pair with athletic shorts and a light zip-up jacket for an active outdoor look.',
          'Style with relaxed denim jeans and a plain neutral t-shirt for a sporty casual outfit.',
        ],
        confidenceLabel: 'High',
      },
    },
    error: null,
  }));

  const out = await api.analyzeImage('data:image/jpeg;base64,AAAA');
  assert.equal(out.type, 'fashion');
  assert.match(out.result, /^A low-top red athletic sneaker with white laces and a ribbed sole\./);
  assert.match(out.result, /Pair with athletic shorts/);
  assert.equal(out.metadata.category, 'footwear');
});

test('analyzeImage: completed status without displayResult falls back to userMessage (older/simpler response shape)', async () => {
  const { api } = loadApiModuleWithMockSupabase(async () => ({
    data: {
      status: 'completed',
      userMessage: 'Identified a fashion item from your scan.',
      recommendedProducts: [],
      attributes: { category: 'Tops' },
    },
    error: null,
  }));

  const out = await api.analyzeImage('data:image/jpeg;base64,AAAA');
  assert.equal(out.result, 'Identified a fashion item from your scan.');
});

test('analyzeImage: falls back from empty recommendedProducts to a populated products field', async () => {
  const { api } = loadApiModuleWithMockSupabase(async () => ({
    data: {
      status: 'completed',
      userMessage: 'A red sneaker.',
      recommendedProducts: [],
      products: [{ name: 'Red Runner', brand: 'Acme', price: '$80', imageUrl: 'https://example.com/shoe.jpg' }],
      attributes: { category: 'footwear' },
    },
    error: null,
  }));

  const out = await api.analyzeImage('data:image/jpeg;base64,AAAA');
  assert.equal(out.products.length, 1);
  assert.equal(out.products[0].name, 'Red Runner');
  assert.equal(out.products[0].retailer, 'Acme');
});

test('analyzeImage: real confidenceScore is threaded through to metadata.confidence for the wearable formatter', async () => {
  const { api } = loadApiModuleWithMockSupabase(async () => ({
    data: {
      status: 'completed',
      userMessage: 'A red sneaker.',
      recommendedProducts: [],
      attributes: { category: 'footwear', confidenceScore: 0.88 },
    },
    error: null,
  }));

  const out = await api.analyzeImage('data:image/jpeg;base64,AAAA');
  assert.equal(out.metadata.confidence, 0.88);
});

test('analyzeImage: missing confidenceScore leaves metadata.confidence unset (caller default applies)', async () => {
  const { api } = loadApiModuleWithMockSupabase(async () => ({
    data: { status: 'completed', userMessage: 'x', recommendedProducts: [], attributes: { category: 'footwear' } },
    error: null,
  }));

  const out = await api.analyzeImage('data:image/jpeg;base64,AAAA');
  assert.equal('confidence' in out.metadata, false);
});

test('analyzeImage: non_fashion status maps to non-fashion type with message', async () => {
  const { api } = loadApiModuleWithMockSupabase(async () => ({
    data: { status: 'non_fashion', userMessage: 'This looks like a house plant.', recommendedProducts: [] },
    error: null,
  }));

  const out = await api.analyzeImage('data:image/jpeg;base64,AAAA');
  assert.equal(out.type, 'non-fashion');
  assert.equal(out.message, 'This looks like a house plant.');
});

test('analyzeImage: failed status throws with the server-provided safe userMessage', async () => {
  const { api } = loadApiModuleWithMockSupabase(async () => ({
    data: { status: 'failed', userMessage: "We couldn't complete this scan. Please try again in better light.", recommendedProducts: [] },
    error: null,
  }));

  await assert.rejects(
    () => api.analyzeImage('data:image/jpeg;base64,AAAA'),
    (err) => {
      assert.equal(err.userMessage, "We couldn't complete this scan. Please try again in better light.");
      return true;
    },
  );
});

test('analyzeImage: completed status with no attributes still returns fashion with empty metadata (never throws on shape)', async () => {
  const { api } = loadApiModuleWithMockSupabase(async () => ({
    data: { status: 'completed', userMessage: 'Identified a fashion item from your scan.', recommendedProducts: [] },
    error: null,
  }));

  const out = await api.analyzeImage('data:image/jpeg;base64,AAAA');
  assert.equal(out.type, 'fashion');
  assert.equal(out.metadata.category, '');
  assert.equal(out.metadata.color, '');
  assert.equal(out.metadata.silhouette, '');
});

test('analyzeImage: 401 error maps to a sign-in-specific safe message, never the raw error', async () => {
  const { api } = loadApiModuleWithMockSupabase(async () => ({
    data: null,
    error: { message: 'Unauthorized', context: { status: 401 } },
  }));

  await assert.rejects(
    () => api.analyzeImage('data:image/jpeg;base64,AAAA'),
    (err) => {
      assert.equal(err.code, 'SCAN_IDENTIFY_UNAUTHENTICATED');
      assert.match(err.userMessage, /sign in/i);
      assert.doesNotMatch(err.userMessage, /Unauthorized/);
      return true;
    },
  );
});

test('analyzeImage: generic transport error maps to a safe connection message, not the raw error object', async () => {
  const { api } = loadApiModuleWithMockSupabase(async () => ({
    data: null,
    error: { message: 'TypeError: Failed to fetch' },
  }));

  await assert.rejects(
    () => api.analyzeImage('data:image/jpeg;base64,AAAA'),
    (err) => {
      assert.equal(err.code, 'SCAN_IDENTIFY_REQUEST_FAILED');
      assert.doesNotMatch(err.userMessage, /TypeError/);
      return true;
    },
  );
});

test('analyzeImage: invalid/malformed response shape throws a safe error instead of crashing on undefined fields', async () => {
  const { api } = loadApiModuleWithMockSupabase(async () => ({ data: 'not-an-object', error: null }));

  await assert.rejects(
    () => api.analyzeImage('data:image/jpeg;base64,AAAA'),
    (err) => {
      assert.equal(err.code, 'SCAN_IDENTIFY_INVALID_RESPONSE');
      return true;
    },
  );
});

test('analyzeImage: calls scan-identify with the expected request body shape (mode, imageBase64, requestId, source)', async () => {
  const { api, invokeCalls } = loadApiModuleWithMockSupabase(async () => ({
    data: { status: 'non_fashion', userMessage: 'x', recommendedProducts: [] },
    error: null,
  }));

  await api.analyzeImage('data:image/jpeg;base64,AAAA');
  assert.equal(invokeCalls.length, 1);
  assert.equal(invokeCalls[0].name, 'scan-identify');
  const body = invokeCalls[0].opts.body;
  assert.equal(body.mode, 'image');
  assert.equal(body.imageBase64, 'data:image/jpeg;base64,AAAA');
  assert.equal(typeof body.requestId, 'string');
  assert.ok(body.requestId.length > 0);
  assert.equal(body.source, 'mobile');
  // Never sends the raw image under any other key the server doesn't expect.
  assert.deepEqual(Object.keys(body).sort(), ['imageBase64', 'mode', 'requestId', 'source']);
});

test('analyzeImage: a hung invoke call times out with a user-friendly message, not a raw AbortError', async () => {
  const originalTimeout = global.setTimeout;
  global.setTimeout = (fn, _ms, ...args) => originalTimeout(fn, 20, ...args); // fire fast for the test
  const { api } = loadApiModuleWithMockSupabase(() => new Promise(() => {})); // never resolves

  try {
    await assert.rejects(
      () => api.analyzeImage('data:image/jpeg;base64,AAAA'),
      (err) => {
        assert.equal(err.code, 'ANALYZE_TIMEOUT');
        assert.match(err.userMessage, /longer than expected/i);
        return true;
      },
    );
  } finally {
    global.setTimeout = originalTimeout;
  }
});

test('analyzeImage: does not resolve or require EXPO_PUBLIC_API_URL (the retired legacy path)', async () => {
  // process.env is empty in this sandbox (no EXPO_PUBLIC_API_URL) — analyzeImage
  // must still succeed, proving it never touches the legacy base-URL resolution.
  const { api } = loadApiModuleWithMockSupabase(async () => ({
    data: { status: 'non_fashion', userMessage: 'x', recommendedProducts: [] },
    error: null,
  }));

  const out = await api.analyzeImage('data:image/jpeg;base64,AAAA');
  assert.equal(out.type, 'non-fashion');
});
