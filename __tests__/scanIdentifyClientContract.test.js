// Client-side scan-identify contract tests.
//
// These assert that the mobile Scanner transport (services/api.js) produces a
// request the FROZEN backend gateway actually accepts, and that every documented
// scan-identify response status maps to the shape the scan UI consumes.
//
// The request assertion is deliberately not a restatement of the client code:
// it feeds the real body through the backend's own normalizeLegacyBody() and
// validateKScanAIRequest() (transpiled from supabase/functions/scan-identify),
// so a client/backend drift fails here instead of in the field.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

// ── Load the frozen backend gateway helpers (Deno-safe, no network) ───────────

function loadTsModule(relativePath) {
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
    console,
    exports: mod.exports,
    module: mod,
    Date,
    Math,
    Number,
    Object,
    Array,
    JSON,
    String,
    Boolean,
    require: (id) => {
      if (id.startsWith('./')) {
        const baseDir = path.dirname(filename);
        const resolved = path.resolve(baseDir, id);
        const tsPath = resolved.endsWith('.ts') ? resolved : `${resolved}.ts`;
        return loadTsModule(path.relative(ROOT, tsPath));
      }
      throw new Error(`Unexpected require: ${id}`);
    },
  };
  vm.runInNewContext(output, sandbox, { filename });
  return mod.exports;
}

const adapter = loadTsModule('supabase/functions/scan-identify/gatewayAdapter.ts');
const validation = loadTsModule('supabase/functions/scan-identify/gatewayValidation.ts');

// ── Load services/api.js with mocked native/Supabase dependencies ─────────────

function stripImports(source) {
  const lines = source.split(/\r?\n/);
  const kept = [];
  let skipping = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!skipping && trimmed.startsWith('import ')) {
      skipping = !trimmed.endsWith(';');
      continue;
    }
    if (skipping) {
      skipping = !trimmed.endsWith(';');
      continue;
    }
    kept.push(line);
  }
  return kept.join('\n');
}

/**
 * @param {object} opts
 * @param {(fn: string, options: object) => Promise<object>} opts.invoke
 * @param {string} [opts.platform]
 */
function loadApiWithMocks({ invoke, platform = 'ios' }) {
  const apiPath = path.join(ROOT, 'services', 'api.js');
  let source = stripImports(fs.readFileSync(apiPath, 'utf8'));
  source = source.replace(/^export /gm, '');
  source += '\nmodule.exports = { analyzeImage, mapScanAttributesToMetadata };';

  const mod = { exports: {} };
  const sandbox = {
    module: mod,
    exports: mod.exports,
    __DEV__: false,
    console,
    process: { env: {} },
    setTimeout,
    clearTimeout,
    AbortController,
    Date,
    Math,
    Number,
    Object,
    Array,
    JSON,
    String,
    Boolean,
    Set,
    TypeError,
    Error,
    Promise,
    Platform: { OS: platform },
    supabase: { functions: { invoke } },
  };

  vm.runInNewContext(source, sandbox, { filename: apiPath });
  return mod.exports;
}

const SAMPLE_IMAGE = `data:image/jpeg;base64,${Buffer.from('k-scan-test-image-payload').toString('base64')}`;

function completedResponse() {
  return {
    data: {
      status: 'completed',
      recommendedProducts: [],
      userMessage: 'Identified a fashion item from your scan.',
      attributes: {
        category: 'Footwear',
        itemType: 'sneaker',
        silhouette: 'Low-top',
        colorPalette: ['Black', 'White'],
        materialEstimate: 'leather',
        pattern: 'solid',
        texture: 'smooth',
        styleTags: ['Streetwear', 'Casual'],
        occasion: 'everyday',
        confidenceScore: 0.82,
      },
    },
    error: null,
  };
}

// ── 1. The client calls the governed function, not a legacy HTTP host ─────────

test('analyzeImage invokes the scan-identify Edge Function', async () => {
  let calledFn = null;
  const api = loadApiWithMocks({
    invoke: async (fn) => {
      calledFn = fn;
      return completedResponse();
    },
  });

  await api.analyzeImage(SAMPLE_IMAGE);
  assert.equal(calledFn, 'scan-identify');
});

test('services/api.js contains no direct identification fetch to a legacy host', () => {
  const source = fs.readFileSync(path.join(ROOT, 'services', 'api.js'), 'utf8');

  // Strip comments so documentation about the retired route cannot satisfy — or
  // defeat — an assertion that is about executable code.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  assert.doesNotMatch(code, /fetch\(\s*endpoint/, 'identification must not use a raw legacy fetch');
  assert.doesNotMatch(code, /\/api\/analyze/, 'the retired Render analyze route must not be called');
  assert.doesNotMatch(code, /kscan-app-1\.onrender\.com/);
});

// ── 2. The request body is accepted by the FROZEN backend validator ───────────

test('client request body passes the frozen gateway normalizer and validator', async () => {
  let capturedBody = null;
  const api = loadApiWithMocks({
    invoke: async (_fn, options) => {
      capturedBody = options.body;
      return completedResponse();
    },
  });

  await api.analyzeImage(SAMPLE_IMAGE);

  assert.ok(capturedBody, 'a request body must be sent');

  // The gateway promotes the legacy body to the canonical request.
  const canonical = adapter.normalizeLegacyBody(capturedBody);
  assert.equal(canonical.inputType, 'image');
  assert.equal(canonical.surface, 'mobile_scan');
  assert.equal(canonical.apiVersion, '1.0');

  // The canonical request must then survive the gateway's own validator.
  const result = validation.validateKScanAIRequest(canonical);
  assert.equal(
    result.ok,
    true,
    `frozen validator rejected the client request: ${JSON.stringify(result.response?.errors)}`,
  );

  // And the image payload must be parseable by the gateway's image parser.
  const parsed = validation.parseGatewayImageInput(canonical.input);
  assert.ok(parsed, 'gateway must be able to parse the client image payload');
  assert.equal(parsed.mimeType, 'image/jpeg');
});

test('request declares image mode and a truthful privacy state', async () => {
  let capturedBody = null;
  const api = loadApiWithMocks({
    invoke: async (_fn, options) => {
      capturedBody = options.body;
      return completedResponse();
    },
  });

  await api.analyzeImage(SAMPLE_IMAGE);

  assert.equal(capturedBody.mode, 'image');
  assert.equal(capturedBody.imageMimeType, 'image/jpeg');
  assert.ok(capturedBody.requestId, 'a requestId must be sent for gateway telemetry');
  assert.ok(capturedBody.imageBytes > 0, 'imageBytes must be reported');

  // services/privacyImageSanitizer.js is a documented pass-through. Claiming
  // localPrivacyFiltered:true here would assert PII masking that never happened.
  assert.equal(
    capturedBody.localPrivacyFiltered,
    false,
    'client must not claim local privacy filtering while the sanitizer is pass-through',
  );

  const sanitizer = fs.readFileSync(
    path.join(ROOT, 'services', 'privacyImageSanitizer.js'),
    'utf8',
  );
  assert.match(
    sanitizer,
    /mode:\s*'passthrough'/,
    'if the sanitizer stops being pass-through, localPrivacyFiltered must be revisited',
  );
});

test('request reports the running platform as its source', async () => {
  let capturedBody = null;
  const api = loadApiWithMocks({
    platform: 'ios',
    invoke: async (_fn, options) => {
      capturedBody = options.body;
      return completedResponse();
    },
  });

  await api.analyzeImage(SAMPLE_IMAGE);
  assert.equal(capturedBody.source, 'ios');
});

// ── 3. Response mapping across every documented status ───────────────────────

test('completed response maps attributes onto the scan UI metadata shape', async () => {
  const api = loadApiWithMocks({ invoke: async () => completedResponse() });
  const out = await api.analyzeImage(SAMPLE_IMAGE);

  assert.equal(out.type, 'fashion');
  assert.equal(out.result, 'Identified a fashion item from your scan.');
  assert.equal(out.metadata.category, 'Footwear');
  assert.equal(out.metadata.silhouette, 'Low-top');
  assert.equal(out.metadata.color, 'Black / White');
  assert.equal(out.metadata.itemType, 'sneaker');
  assert.equal(out.metadata.material, 'leather');
  assert.equal(out.metadata.style, 'Streetwear');
  assert.deepEqual(Array.from(out.metadata.styleTags), ['Streetwear', 'Casual']);
  assert.equal(out.metadata.categoryConfidence, 0.82);
  assert.deepEqual(Array.from(out.products), []);
});

test('non_fashion response maps to the graceful non-fashion path, not an error', async () => {
  const api = loadApiWithMocks({
    invoke: async () => ({
      data: {
        status: 'non_fashion',
        recommendedProducts: [],
        userMessage: 'This does not appear to be a fashion item.',
      },
      error: null,
    }),
  });

  const out = await api.analyzeImage(SAMPLE_IMAGE);
  assert.equal(out.type, 'non-fashion');
  assert.match(out.message, /does not appear to be a fashion item/i);
});

test('failed response surfaces the server message and never fakes a result', async () => {
  const api = loadApiWithMocks({
    invoke: async () => ({
      data: {
        status: 'failed',
        recommendedProducts: [],
        userMessage: 'Image too large. Please retake the photo closer or in better light.',
      },
      error: null,
    }),
  });

  await assert.rejects(
    () => api.analyzeImage(SAMPLE_IMAGE),
    (err) => {
      assert.equal(err.code, 'SCAN_IDENTIFY_FAILED');
      assert.match(err.userMessage, /Image too large/);
      return true;
    },
  );
});

test('an unrecognized status is treated as a failure, not an empty success', async () => {
  const api = loadApiWithMocks({
    invoke: async () => ({ data: { status: 'something_new' }, error: null }),
  });

  await assert.rejects(() => api.analyzeImage(SAMPLE_IMAGE), /SCAN_IDENTIFY_FAILED/);
});

// ── 4. Error paths ───────────────────────────────────────────────────────────

test('an unauthenticated function error asks the user to sign in again', async () => {
  const api = loadApiWithMocks({
    invoke: async () => ({
      data: null,
      error: {
        name: 'FunctionsHttpError',
        message: 'Edge Function returned a non-2xx status code',
        context: { json: async () => ({ error: 'Not authenticated' }) },
      },
    }),
  });

  await assert.rejects(
    () => api.analyzeImage(SAMPLE_IMAGE),
    (err) => {
      assert.equal(err.code, 'SCAN_NOT_AUTHENTICATED');
      assert.match(err.userMessage, /sign in/i);
      return true;
    },
  );
});

test('a transport error surfaces a user-safe message without leaking internals', async () => {
  const api = loadApiWithMocks({
    invoke: async () => ({
      data: null,
      error: { name: 'FunctionsFetchError', message: 'Failed to send a request to the Edge Function' },
    }),
  });

  await assert.rejects(
    () => api.analyzeImage(SAMPLE_IMAGE),
    (err) => {
      assert.equal(err.code, 'SCAN_IDENTIFY_UNAVAILABLE');
      assert.doesNotMatch(err.userMessage, /Edge Function/);
      return true;
    },
  );
});

test('a missing image is rejected before any network call', async () => {
  let invoked = false;
  const api = loadApiWithMocks({
    invoke: async () => {
      invoked = true;
      return completedResponse();
    },
  });

  await assert.rejects(() => api.analyzeImage(''), /SCAN_IMAGE_MISSING/);
  assert.equal(invoked, false, 'an empty payload must not reach the Edge Function');
});

// ── 5. Attribute mapper unit coverage ────────────────────────────────────────

test('mapScanAttributesToMetadata tolerates absent and malformed attributes', () => {
  const api = loadApiWithMocks({ invoke: async () => completedResponse() });

  const empty = api.mapScanAttributesToMetadata(undefined);
  assert.equal(empty.category, '');
  assert.equal(empty.color, '');
  assert.deepEqual(Array.from(empty.styleTags), []);
  assert.equal(empty.categoryConfidence, undefined);

  const messy = api.mapScanAttributesToMetadata({
    category: 'Tops',
    colorPalette: ['Navy', 42, '', 'Cream'],
    styleTags: 'not-an-array',
    confidenceScore: 'high',
  });
  assert.equal(messy.category, 'Tops');
  assert.equal(messy.color, 'Navy / Cream');
  assert.deepEqual(Array.from(messy.styleTags), []);
  assert.equal(messy.categoryConfidence, undefined);
});

test('the gateway never returns brand, so the client must not invent one', () => {
  const api = loadApiWithMocks({ invoke: async () => completedResponse() });
  const mapped = api.mapScanAttributesToMetadata(completedResponse().data.attributes);
  assert.equal(mapped.brand, undefined);
});
