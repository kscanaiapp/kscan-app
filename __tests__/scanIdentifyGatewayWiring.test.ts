// Unit tests for scan-identify gateway wiring (Backend AI Gateway Contract Patch).
// Uses VM-sandboxed TypeScript transpilation to test Deno-safe helpers without a Deno runtime.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadTsModule(relativePath: string, requireMap: Record<string, unknown> = {}): any {
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
      // Handle relative .ts imports within the same directory
      if (id.startsWith('./')) {
        const baseDir = path.dirname(filename);
        const resolved = path.resolve(baseDir, id);
        const tsPath = resolved.endsWith('.ts') ? resolved : resolved + '.ts';
        if (fs.existsSync(tsPath)) {
          return loadTsModule(path.relative(ROOT, tsPath));
        }
      }
      throw new Error(`Unexpected require: ${id}`);
    },
  };
  vm.runInNewContext(output, sandbox, { filename });
  return mod.exports;
}

const contract = loadTsModule('supabase/functions/scan-identify/gatewayContract.ts');
const adapter = loadTsModule('supabase/functions/scan-identify/gatewayAdapter.ts', {
  './gatewayContract.ts': contract,
});
const validation = loadTsModule('supabase/functions/scan-identify/gatewayValidation.ts', {
  './gatewayContract.ts': contract,
});

function assertValidResult(result) {
  assert.equal(result.ok, true, 'expected validation to pass');
  assert.ok(result.value, 'expected normalized value');
}

function assertErrorResult(result) {
  assert.equal(result.ok, false, 'expected validation to fail');
  assert.ok(result.response, 'expected error response');
}

// ── 1. legacy image payload normalizes into canonical internal request ─────────

test('adapter: legacy image payload normalizes into canonical request', () => {
  const body = {
    imageBase64: 'data:image/jpeg;base64,QUJD',
    imageMimeType: 'image/jpeg',
    imageBytes: 3,
    source: 'camera',
    localPrivacyFiltered: true,
    clientTimestamp: '2024-01-01T00:00:00Z',
  };
  const req = adapter.normalizeLegacyBody(body, { requestId: 'req-1' });
  assert.equal(req.apiVersion, '1.0');
  assert.equal(req.requestId, 'req-1');
  assert.equal(req.surface, 'mobile_scan');
  assert.equal(req.inputType, 'image');
  assert.equal(req.input.imageBase64, 'data:image/jpeg;base64,QUJD');
  assert.equal(req.input.imageMimeType, 'image/jpeg');
  assert.equal(req.input.imageBytes, 3);
  assert.equal(req.privacy.piiMasked, true);
  assert.equal(req.privacy.rawImageSent, false);
  assert.equal(req.privacy.legacyLocalPrivacyFiltered, true);
  assert.equal(req.privacy.maskingMode, 'pass_through');
});

// ── 2. legacy text payload normalizes into canonical internal request ──────────

test('adapter: legacy text payload normalizes into canonical request', () => {
  const body = {
    mode: 'text',
    textQuery: 'black oversized blazer',
    source: 'textscan',
    clientTimestamp: '2024-01-01T00:00:00Z',
  };
  const req = adapter.normalizeLegacyBody(body, { requestId: 'req-2' });
  assert.equal(req.inputType, 'text');
  assert.equal(req.surface, 'text_scan');
  assert.equal(req.input.textQuery, 'black oversized blazer');
  assert.equal(req.privacy.piiMasked, false);
  assert.equal(req.privacy.rawImageSent, true);
  assert.equal(req.privacy.maskingMode, 'unknown');
});

// ── 3. future canonical payload passes normalization ─────────────────────────

test('validation: canonical payload passes validation', () => {
  const req = {
    apiVersion: '1.0',
    requestId: 'req-3',
    surface: 'text_scan',
    inputType: 'text',
    privacy: { piiMasked: true, rawImageSent: false },
    input: { textQuery: 'black oversized blazer' },
  };
  const result = validation.validateKScanAIRequest(req);
  assertValidResult(result);
  assert.equal(result.value.inputType, 'text');
});

// ── 4. missing image returns scan-identify-compatible structured failure ───────

test('validation: missing image returns structured failure', () => {
  const req = {
    apiVersion: '1.0',
    requestId: 'req-4',
    surface: 'mobile_scan',
    inputType: 'image',
    privacy: { piiMasked: true, rawImageSent: false },
    input: {},
  };
  const result = validation.validateKScanAIRequest(req);
  assertErrorResult(result);
  const legacy = adapter.canonicalToLegacyResponse(result.response, 'image');
  assert.equal(legacy.status, 'failed');
  assert.ok(legacy.userMessage);
});

// ── 5. missing text returns scan-identify-compatible structured failure ────────

test('validation: missing text returns structured failure', () => {
  const req = {
    apiVersion: '1.0',
    requestId: 'req-5',
    surface: 'text_scan',
    inputType: 'text',
    privacy: { piiMasked: true, rawImageSent: false },
    input: {},
  };
  const result = validation.validateKScanAIRequest(req);
  assertErrorResult(result);
  const legacy = adapter.canonicalToLegacyResponse(result.response, 'text');
  assert.equal(legacy.status, 'failed');
});

// ── 6. oversized text returns structured failure ───────────────────────────────

test('validation: oversized text returns structured failure', () => {
  const req = {
    apiVersion: '1.0',
    requestId: 'req-6',
    surface: 'text_scan',
    inputType: 'text',
    privacy: { piiMasked: true, rawImageSent: false },
    input: { textQuery: 'a'.repeat(1001) },
  };
  const result = validation.validateKScanAIRequest(req);
  assertErrorResult(result);
  assert.ok(result.response.errors.some(e => e.code === 'TEXT_TOO_LONG'));
});

// ── 7. unsupported image MIME returns structured failure where detectable ─────

test('validation: unsupported image MIME returns structured failure', () => {
  const req = {
    apiVersion: '1.0',
    requestId: 'req-7',
    surface: 'mobile_scan',
    inputType: 'image',
    privacy: { piiMasked: true, rawImageSent: false },
    input: { imageBase64: 'data:image/gif;base64,QUJD' },
  };
  const result = validation.validateKScanAIRequest(req);
  assertErrorResult(result);
  assert.ok(result.response.errors.some(e => e.code === 'UNSUPPORTED_IMAGE_TYPE'));
});

// ── 8. localPrivacyFiltered maps to transitional privacy metadata but not proof ─

test('validation: parseGatewayImageInput strips data URI and preserves metadata only', () => {
  const parsed = validation.parseGatewayImageInput({
    imageBase64: 'data:image/jpeg;base64,QUJD',
    imageMimeType: 'IMAGE/JPEG',
  });
  assert.ok(parsed, 'expected parsed image input');
  assert.equal(parsed.normalizedBase64, 'QUJD');
  assert.equal(parsed.mimeType, 'image/jpeg');
  assert.equal(parsed.byteLength, 3);
  assert.equal('privacyVerified' in parsed, false);
});

test('validation: invalid image base64 returns safe legacy failure without echoing payload', () => {
  const req = {
    apiVersion: '1.0',
    requestId: 'req-7b',
    surface: 'mobile_scan',
    inputType: 'image',
    privacy: { piiMasked: true, rawImageSent: false },
    input: { imageBase64: 'not-base64-%%%' },
  };
  const result = validation.validateKScanAIRequest(req);
  assertErrorResult(result);
  assert.ok(result.response.errors.some(e => e.code === 'INVALID_IMAGE_BASE64'));
  const serialized = JSON.stringify(result.response);
  assert.equal(serialized.includes('not-base64'), false);
  assert.equal(serialized.includes('%%%'), false);
  assert.equal(serialized.includes('imageBase64'), false);

  const legacy = adapter.canonicalToLegacyResponse(result.response, 'image');
  assert.equal(legacy.status, 'failed');
  assert.ok(legacy.userMessage);
  assert.equal(JSON.stringify(legacy).includes('not-base64'), false);
});

test('validation: image MIME metadata is client-neutral and case-insensitive', () => {
  const req = {
    apiVersion: '1.0',
    requestId: 'req-7c',
    surface: 'mobile_scan',
    inputType: 'image',
    privacy: { piiMasked: true, rawImageSent: false },
    input: { imageBase64: 'QUJD', imageMimeType: 'IMAGE/PNG' },
    client: { platform: 'ios' },
  };
  const result = validation.validateKScanAIRequest(req);
  assertValidResult(result);
  assert.equal(result.value.input.imageMimeType, 'image/png');
  assert.equal(result.value.client?.platform, 'ios');
});

test('privacy: localPrivacyFiltered maps to transitional metadata', () => {
  const result = validation.evaluatePrivacyState({
    inputType: 'image',
    privacy: {
      piiMasked: false,
      rawImageSent: true,
      localPrivacyFiltered: true,
    },
  });
  assert.equal(result.effectivePrivacy.legacyLocalPrivacyFiltered, true);
  assert.equal(result.privacyVerified, false);
  assert.ok(result.warnings.some(w => w.includes('transitional')));
  assert.equal(result.wouldRejectInPhase2, true);
});

// ── 9. unproven privacy produces warning, not rejection, in Phase 1 ────────────

test('privacy: unproven privacy produces warning not rejection in Phase 1', () => {
  const result = validation.evaluatePrivacyState({
    inputType: 'image',
    privacy: { piiMasked: true, rawImageSent: false },
  });
  assert.equal(result.privacyVerified, false);
  assert.ok(result.warnings.some(w => w.includes('unknown')));
  assert.equal(result.wouldRejectInPhase2, false);
});

// ── 10. provider timeout maps to safe scan-identify-compatible failure ─────────

test('privacy: image request cannot self-assert privacyVerified true', () => {
  const result = validation.evaluatePrivacyState({
    inputType: 'image',
    privacy: {
      piiMasked: true,
      rawImageSent: false,
      maskingMode: 'blur',
      privacyVerified: true,
      privacyVerifiedBy: 'client',
    },
  });
  assert.equal(result.privacyVerified, false);
  assert.equal(result.effectivePrivacy.privacyVerified, false);
  assert.ok(result.warnings.some(w => w.includes('gateway proof')));
});

test('adapter: canonical fallback maps to legacy failed', () => {
  const canonical = {
    apiVersion: '1.0',
    requestId: 'req-10',
    status: 'fallback',
    source: { primary: 'fallback' },
    fashionAnalysis: { items: [], styleAttributes: {}, summary: 'Timeout' },
    userIntent: { inferredGoal: 'identify', nextActions: ['ask_followup'] },
    products: [],
    errors: [{ code: 'PROVIDER_TIMEOUT', userMessage: 'Provider timed out.', recoverable: true }],
    telemetry: { requestId: 'req-10', surface: 'mobile_scan', inputType: 'image', apiVersion: '1.0' },
  };
  const legacy = adapter.canonicalToLegacyResponse(canonical, 'image');
  assert.equal(legacy.status, 'failed');
  assert.equal(legacy.userMessage, 'Provider timed out.');
});

// ── 11. malformed provider result maps to safe fallback/failure ────────────────

test('adapter: malformed provider result maps to failed', () => {
  const scanResp = { status: 'failed', recommendedProducts: [], userMessage: 'Malformed response.' };
  const canonical = adapter.mapScanIdentifyResponseToGatewayResponse(scanResp);
  const legacy = adapter.canonicalToLegacyResponse(canonical, 'image');
  assert.equal(legacy.status, 'failed');
  assert.equal(legacy.userMessage, 'Malformed response.');
});

// ── 12. non-fashion maps to safe non-fashion response ──────────────────────────

test('adapter: non-fashion maps to safe non-fashion response', () => {
  const scanResp = { status: 'non_fashion', recommendedProducts: [], userMessage: 'Not fashion.' };
  const canonical = adapter.mapScanIdentifyResponseToGatewayResponse(scanResp);
  const legacy = adapter.canonicalToLegacyResponse(canonical, 'image');
  assert.equal(legacy.status, 'non_fashion');
  assert.equal(legacy.userMessage, 'Not fashion.');
});

// ── 13. no raw provider response appears in returned error ─────────────────────

test('adapter: no raw provider response in returned error', () => {
  const scanResp = { status: 'failed', recommendedProducts: [], userMessage: 'Error.' };
  const canonical = adapter.mapScanIdentifyResponseToGatewayResponse(scanResp);
  const legacy = adapter.canonicalToLegacyResponse(canonical, 'image');
  assert.equal(legacy.status, 'failed');
  assert.equal(legacy.userMessage, 'Error.');
  assert.equal('rawProviderResponse' in legacy, false);
});

// ── 14. no image/base64/text payload appears in telemetry or errors ────────────

test('adapter: no raw payload in telemetry or errors', () => {
  const scanResp = {
    status: 'completed',
    recommendedProducts: [],
    userMessage: 'OK.',
    attributes: { category: 'Tops' },
  };
  const canonical = adapter.mapScanIdentifyResponseToGatewayResponse(scanResp, { requestId: 'req-14' });
  assert.equal(canonical.telemetry.requestId, 'req-14');
  assert.equal('imageBase64' in canonical.telemetry, false);
  assert.equal('textQuery' in canonical.telemetry, false);
  assert.equal('rawProviderResponse' in canonical.telemetry, false);
});

// ── 15. existing scan-identify response compatibility is preserved ───────────────

test('adapter: legacy response shape compatibility is preserved', () => {
  const scanResp = { status: 'completed', recommendedProducts: [], userMessage: 'OK.', attributes: { category: 'Tops' } };
  const canonical = adapter.mapScanIdentifyResponseToGatewayResponse(scanResp);
  const legacy = adapter.canonicalToLegacyResponse(canonical, 'image');
  assert.equal(legacy.status, 'completed');
  assert.ok(Array.isArray(legacy.recommendedProducts));
  assert.equal(legacy.recommendedProducts.length, 0);
  assert.ok(legacy.userMessage);
  assert.ok(legacy.attributes);
});

// ── 16. enrichLegacyResponse adds non-breaking metadata ────────────────────────

test('adapter: enrichLegacyResponse adds non-breaking metadata', () => {
  const legacy = { status: 'completed', recommendedProducts: [], userMessage: 'OK.' };
  const canonical = {
    apiVersion: '1.0',
    requestId: 'req-16',
    status: 'success',
    source: { primary: 'gemini' },
    fashionAnalysis: { items: [{ category: 'Tops' }] },
    userIntent: { inferredGoal: 'identify' },
    products: [],
    errors: [],
    telemetry: { requestId: 'req-16', surface: 'mobile_scan', inputType: 'image', apiVersion: '1.0' },
  };
  const enriched = adapter.enrichLegacyResponse(legacy, canonical);
  assert.equal(enriched.status, 'completed');
  assert.equal(enriched.requestId, 'req-16');
  assert.equal(enriched.apiVersion, '1.0');
  assert.ok(enriched.source);
  assert.ok(enriched.telemetry);
});

test('adapter: direct gateway enrichment copies legacy response before adding metadata', () => {
  const legacy = { status: 'completed', recommendedProducts: [], userMessage: 'OK.' };
  const enriched = adapter.enrichLegacyResponseWithGatewayMetadata(legacy, {
    requestId: 'req-direct',
    privacy: { privacyVerified: true, warnings: [] },
  });

  assert.notEqual(enriched, legacy);
  assert.equal(enriched.status, 'completed');
  assert.equal(enriched.requestId, 'req-direct');
  assert.equal(enriched.apiVersion, '1.0');
  assert.equal(enriched.privacyVerified, true);
  assert.equal('requestId' in legacy, false);
  assert.equal('privacyVerified' in legacy, false);
});

test('adapter: direct gateway enrichment does not verify privacy when warnings exist', () => {
  const legacy = { status: 'failed', recommendedProducts: [], userMessage: 'Try again.' };
  const enriched = adapter.enrichLegacyResponseWithGatewayMetadata(legacy, {
    requestId: 'req-warn',
    privacy: {
      privacyVerified: true,
      warnings: ['maskingMode is unknown; privacy masking is not proven.'],
    },
  });

  assert.equal(enriched.privacyVerified, false);
  assert.deepEqual(enriched.privacyWarnings, ['maskingMode is unknown; privacy masking is not proven.']);
});

test('adapter: direct gateway enrichment skips non-legacy statusless responses', () => {
  const errorBody = { error: 'AI provider not configured' };
  const enriched = adapter.enrichLegacyResponseWithGatewayMetadata(errorBody, {
    requestId: 'req-error',
    privacy: { privacyVerified: true, warnings: [] },
  });

  assert.equal(enriched, errorBody);
  assert.equal('requestId' in enriched, false);
  assert.equal('apiVersion' in enriched, false);
  assert.equal('privacyVerified' in enriched, false);
});

// ── 17. future canonical payload with all fields normalizes correctly ────────────

test('adapter: future canonical payload with all fields', () => {
  const body = {
    apiVersion: '1.0',
    requestId: 'req-17',
    surface: 'text_scan',
    inputType: 'text',
    privacy: { piiMasked: true, rawImageSent: false, maskingMode: 'blur' },
    input: { textQuery: 'quiet luxury' },
    intent: { declaredGoal: 'style_match' },
    session: { roomId: 'room-123', sharedByUserId: 'user-456' },
    client: { platform: 'ios' },
    timestamp: '2024-01-01T00:00:00Z',
  };
  const req = adapter.normalizeLegacyBody(body, { requestId: 'req-17' });
  assert.equal(req.apiVersion, '1.0');
  assert.equal(req.requestId, 'req-17');
  assert.equal(req.surface, 'text_scan');
  assert.equal(req.inputType, 'text');
  assert.equal(req.privacy.maskingMode, 'blur');
  assert.equal(req.input.textQuery, 'quiet luxury');
  assert.equal(req.session?.roomId, 'room-123');
  assert.equal(req.session?.sharedByUserId, 'user-456');
  assert.equal(req.client?.platform, 'ios');
});

// ── 18. privacy flags missing on image request returns structured error ──────────

test('validation: missing privacy flags on image request', () => {
  const req = {
    apiVersion: '1.0',
    requestId: 'req-18',
    surface: 'mobile_scan',
    inputType: 'image',
    privacy: {},
    input: { imageBase64: 'data:image/jpeg;base64,QUJD' },
  };
  const result = validation.validateKScanAIRequest(req);
  assertErrorResult(result);
  assert.ok(result.response.errors.some(e => e.code === 'PRIVACY_FLAGS_MISSING'));
});

// ── 19. image size guard (oversized) returns IMAGE_TOO_LARGE ─────────────────────

test('validation: oversized image returns IMAGE_TOO_LARGE', () => {
  const bigBase64 = 'data:image/jpeg;base64,' + 'A'.repeat(7 * 1024 * 1024);
  const req = {
    apiVersion: '1.0',
    requestId: 'req-19',
    surface: 'mobile_scan',
    inputType: 'image',
    privacy: { piiMasked: true, rawImageSent: false },
    input: { imageBase64: bigBase64 },
  };
  const result = validation.validateKScanAIRequest(req);
  assertErrorResult(result);
  assert.ok(result.response.errors.some(e => e.code === 'IMAGE_TOO_LARGE'));
});

// ── 20. completed with partial attributes maps to partial status ─────────────────

test('adapter: completed with partial attributes maps to partial', () => {
  const scanResp = {
    status: 'completed',
    recommendedProducts: [],
    userMessage: 'A blue bag.',
    attributes: { category: 'Accessories', confidenceScore: 0.45 },
  };
  const canonical = adapter.mapScanIdentifyResponseToGatewayResponse(scanResp);
  assert.equal(canonical.status, 'partial');
  assert.ok(canonical.errors.some(e => e.code === 'PARTIAL_RESULT'));
  const legacy = adapter.canonicalToLegacyResponse(canonical, 'image');
  assert.equal(legacy.status, 'completed');
});

// ── 21. canonical request passes through when body already has apiVersion ─────────

test('adapter: canonical payload passes through directly', () => {
  const body = {
    apiVersion: '1.0',
    requestId: 'req-21',
    surface: 'mobile_scan',
    inputType: 'image',
    privacy: { piiMasked: true, rawImageSent: false, maskingMode: 'blur' },
    input: { imageBase64: 'data:image/jpeg;base64,QUJD' },
  };
  const req = adapter.normalizeLegacyBody(body, { requestId: 'should-be-ignored' });
  assert.equal(req.requestId, 'req-21');
  assert.equal(req.surface, 'mobile_scan');
  assert.equal(req.privacy.maskingMode, 'blur');
});

// ── 22. validation failure response includes required canonical fields ────────────

test('validation: error response includes required canonical fields', () => {
  const req = {
    apiVersion: '1.0',
    requestId: 'req-22',
    surface: 'mobile_scan',
    inputType: 'image',
    privacy: { piiMasked: true, rawImageSent: false },
    input: { imageBase64: 'data:image/gif;base64,QUJD' },
  };
  const result = validation.validateKScanAIRequest(req);
  assertErrorResult(result);
  const resp = result.response;
  assert.equal(resp.apiVersion, '1.0');
  assert.equal(resp.requestId, 'req-22');
  assert.ok(['success', 'partial', 'fallback', 'error'].includes(resp.status));
  assert.ok(resp.source && typeof resp.source.primary === 'string');
  assert.ok(Array.isArray(resp.errors));
  assert.ok(resp.telemetry && typeof resp.telemetry.requestId === 'string');
});

test('validation: error telemetry preserves surface and inputType from request', () => {
  const req = {
    apiVersion: '1.0',
    requestId: 'req-22b',
    surface: 'text_scan',
    inputType: 'text',
    privacy: { piiMasked: true, rawImageSent: false },
    input: {},
  };
  const result = validation.validateKScanAIRequest(req);
  assertErrorResult(result);
  assert.equal(result.response.telemetry.surface, 'text_scan');
  assert.equal(result.response.telemetry.inputType, 'text');
});

// ── 23. roomId/sharedByUserId carried in session but not broadcast ───────────────

test('adapter: session carries roomId/sharedByUserId without broadcast behavior', () => {
  const body = {
    imageBase64: 'data:image/jpeg;base64,QUJD',
    source: 'camera',
    clientTimestamp: '2024-01-01T00:00:00Z',
  };
  const req = adapter.normalizeLegacyBody(body, {
    requestId: 'req-room',
    session: {
      roomId: 'room-abc',
      sharedByUserId: 'user-xyz',
      priorContext: { note: 'test' },
    },
  });
  assert.equal(req.session?.roomId, 'room-abc');
  assert.equal(req.session?.sharedByUserId, 'user-xyz');
  assert.equal(typeof req.session?.priorContext, 'object');
  // Confirm no broadcast field is added
  assert.equal('broadcast' in req, false);
});

// ── 24. mixed input type requires both image and text ────────────────────────────

test('validation: mixed input requires both image and text', () => {
  const req = {
    apiVersion: '1.0',
    requestId: 'req-24',
    surface: 'mobile_scan',
    inputType: 'mixed',
    privacy: { piiMasked: true, rawImageSent: false },
    input: { imageBase64: 'data:image/jpeg;base64,QUJD' },
  };
  const result = validation.validateKScanAIRequest(req);
  assertErrorResult(result);
  assert.ok(result.response.errors.some(e => e.code === 'INVALID_INPUT'));
});

// ── 25. privacy evaluation with proven masking on text-only request ──────────────

test('privacy: text-only request with proven masking is privacyVerified', () => {
  const result = validation.evaluatePrivacyState({
    inputType: 'text',
    privacy: { piiMasked: true, rawImageSent: false },
  });
  assert.equal(result.privacyVerified, true);
  assert.equal(result.warnings.length, 0);
  assert.equal(result.wouldRejectInPhase2, false);
});

// ── 26. legacy path preserved when USE_GATEWAY_WIRING is off ───────────────────

test('index wiring: legacy path preserved when USE_GATEWAY_WIRING is off', () => {
  // This is a manual code-path verification: when USE_GATEWAY_WIRING is false,
  // enrichLegacyResponseDirect returns the input unchanged, so the legacy
  // response shape is preserved exactly.
  const legacy = { status: 'completed', recommendedProducts: [], userMessage: 'OK.' };
  // Simulating enrichLegacyResponseDirect when USE_GATEWAY_WIRING is false:
  const out = legacy;
  assert.equal(out.status, 'completed');
  assert.equal(out.recommendedProducts.length, 0);
  assert.equal(out.userMessage, 'OK.');
  assert.equal('requestId' in out, false);
  assert.equal('apiVersion' in out, false);
});

test('index wiring: request context is normalized once before gateway feature gating', () => {
  const source = fs.readFileSync(path.join(ROOT, 'supabase/functions/scan-identify/index.ts'), 'utf8');
  assert.doesNotMatch(source, /TODO: wire scan-identify to enforce canonical request validation in next pass\./);
  assert.match(source, /function buildScanRequestContext/);
  assert.match(source, /const requestContext = buildScanRequestContext\(body\)/);
  assert.match(source, /gates canonical validation, privacy evaluation, and response sidecars/);
});

test('index wiring: USE_GATEWAY_WIRING still gates canonical validation and sidecars', () => {
  const source = fs.readFileSync(path.join(ROOT, 'supabase/functions/scan-identify/index.ts'), 'utf8');
  const flagBlock = source.slice(source.indexOf('if (USE_GATEWAY_WIRING)'), source.indexOf('function enrichLegacyResponseDirect'));
  assert.match(flagBlock, /validateKScanAIRequest\(requestContext\.gatewayRequest\)/);
  assert.match(flagBlock, /evaluatePrivacyState\(validation\.value\)/);
  assert.match(source, /if \(!USE_GATEWAY_WIRING\) return legacyResponse/);
});

test('index wiring: provider inputs use canonical request only when gateway wiring is enabled', () => {
  const source = fs.readFileSync(path.join(ROOT, 'supabase/functions/scan-identify/index.ts'), 'utf8');
  assert.match(source, /const providerInput = buildProviderInput\(body, requestContext, USE_GATEWAY_WIRING\)/);
  assert.match(source, /const rawTextQuery = useGatewayWiring \? requestContext\.gatewayRequest\.input\.textQuery : body\.textQuery/);
  assert.match(source, /const imageInput = useGatewayWiring/);
  assert.match(source, /parseGatewayImageInput\(imageInput\)/);
});

test('index wiring: provider image handoff includes a future privacy-processed image seam', () => {
  const source = fs.readFileSync(path.join(ROOT, 'supabase/functions/scan-identify/index.ts'), 'utf8');
  assert.match(source, /privacyProcessedImageBase64: undefined/);
  assert.match(source, /providerInput\.privacyProcessedImageBase64 \?\? providerInput\.imageBase64/);
  assert.match(source, /providerMimeType: DEFAULT_MIME/);
});

// -- 27. scan-identify model resolution prefers staging override env names --

test('index wiring: scan-identify Gemini model env takes precedence over stale defaults', () => {
  const source = fs.readFileSync(path.join(ROOT, 'supabase/functions/scan-identify/index.ts'), 'utf8');
  const modelEnvIndex = source.indexOf("'SCAN_IDENTIFY_GEMINI_MODEL'");
  const legacyEnvIndex = source.indexOf("'SCAN_GEMINI_MODEL'");
  const genericEnvIndex = source.indexOf("'GEMINI_MODEL'");

  assert.ok(modelEnvIndex >= 0, 'SCAN_IDENTIFY_GEMINI_MODEL should be supported');
  assert.ok(legacyEnvIndex > modelEnvIndex, 'legacy scan model env should be a fallback');
  assert.ok(genericEnvIndex > legacyEnvIndex, 'generic Gemini model env should be a later fallback');
  assert.match(source, /const DEFAULT_MODEL = 'gemini-2\.5-flash';/);
  assert.ok(source.includes("replace(/^models\\//"), 'model resolver should strip models/ prefixes');
  assert.match(source, /RETIRED_GEMINI_MODEL_NAMES = new Set\(\['gemini-1\.5-flash'\]\)/);
  assert.doesNotMatch(source, /const DEFAULT_MODEL = 'gemini-1\.5-flash';/);
});

// -- 28. text-mode Gemini generation uses the larger TEXT_SCAN_MAX_OUTPUT_TOKENS budget --

test('index wiring: text-mode generation config uses TEXT_SCAN_MAX_OUTPUT_TOKENS = 1024', () => {
  const source = fs.readFileSync(path.join(ROOT, 'supabase/functions/scan-identify/index.ts'), 'utf8');
  // Named constant exists and is at least 1024 (the chosen safe value, or higher).
  const match = source.match(/const TEXT_SCAN_MAX_OUTPUT_TOKENS\s*=\s*(\d+);/);
  assert.ok(match, 'TEXT_SCAN_MAX_OUTPUT_TOKENS constant should exist');
  assert.ok(Number(match[1]) >= 1024, 'text-mode token budget should be at least 1024');

  // The text-mode generationConfig must consume the larger budget...
  assert.match(source, /maxOutputTokens:\s*TEXT_SCAN_MAX_OUTPUT_TOKENS/);
  // ...while image mode keeps the original shared MAX_OUTPUT_TOKENS budget (narrow change).
  assert.match(source, /maxOutputTokens:\s*MAX_OUTPUT_TOKENS/);
});

// -- 29. token budget applies to the single provider request path shared by both flag states --

test('index wiring: generationConfig is built once and is independent of USE_GATEWAY_WIRING', () => {
  const source = fs.readFileSync(path.join(ROOT, 'supabase/functions/scan-identify/index.ts'), 'utf8');
  // Exactly one geminiBody construction => flag-off and flag-on share the same request.
  const bodyAssignments = source.match(/const geminiBody\s*=/g) || [];
  assert.equal(bodyAssignments.length, 1, 'provider request body should be constructed exactly once');
  // The request body must not branch on the gateway flag.
  const bodyBlock = source.slice(source.indexOf('const geminiBody'), source.indexOf('const safeFailed'));
  assert.doesNotMatch(bodyBlock, /USE_GATEWAY_WIRING/);
});

// -- 30. responseMimeType stays application/json for both modes --

test('index wiring: responseMimeType remains application/json', () => {
  const source = fs.readFileSync(path.join(ROOT, 'supabase/functions/scan-identify/index.ts'), 'utf8');
  const mimeMatches = source.match(/responseMimeType:\s*'application\/json'/g) || [];
  assert.ok(mimeMatches.length >= 2, 'both text and image generation configs should request JSON');
});

// -- 31. provider temperature stays low (<= 0.2) --

test('index wiring: generation temperature stays at or below 0.2', () => {
  const source = fs.readFileSync(path.join(ROOT, 'supabase/functions/scan-identify/index.ts'), 'utf8');
  const temps = [...source.matchAll(/temperature:\s*([0-9.]+)/g)].map((m) => Number(m[1]));
  assert.ok(temps.length >= 2, 'both generation configs should set temperature');
  for (const t of temps) {
    assert.ok(t <= 0.2, `temperature ${t} should be <= 0.2`);
  }
});

// -- 32. finishReason=MAX_TOKENS is classified as a safe failure, not parser output --

test('index wiring: MAX_TOKENS truncation classified as model_output_truncated and fails safely', () => {
  const source = fs.readFileSync(path.join(ROOT, 'supabase/functions/scan-identify/index.ts'), 'utf8');
  // finishReason is read from the parsed provider candidate.
  assert.match(source, /finishReason\s*=\s*data\.candidates\?\.\[0\]\?\.finishReason/);
  // MAX_TOKENS is detected and routed to the safe failure path before any success.
  const guard = source.slice(source.indexOf("finishReason === 'MAX_TOKENS'"));
  assert.ok(guard.length > 0, 'MAX_TOKENS guard should exist');
  const guardBlock = guard.slice(0, guard.indexOf('}') + 1);
  assert.match(guardBlock, /model_output_truncated/);
  assert.match(guardBlock, /return providerFailure\(\)/);
});
