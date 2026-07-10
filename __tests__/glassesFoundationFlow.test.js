const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

/**
 * Simple in-memory TypeScript module loader for isolated source files.
 * Resolves relative .ts imports recursively and falls back to Node require
 * for built-ins and npm packages.
 */
function resolveRelative(request, fromDir) {
  const resolved = path.resolve(fromDir, request);
  const candidates = [
    resolved,
    `${resolved}.ts`,
    `${resolved}.js`,
    path.join(resolved, 'index.ts'),
    path.join(resolved, 'index.js'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`Cannot resolve relative module ${request} from ${fromDir}`);
}

const moduleCache = new Map();

function loadTsModule(relativeOrAbsolutePath, requireCache = {}) {
  const absolutePath = path.isAbsolute(relativeOrAbsolutePath)
    ? relativeOrAbsolutePath
    : path.join(ROOT, relativeOrAbsolutePath);

  if (moduleCache.has(absolutePath)) return moduleCache.get(absolutePath);

  const source = fs.readFileSync(absolutePath, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;

  const moduleObj = { exports: {} };
  const dir = path.dirname(absolutePath);

  const sandbox = {
    console,
    setTimeout,
    exports: moduleObj.exports,
    module: moduleObj,
    require: (id) => {
      if (id in requireCache) return requireCache[id];
      if (id.startsWith('.')) {
        const resolved = resolveRelative(id, dir);
        if (resolved.endsWith('.ts')) {
          return loadTsModule(resolved, requireCache);
        }
        return require(resolved);
      }
      return require(id);
    },
    __filename: absolutePath,
    __dirname: dir,
  };

  vm.runInNewContext(output, sandbox, { filename: absolutePath });
  moduleCache.set(absolutePath, moduleObj.exports);
  return moduleObj.exports;
}

const scanContract = loadTsModule('services/scan-contract/index.ts');
const privacy = loadTsModule('services/privacy/index.ts');
const wearables = loadTsModule('services/wearables/index.ts');

const {
  SCAN_CONTRACT_VERSION,
  buildScanRequest,
  buildScanResponse,
  validateScanRequest,
  validateScanResponse,
  normalizeLegacyAnalyzeResponse,
  toSharedScanRequest,
  toLegacyCompatibleResult,
  formatWearableScanSummary,
  normalizeFashionTerm,
  formatProductPrice,
  fixtureBlackLeatherJacket,
  fixtureWhiteRunningSneaker,
  fixtureFloralMidiDress,
  fixtureBlueOversizedDenimJacket,
  fixtureNonFashionObject,
  fixturePartialResponse,
  fixtureProviderTimeout,
  fixtureEmptyProductList,
  fixtureLegacyResponse,
  fixtureWearableMockRequest,
  createScanError,
} = scanContract;

const {
  mobileCompatibilitySanitizer,
  wearableMockSanitizer,
  assertPrivacyPolicySatisfied,
  PrivacyPolicyError,
} = privacy;

const { MockWearableTransport } = wearables;

// ───────────────────────────────────────────────────────────────────────────────
// Contract version
// ───────────────────────────────────────────────────────────────────────────────

test('contract version is 1.0.0 and exported', () => {
  assert.strictEqual(SCAN_CONTRACT_VERSION, '1.0.0');
});

test('request carries contract version', () => {
  const req = buildScanRequest('mobile_camera', { textQuery: 'blue jeans' });
  assert.strictEqual(req.contractVersion, SCAN_CONTRACT_VERSION);
});

test('response carries contract version', () => {
  const resp = buildScanResponse('req-123', 'success');
  assert.strictEqual(resp.contractVersion, SCAN_CONTRACT_VERSION);
});

test('fixture responses carry contract version', () => {
  for (const fixture of [
    fixtureBlackLeatherJacket,
    fixtureWhiteRunningSneaker,
    fixtureFloralMidiDress,
    fixtureBlueOversizedDenimJacket,
    fixtureNonFashionObject,
    fixturePartialResponse,
    fixtureProviderTimeout,
    fixtureEmptyProductList,
  ]) {
    assert.strictEqual(fixture.contractVersion, SCAN_CONTRACT_VERSION);
  }
});

// ───────────────────────────────────────────────────────────────────────────────
// Request validation
// ───────────────────────────────────────────────────────────────────────────────

test('valid image request passes validation', () => {
  const req = buildScanRequest('mobile_upload', {
    image: { base64: 'abc', mimeType: 'image/jpeg' },
  });
  const result = validateScanRequest(req);
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.errors.length, 0);
});

test('valid text request passes validation', () => {
  const req = buildScanRequest('text_scan', { textQuery: 'white sneakers' });
  const result = validateScanRequest(req);
  assert.strictEqual(result.valid, true);
});

test('request without image or text fails validation', () => {
  const req = buildScanRequest('mobile_camera', {});
  const result = validateScanRequest(req);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('image') || e.includes('textQuery')));
});

test('invalid source fails validation', () => {
  const req = buildScanRequest('mobile_camera', { textQuery: 'test' });
  req.source = 'unknown_source';
  const result = validateScanRequest(req);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('source')));
});

test('invalid image mime type fails validation', () => {
  const req = buildScanRequest('mobile_upload', {
    image: { base64: 'abc', mimeType: 'image/gif' },
  });
  const result = validateScanRequest(req);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('mimeType')));
});

test('invalid contract version fails validation', () => {
  const req = buildScanRequest('text_scan', { textQuery: 'test' });
  req.contractVersion = '0.0.1';
  const result = validateScanRequest(req);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('contractVersion')));
});

test('missing requestId fails validation', () => {
  const req = buildScanRequest('text_scan', { textQuery: 'test' });
  delete req.requestId;
  const result = validateScanRequest(req);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('requestId')));
});

test('non-object request fails validation safely', () => {
  const result = validateScanRequest(null);
  assert.strictEqual(result.valid, false);
});

// ───────────────────────────────────────────────────────────────────────────────
// Response validation
// ───────────────────────────────────────────────────────────────────────────────

test('valid success response passes validation', () => {
  const resp = buildScanResponse('req-123', 'success', {
    attributes: fixtureBlackLeatherJacket.attributes,
    products: fixtureBlackLeatherJacket.products,
  });
  const result = validateScanResponse(resp);
  assert.strictEqual(result.valid, true);
});

test('non-fashion response passes validation', () => {
  const result = validateScanResponse(fixtureNonFashionObject);
  assert.strictEqual(result.valid, true);
});

test('error response passes validation', () => {
  const result = validateScanResponse(fixtureProviderTimeout);
  assert.strictEqual(result.valid, true);
});

test('invalid status fails response validation', () => {
  const resp = buildScanResponse('req-123', 'success');
  resp.status = 'pending';
  const result = validateScanResponse(resp);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('status')));
});

test('missing required product fields fails validation', () => {
  const resp = buildScanResponse('req-123', 'success', {
    products: [{ title: 'Valid' }],
  });
  const result = validateScanResponse(resp);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('retailer')));
});

test('unknown fields are ignored during response validation', () => {
  const resp = buildScanResponse('req-123', 'success', {
    attributes: { category: 'Tops' },
  });
  resp.unknownField = 'should be ignored';
  const result = validateScanResponse(resp);
  assert.strictEqual(result.valid, true);
});

// ───────────────────────────────────────────────────────────────────────────────
// Fashion attributes normalization
// ───────────────────────────────────────────────────────────────────────────────

test('normalizeFashionTerm maps variants deterministically', () => {
  assert.strictEqual(normalizeFashionTerm('oversized'), 'Oversized');
  assert.strictEqual(normalizeFashionTerm('boxy'), 'Boxy');
  assert.strictEqual(normalizeFashionTerm('navy'), 'Navy');
  assert.strictEqual(normalizeFashionTerm('dark blue'), 'Navy');
  assert.strictEqual(normalizeFashionTerm('denim'), 'Denim');
  assert.strictEqual(normalizeFashionTerm('sneaker'), 'Sneaker');
  assert.strictEqual(normalizeFashionTerm('coat'), 'Coat');
});

test('normalizeFashionTerm preserves unknown terms', () => {
  assert.strictEqual(normalizeFashionTerm('chartreuse'), 'chartreuse');
});

test('formatProductPrice handles missing price gracefully', () => {
  assert.strictEqual(formatProductPrice({ title: 'x', retailer: 'y' }), undefined);
});

// ───────────────────────────────────────────────────────────────────────────────
// Legacy adapters
// ───────────────────────────────────────────────────────────────────────────────

test('toSharedScanRequest adapts legacy text request', () => {
  const legacy = { mode: 'text', query: 'black leather jacket', source: 'textscan' };
  const req = toSharedScanRequest(legacy);
  assert.strictEqual(req.source, 'text_scan');
  assert.strictEqual(req.textQuery, 'black leather jacket');
  assert.strictEqual(req.privacy.mode, 'passthrough');
  assert.strictEqual(req.device?.deviceClass, 'mobile');
});

test('toSharedScanRequest adapts legacy image request', () => {
  const legacy = { image: 'data:image/jpeg;base64,abc123', source: 'mobile' };
  const req = toSharedScanRequest(legacy);
  assert.strictEqual(req.source, 'mobile_upload');
  assert.strictEqual(req.image?.mimeType, 'image/jpeg');
  assert.strictEqual(req.image?.base64, 'abc123');
});

test('normalizeLegacyAnalyzeResponse handles fashion response', () => {
  const resp = normalizeLegacyAnalyzeResponse(fixtureLegacyResponse, 'legacy-req');
  assert.strictEqual(resp.status, 'success');
  assert.strictEqual(resp.attributes?.category, 'Tops');
  assert.strictEqual(resp.products?.length, 1);
  assert.strictEqual(resp.products?.[0].title, 'White Relaxed Hoodie');
});

test('normalizeLegacyAnalyzeResponse handles non-fashion response', () => {
  const legacy = { type: 'non-fashion', message: 'This is a plant.' };
  const resp = normalizeLegacyAnalyzeResponse(legacy, 'legacy-req');
  assert.strictEqual(resp.status, 'non_fashion');
  assert.match(resp.message, /plant/i);
});

test('toLegacyCompatibleResult preserves non-fashion shape', () => {
  const legacy = toLegacyCompatibleResult(fixtureNonFashionObject);
  assert.strictEqual(legacy.type, 'non-fashion');
  assert.strictEqual(Array.isArray(legacy.products), true);
  assert.strictEqual(legacy.products.length, 0);
});

test('toLegacyCompatibleResult maps products for existing UI', () => {
  const legacy = toLegacyCompatibleResult(fixtureBlackLeatherJacket);
  assert.strictEqual(legacy.type, 'fashion');
  assert.ok(Array.isArray(legacy.products));
  assert.strictEqual(legacy.products[0].name, 'Black Oversized Leather Jacket');
  assert.strictEqual(legacy.products[0].retailer, 'Mock Retailer');
  assert.strictEqual(legacy.metadata.category, 'Outerwear');
});

// ───────────────────────────────────────────────────────────────────────────────
// Privacy boundary
// ───────────────────────────────────────────────────────────────────────────────

test('mobile pass-through is labeled honestly', async () => {
  const result = await mobileCompatibilitySanitizer.sanitize({ base64: 'abc' });
  assert.strictEqual(result.mode, 'passthrough');
  assert.strictEqual(result.faceDetectionPerformed, false);
  assert.strictEqual(result.faceMaskApplied, false);
  assert.strictEqual(result.plateDetectionPerformed, false);
  assert.strictEqual(result.plateMaskApplied, false);
});

test('wearable mock sanitizer returns masked metadata only', async () => {
  const result = await wearableMockSanitizer.sanitize({ base64: 'abc' });
  assert.strictEqual(result.mode, 'masked');
  assert.strictEqual(result.faceDetectionPerformed, true);
  assert.strictEqual(result.faceMaskApplied, true);
  assert.strictEqual(result.sanitizerVersion, 'wearable-mock-1.0.0');
});

test('current mobile compatibility policy accepts passthrough', () => {
  const req = buildScanRequest('mobile_camera', { textQuery: 'test' });
  assert.doesNotThrow(() => assertPrivacyPolicySatisfied(req, 'CURRENT_MOBILE_COMPATIBILITY'));
});

test('strict wearable production policy rejects passthrough', () => {
  const req = buildScanRequest('mobile_camera', { textQuery: 'test' });
  assert.throws(
    () => assertPrivacyPolicySatisfied(req, 'WEARABLE_PRODUCTION_REQUIRED_MASKING'),
    PrivacyPolicyError,
  );
});

test('strict wearable production policy accepts masked mock request', () => {
  assert.doesNotThrow(() => assertPrivacyPolicySatisfied(fixtureWearableMockRequest, 'WEARABLE_PRODUCTION_REQUIRED_MASKING'));
});

test('metadata-only policy passes without image', () => {
  const req = buildScanRequest('text_scan', { textQuery: 'test' });
  assert.doesNotThrow(() => assertPrivacyPolicySatisfied(req, 'METADATA_ONLY'));
});

test('metadata-only policy rejects image data', () => {
  const req = buildScanRequest('mobile_upload', {
    image: { base64: 'abc', mimeType: 'image/jpeg' },
  });
  assert.throws(() => assertPrivacyPolicySatisfied(req, 'METADATA_ONLY'), PrivacyPolicyError);
});

// ───────────────────────────────────────────────────────────────────────────────
// Wearable transport
// ───────────────────────────────────────────────────────────────────────────────

test('mock transport connects and exposes a session', async () => {
  const transport = new MockWearableTransport();
  await transport.connect();
  const session = transport.getSession();
  assert.ok(session);
  assert.strictEqual(session.deviceType, 'wearable_mock');
  assert.ok(session.capabilities.camera);
  assert.strictEqual(session.capabilities.microphone, false);
});

test('mock transport disconnects and clears session', async () => {
  const transport = new MockWearableTransport();
  await transport.connect();
  await transport.disconnect();
  assert.strictEqual(transport.getSession(), null);
});

test('mock transport session expires', async () => {
  const transport = new MockWearableTransport({ sessionDurationMs: 1 });
  await transport.connect();
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(transport.getSession(), null);
});

test('mock transport returns success fixture', async () => {
  const transport = new MockWearableTransport();
  await transport.connect();
  const req = buildScanRequest('wearable_mock', { textQuery: 'jacket' });
  const resp = await transport.sendScanRequest(req);
  assert.strictEqual(resp.status, 'success');
  assert.strictEqual(resp.attributes?.category, 'Outerwear');
});

test('mock transport returns timeout fixture for timeout trigger', async () => {
  const transport = new MockWearableTransport();
  await transport.connect();
  const req = buildScanRequest('wearable_mock', { textQuery: 'timeout' });
  const resp = await transport.sendScanRequest(req);
  assert.strictEqual(resp.status, 'error');
  assert.strictEqual(resp.error?.code, 'ANALYSIS_TIMEOUT');
});

test('mock transport returns error when not connected', async () => {
  const transport = new MockWearableTransport();
  const req = buildScanRequest('wearable_mock', { textQuery: 'jacket' });
  const resp = await transport.sendScanRequest(req);
  assert.strictEqual(resp.status, 'error');
  assert.strictEqual(resp.error?.code, 'AUTH_REQUIRED');
});

test('mock transport returns empty product list for empty trigger', async () => {
  const transport = new MockWearableTransport();
  await transport.connect();
  const req = buildScanRequest('wearable_mock', { textQuery: 'empty' });
  const resp = await transport.sendScanRequest(req);
  assert.strictEqual(resp.status, 'success');
  assert.strictEqual(Array.isArray(resp.products), true);
  assert.strictEqual(resp.products.length, 0);
});

// ───────────────────────────────────────────────────────────────────────────────
// Wearable formatter
// ───────────────────────────────────────────────────────────────────────────────

test('formatWearableScanSummary is concise for success', () => {
  const summary = formatWearableScanSummary(fixtureBlackLeatherJacket);
  const sentences = summary.split(/\.(?=\s|$)/).filter((s) => s.trim().length > 0);
  assert.ok(sentences.length <= 3, `expected <= 3 sentences, got ${sentences.length}: ${summary}`);
  assert.match(summary, /black/i);
  assert.doesNotMatch(summary, /https?:/);
  assert.doesNotMatch(summary, /\*/);
});

test('formatWearableScanSummary handles non-fashion', () => {
  const summary = formatWearableScanSummary(fixtureNonFashionObject);
  assert.match(summary, /not a fashion item|wooden chair/i);
});

test('formatWearableScanSummary handles provider error', () => {
  const summary = formatWearableScanSummary(fixtureProviderTimeout);
  assert.match(summary, /try again/i);
});

test('formatWearableScanSummary handles empty product list', () => {
  const summary = formatWearableScanSummary(fixtureEmptyProductList);
  assert.ok(summary.length > 0);
  assert.match(summary, /No matching products found/i);
});

test('formatWearableScanSummary handles partial response', () => {
  const summary = formatWearableScanSummary(fixturePartialResponse);
  assert.match(summary, /partial/i);
});

test('formatWearableScanSummary handles missing price and retailer', () => {
  const resp = buildScanResponse('req-123', 'success', {
    attributes: { category: 'Tops', color: 'White' },
    products: [{ title: 'Plain White Tee', retailer: 'Retailer unavailable' }],
  });
  const summary = formatWearableScanSummary(resp);
  assert.doesNotMatch(summary, /from Retailer unavailable/);
  assert.doesNotMatch(summary, /at \$/);
});

test('formatWearableScanSummary states low confidence honestly', () => {
  const resp = buildScanResponse('req-123', 'success', {
    attributes: { category: 'Accessories', color: 'Brown', confidence: 0.3 },
    products: [{ title: 'Brown Belt', retailer: 'Mock Retailer', similarity: 0.35 }],
  });
  const summary = formatWearableScanSummary(resp);
  assert.match(summary, /Low confidence/i);
});

// ───────────────────────────────────────────────────────────────────────────────
// Safety: no prohibited PII in fixtures
// ───────────────────────────────────────────────────────────────────────────────

test('fixtures do not contain prohibited PII properties', () => {
  const forbiddenKeys = new Set(['name', 'email', 'phone', 'gps', 'latitude', 'longitude', 'authToken', 'password']);

  function collectKeys(value, seen = new Set()) {
    if (seen.has(value)) return new Set();
    if (Array.isArray(value)) {
      const keys = new Set();
      for (const item of value) {
        for (const k of collectKeys(item, seen)) keys.add(k);
      }
      return keys;
    }
    if (value && typeof value === 'object') {
      seen.add(value);
      const keys = new Set(Object.keys(value));
      for (const v of Object.values(value)) {
        for (const k of collectKeys(v, seen)) keys.add(k);
      }
      return keys;
    }
    return new Set();
  }

  const fixturesToCheck = [fixtureWearableMockRequest, ...scanContract.allFixtureResponses];
  for (const fixture of fixturesToCheck) {
    const keys = collectKeys(fixture);
    for (const key of forbiddenKeys) {
      assert.strictEqual(keys.has(key), false, `fixture contains forbidden key: ${key}`);
    }
  }
});
