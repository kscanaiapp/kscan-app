/**
 * Phase 2B.1 — scan-identify V2 activation.
 *
 * Drives the activation layer directly: contract routing, bounded client
 * errors, legacy mode mapping, mode/intent combinations, evidence correlation,
 * commerce gating, response validation, JSON safety and the transitional
 * response.
 *
 * All provider input comes from deterministic fixtures. No test in this file
 * reaches Gemini, a retailer API, or any network service.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const {
  getProviderFixture,
  listProviderFixtures,
  toNormalizationInput,
} = require('./fixtures/scanIdentifyProviderFixtures');

const ROOT = path.resolve(__dirname, '..');

/**
 * Loads the Deno TS modules into one shared realm so objects built by the
 * foundation module and inspected by the activation module have the same
 * intrinsics.
 */
function createLoader() {
  const sandbox = {
    console,
    Set,
    Map,
    Date,
    Math,
    Number,
    Object,
    Array,
    JSON,
    String,
    Boolean,
    RegExp,
    Error,
  };
  vm.createContext(sandbox);
  const cache = new Map();

  function load(relativePath) {
    if (cache.has(relativePath)) return cache.get(relativePath);
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
    cache.set(relativePath, mod.exports);
    const localRequire = (id) => {
      // Deno specifiers keep their explicit .ts extension; resolve them
      // relative to the importing module exactly as Deno would.
      if (id.startsWith('./') || id.startsWith('../')) {
        const resolved = path
          .normalize(path.join(path.dirname(relativePath), id))
          .split(path.sep)
          .join('/');
        return load(resolved);
      }
      throw new Error(`Unexpected require: ${id}`);
    };
    vm.runInContext(
      `(function (exports, module, require) {${output}\n})`,
      sandbox,
      { filename },
    )(mod.exports, mod, localRequire);
    cache.set(relativePath, mod.exports);
    return mod.exports;
  }

  return load;
}

const load = createLoader();
const V2 = load('supabase/functions/_shared/fashionIdentificationV2.ts');
const A = load('supabase/functions/scan-identify/v2Activation.ts');

const EVIDENCE_ID = 'ev-000000000001';
const REQUEST_ID = 'req-000000000001';

function validEvidence(overrides = {}) {
  return {
    evidenceId: EVIDENCE_ID,
    sequenceIndex: 0,
    transport: { type: 'jpeg_base64', imageBase64: 'AAAA' },
    metadata: { schemaVersion: 'image-metadata-v1', width: 896, mimeType: 'image/jpeg' },
    ...overrides,
  };
}

function v2Request(overrides = {}) {
  return {
    contractVersion: 'fashion-identification-v2',
    requestId: REQUEST_ID,
    intent: 'identify_and_shop',
    mode: 'detect_items',
    source: { entryPath: 'scanner_camera', platform: 'android' },
    evidence: [validEvidence()],
    privacy: {
      localFaceMaskApplied: false,
      localPlateMaskApplied: false,
      rawExifTransmitted: false,
    },
    ...overrides,
  };
}

function selectedItemRequest(overrides = {}) {
  return v2Request({
    mode: 'identify_selected_item',
    selectedCandidate: {
      candidateId: 'cand-1',
      evidenceId: EVIDENCE_ID,
      category: 'top',
      subtype: 'oxford shirt',
      bounds: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 },
      detectionDigest: 'digest-1',
    },
    ...overrides,
  });
}

function normalize(fixtureName, evidenceIds = [EVIDENCE_ID]) {
  return V2.normalizeToV2(toNormalizationInput(fixtureName, { requestId: REQUEST_ID, evidenceIds }));
}

/**
 * Arrays built inside the vm realm carry that realm's Array prototype, which
 * deepStrictEqual compares by identity. Spreading rebases them onto the host.
 */
function disagreements(legacy, result) {
  return [...A.findLegacyV2Disagreements(legacy, result)];
}

// ── Contract-version routing ─────────────────────────────────────────────────

test('a request with no contractVersion routes to legacy', () => {
  const route = A.routeScanIdentifyRequest({ imageBase64: 'AAAA', source: 'camera' });
  assert.equal(route.kind, 'legacy');
  assert.equal(route.internal.contractPath, 'legacy');
});

test('a v2 request routes to v2 and adapts to the internal shape', () => {
  const route = A.routeScanIdentifyRequest(v2Request());
  assert.equal(route.kind, 'v2');
  assert.equal(route.internal.contractPath, 'v2');
  assert.equal(route.internal.intent, 'identify_and_shop');
  assert.equal(route.internal.intentDefaulted, false);
  assert.equal(route.internal.resolvedMode, 'detect_items');
  assert.equal(route.internal.evidenceId, EVIDENCE_ID);
});

test('an unknown contract version returns HTTP 400 and never falls back to legacy', () => {
  for (const version of ['fashion-identification-v1', 'fashion-identification-v3', 'v2', '']) {
    const route = A.routeScanIdentifyRequest({ ...v2Request(), contractVersion: version });
    assert.equal(route.kind, 'contract_error', `${version} must not route`);
    assert.equal(route.httpStatus, 400);
    assert.equal(route.body.error.code, 'UNSUPPORTED_CONTRACT_VERSION');
    assert.notEqual(route.kind, 'legacy');
  }
});

test('the validation error body is bounded and leaks nothing from the request', () => {
  const body = A.buildContractErrorBody('UNSUPPORTED_CONTRACT_VERSION');
  assert.deepEqual(Object.keys(body).sort(), ['error', 'status']);
  assert.equal(body.status, 'failed');
  assert.deepEqual(Object.keys(body.error).sort(), ['code', 'message']);
  assert.equal(body.message, undefined);

  // Nothing request-derived may appear in any bounded message.
  const secret = 'SUPERSECRETBASE64PAYLOAD';
  const route = A.routeScanIdentifyRequest({
    contractVersion: 'bogus-version',
    imageBase64: secret,
    requestId: secret,
  });
  const serialized = JSON.stringify(route.body);
  assert.ok(!serialized.includes(secret));
  assert.ok(!/\bat\s+\w+/.test(serialized), 'no stack frames in error body');
  assert.ok(!serialized.includes('bogus-version'), 'no echo of the bad version');
});

test('every bounded error code has static client-safe copy', () => {
  for (const code of A.V2_ERROR_CODES) {
    const body = A.buildContractErrorBody(code);
    assert.equal(body.error.code, code);
    assert.equal(typeof body.error.message, 'string');
    assert.ok(body.error.message.length > 0);
  }
});

// ── Intent ───────────────────────────────────────────────────────────────────

test('a v2 request without intent returns HTTP 400 MISSING_INTENT', () => {
  const body = v2Request();
  delete body.intent;
  const route = A.routeScanIdentifyRequest(body);
  assert.equal(route.kind, 'contract_error');
  assert.equal(route.body.error.code, 'MISSING_INTENT');
});

test('an unknown or reserved intent returns HTTP 400 INVALID_INTENT', () => {
  for (const intent of ['identify_only', 'shop', 'identify', '']) {
    const route = A.routeScanIdentifyRequest(v2Request({ intent }));
    assert.equal(route.kind, 'contract_error', `${intent} must be rejected`);
    assert.equal(route.body.error.code, 'INVALID_INTENT');
  }
});

test('identify_only is absent from the contract and rejected at the boundary', () => {
  assert.ok(!V2.FASHION_IDENTIFICATION_INTENTS.includes('identify_only'));
  const route = A.routeScanIdentifyRequest(v2Request({ intent: 'identify_only' }));
  assert.equal(route.body.error.code, 'INVALID_INTENT');
});

test('a legacy request defaults to shop intent and records that it was defaulted', () => {
  const route = A.routeScanIdentifyRequest({ imageBase64: 'AAAA' });
  assert.equal(route.internal.intent, 'identify_and_shop');
  assert.equal(route.internal.intentDefaulted, true);
});

test('the legacy default is never applied to an explicit v2 request', () => {
  const body = v2Request();
  delete body.intent;
  const route = A.routeScanIdentifyRequest(body);
  // Must be a hard failure, not a silent shop.
  assert.equal(route.kind, 'contract_error');
});

// ── Legacy mode mapping ──────────────────────────────────────────────────────

test('legacy multiItemDetection maps to detection', () => {
  assert.equal(A.resolveLegacyInternalMode({ multiItemDetection: true }), 'detect_items');
  assert.equal(
    A.resolveLegacyInternalMode({ requestMode: 'multi_item_detection' }),
    'detect_items',
  );
});

test('legacy selected-candidate fields map to selected-item', () => {
  assert.equal(
    A.resolveLegacyInternalMode({ requestMode: 'selected_item' }),
    'identify_selected_item',
  );
  assert.equal(
    A.resolveLegacyInternalMode({ selectedCandidate: { candidateId: 'c1', category: 'top' } }),
    'identify_selected_item',
  );
});

test('a plain legacy single-item request keeps its existing behaviour', () => {
  const route = A.routeScanIdentifyRequest({ imageBase64: 'AAAA', source: 'camera' });
  assert.equal(route.internal.resolvedMode, 'legacy_single_item');
  assert.equal(route.internal.multiItemDetection, false);
  assert.equal(route.internal.requestMode, 'legacy_single_item');
});

test('legacy detection skips commerce despite the shop default', () => {
  const route = A.routeScanIdentifyRequest({ multiItemDetection: true, imageBase64: 'AAAA' });
  assert.equal(route.internal.intent, 'identify_and_shop');
  const decision = A.resolveCommerceDecision({
    intent: route.internal.intent,
    resolvedMode: route.internal.resolvedMode,
    status: 'completed',
  });
  assert.equal(decision.run, false);
  assert.equal(decision.skipReason, 'detection_mode');
});

// ── Mode / intent combinations ───────────────────────────────────────────────

test('every supported mode/intent combination is accepted', () => {
  const combos = [
    ['detect_items', 'identify_and_shop'],
    ['detect_items', 'identify_for_style'],
    ['identify_selected_item', 'identify_and_shop'],
    ['identify_selected_item', 'identify_for_style'],
  ];
  for (const [mode, intent] of combos) {
    const body = mode === 'detect_items'
      ? v2Request({ mode, intent })
      : selectedItemRequest({ intent });
    const route = A.routeScanIdentifyRequest(body);
    assert.equal(route.kind, 'v2', `${mode}+${intent} should be accepted`);
  }
});

test('the commerce decision table matches the specification exactly', () => {
  const cases = [
    ['detect_items', 'identify_and_shop', 'completed', false],
    ['detect_items', 'identify_for_style', 'completed', false],
    ['identify_selected_item', 'identify_and_shop', 'completed', true],
    ['identify_selected_item', 'identify_for_style', 'completed', false],
    ['identify_selected_item', 'identify_and_shop', 'non_fashion', false],
    ['identify_selected_item', 'identify_and_shop', 'insufficient_visual_evidence', false],
    ['identify_selected_item', 'identify_and_shop', 'technical_failure', false],
    ['legacy_single_item', 'identify_and_shop', 'completed', true],
    ['legacy_single_item', 'identify_and_shop', 'partial', true],
  ];
  for (const [resolvedMode, intent, status, expected] of cases) {
    const decision = A.resolveCommerceDecision({ intent, resolvedMode, status });
    assert.equal(decision.run, expected, `${resolvedMode}+${intent}+${status}`);
    if (!expected) assert.ok(decision.skipReason, 'a skip must carry a reason');
  }
});

test('the reserved collection mode is rejected, not degraded to a single image', () => {
  const route = A.routeScanIdentifyRequest(v2Request({ mode: 'identify_item_collection' }));
  assert.equal(route.kind, 'contract_error');
  assert.equal(route.body.error.code, 'INVALID_MODE');
});

test('selected-item without a candidate returns MISSING_SELECTED_CANDIDATE', () => {
  const route = A.routeScanIdentifyRequest(v2Request({ mode: 'identify_selected_item' }));
  assert.equal(route.kind, 'contract_error');
  assert.equal(route.body.error.code, 'MISSING_SELECTED_CANDIDATE');
});

test('selected-item with a malformed candidate returns INVALID_SELECTED_CANDIDATE', () => {
  const route = A.routeScanIdentifyRequest(
    v2Request({
      mode: 'identify_selected_item',
      selectedCandidate: { candidateId: 'cand-1', evidenceId: EVIDENCE_ID },
    }),
  );
  assert.equal(route.kind, 'contract_error');
  // Distinct from "absent" — a different client mistake gets a different code.
  assert.equal(route.body.error.code, 'INVALID_SELECTED_CANDIDATE');
});

// ── Evidence ─────────────────────────────────────────────────────────────────

test('exactly one evidence entry is accepted', () => {
  assert.equal(A.routeScanIdentifyRequest(v2Request()).kind, 'v2');
});

test('zero evidence entries are rejected', () => {
  const route = A.routeScanIdentifyRequest(v2Request({ evidence: [] }));
  assert.equal(route.kind, 'contract_error');
  assert.equal(route.body.error.code, 'INVALID_EVIDENCE');
});

test('multiple evidence entries are rejected, never silently truncated', () => {
  const route = A.routeScanIdentifyRequest(
    v2Request({
      evidence: [
        validEvidence(),
        validEvidence({ evidenceId: 'ev-000000000002', sequenceIndex: 1 }),
      ],
    }),
  );
  assert.equal(route.kind, 'contract_error');
  assert.equal(route.body.error.code, 'MULTIPLE_EVIDENCE_NOT_SUPPORTED');
  assert.notEqual(route.kind, 'v2', 'must not proceed using evidence[0]');
});

test('a malformed or path-like evidence id is rejected', () => {
  for (const evidenceId of [
    'file:///tmp/a.jpg', 'content://media/9', 'C:\\Users\\a.jpg',
    'photo.jpg', 'user@example.com', 'has space', 'short', 'under_score',
  ]) {
    const route = A.routeScanIdentifyRequest(
      v2Request({ evidence: [validEvidence({ evidenceId })] }),
    );
    assert.equal(route.kind, 'contract_error', `${evidenceId} must be rejected`);
    assert.equal(route.body.error.code, 'INVALID_EVIDENCE_ID');
  }
});

test('the validated evidence id is echoed verbatim, never regenerated', () => {
  const route = A.routeScanIdentifyRequest(v2Request());
  assert.equal(route.internal.evidenceId, EVIDENCE_ID);
  const result = normalize('complete_fashion', [route.internal.evidenceId]);
  assert.equal(result.evidence[0].evidenceId, EVIDENCE_ID);
});

test('detection candidates retain the originating evidence id', () => {
  const result = normalize('multiple_items');
  assert.equal(result.status, 'multiple_items_need_selection');
  assert.ok(result.candidates.length >= 2);
  for (const candidate of result.candidates) {
    assert.equal(candidate.evidenceId, EVIDENCE_ID);
  }
});

test('the selected-item request reuses the same evidence id from detection', () => {
  const detection = A.routeScanIdentifyRequest(v2Request());
  const selection = A.routeScanIdentifyRequest(selectedItemRequest());
  assert.equal(selection.kind, 'v2');
  assert.equal(selection.internal.evidenceId, detection.internal.evidenceId);
  assert.equal(selection.internal.detectionDigest, 'digest-1');
});

test('the selected candidate maps losslessly onto the existing pipeline fields', () => {
  const route = A.routeScanIdentifyRequest(selectedItemRequest());
  const candidate = route.internal.selectedCandidate;
  // The existing sanitizer requires candidateId AND category.
  assert.equal(candidate.candidateId, 'cand-1');
  assert.equal(candidate.category, 'top');
  assert.equal(candidate.subtype, 'oxford shirt');
  assert.deepEqual({ ...candidate.bounds }, { x: 0.1, y: 0.1, width: 0.5, height: 0.5 });
  assert.equal(route.internal.requestMode, 'selected_item');
  assert.equal(route.internal.multiItemDetection, true);
});

test('a selected candidate pointing at absent evidence is rejected', () => {
  const route = A.routeScanIdentifyRequest(
    selectedItemRequest({
      selectedCandidate: {
        candidateId: 'cand-1',
        evidenceId: 'ev-000000000999',
        category: 'top',
      },
    }),
  );
  assert.equal(route.kind, 'contract_error');
  assert.equal(route.body.error.code, 'INVALID_SELECTED_CANDIDATE');
});

// ── Normalization through the fixtures ───────────────────────────────────────

test('subtype-level partial is preserved', () => {
  const result = normalize('subtype_partial');
  assert.ok(['completed', 'partial'].includes(result.status));
  assert.equal(result.resolutionLevel, 'subtype');
  assert.equal(result.item.subtype, 'chore jacket');
  assert.equal(result.item.brand.value, null);
});

test('category-only result is partial, not a failure', () => {
  const result = normalize('category_only');
  assert.equal(result.status, 'partial');
  assert.equal(result.resolutionLevel, 'category');
  assert.equal(result.item.category, 'footwear');
});

test('non-fashion is preserved as a classification', () => {
  const result = normalize('non_fashion');
  assert.equal(result.status, 'non_fashion');
  assert.equal(result.item.category, null);
});

test('insufficient visual evidence is preserved and distinct from technical failure', () => {
  const visual = normalize('insufficient_visual_evidence');
  assert.equal(visual.status, 'insufficient_visual_evidence');
  for (const name of ['malformed_provider_json', 'provider_exception', 'provider_timeout']) {
    const technical = normalize(name);
    assert.equal(technical.status, 'technical_failure', name);
    assert.notEqual(technical.status, visual.status);
  }
});

test('a visually branded result keeps brand, subtype and evidence', () => {
  const result = normalize('visually_branded');
  assert.equal(result.item.brand.value, 'ExampleBrand');
  assert.equal(result.item.subtype, 'low-top sneaker');
  assert.equal(result.item.brand.provenance, 'logo_shape');
  assert.equal(result.resolutionLevel, 'brand_and_subtype');
});

test('confidence is never fabricated across dimensions', () => {
  for (const name of listProviderFixtures()) {
    const result = normalize(name);
    const populated = [
      result.confidence.category,
      result.confidence.subtype,
      result.confidence.brand,
      result.confidence.modelFamily,
      result.confidence.exactProduct,
    ].filter((value) => value !== null);
    assert.ok(populated.length < 5, `${name} fabricated all five confidence dimensions`);
    assert.equal(result.confidence.subtype, null, `${name} invented subtype confidence`);
    assert.equal(result.confidence.modelFamily, null);
    assert.equal(result.confidence.exactProduct, null);
  }
});

test('the response validator accepts every fixture result', () => {
  for (const name of listProviderFixtures()) {
    const validation = A.validateFashionIdentificationResultV2(normalize(name));
    assert.equal(validation.ok, true, `${name}: ${validation.category}`);
  }
});

test('the response validator rejects structurally broken results', () => {
  const base = normalize('complete_fashion');
  const broken = [
    [{ ...base, contractVersion: 'nope' }, 'contract_version'],
    [{ ...base, status: 'invented' }, 'status'],
    [{ ...base, resolutionLevel: 'invented' }, 'resolution_level'],
    [{ ...base, item: null }, 'item'],
    [{ ...base, conflicts: null }, 'conflicts'],
    [{ ...base, compatibility: null }, 'compatibility'],
  ];
  for (const [value, expected] of broken) {
    const validation = A.validateFashionIdentificationResultV2(value);
    assert.equal(validation.ok, false, `${expected} should fail`);
    assert.equal(validation.category, expected);
  }
});

test('a missing required confidence key is caught, not tolerated', () => {
  const base = normalize('complete_fashion');
  const confidence = { ...base.confidence };
  delete confidence.modelFamily;
  const validation = A.validateFashionIdentificationResultV2({ ...base, confidence });
  assert.equal(validation.ok, false);
  assert.equal(validation.category, 'confidence_missing_modelFamily');
});

// ── Serialization ────────────────────────────────────────────────────────────

test('no fixture result contains undefined anywhere', () => {
  for (const name of listProviderFixtures()) {
    const found = A.findJsonUnsafePath(normalize(name));
    assert.equal(found, null, `${name} carries a JSON-unsafe value at ${found}`);
  }
});

test('the JSON-safety walker catches every unserializable shape', () => {
  const circular = { a: 1 };
  circular.self = circular;
  const cases = [
    [{ a: undefined }, 'undefined'],
    [{ a: () => 1 }, 'function'],
    [{ a: NaN }, 'non_finite_number'],
    [{ a: Infinity }, 'non_finite_number'],
    [{ a: new Map() }, 'map'],
    [{ a: new Set() }, 'set'],
    [{ a: new Error('x') }, 'error'],
    [circular, 'circular'],
    [{ a: [1, undefined] }, 'undefined'],
  ];
  for (const [value, expected] of cases) {
    const found = A.findJsonUnsafePath(value);
    assert.ok(found, `${expected} not detected`);
    assert.ok(found.endsWith(expected), `${found} should end with ${expected}`);
  }
  assert.equal(A.findJsonUnsafePath({ a: null, b: [], c: 'x', d: 0 }), null);
});

test('required nullable keys survive a JSON round trip as null', () => {
  for (const name of listProviderFixtures()) {
    const result = normalize(name);
    const parsed = JSON.parse(JSON.stringify(result));

    // The round trip must still validate — this is the exact failure mode where
    // an `undefined` field passes in memory and vanishes on the wire.
    assert.equal(
      A.validateFashionIdentificationResultV2(parsed).ok,
      true,
      `${name} failed validation after serialization`,
    );
    for (const key of ['category', 'subtype', 'brand', 'modelFamily', 'exactProduct']) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(parsed.confidence, key),
        `${name}: confidence.${key} did not survive serialization`,
      );
    }
    assert.ok(Array.isArray(parsed.item.material));
    assert.ok(Array.isArray(parsed.item.colors.secondary));
    assert.ok(Array.isArray(parsed.conflicts));
    assert.ok(Object.prototype.hasOwnProperty.call(parsed, 'exactProduct'));
  }
});

test('an attached undefined is caught before it can silently disappear', () => {
  const result = normalize('complete_fashion');
  result.confidence.modelFamily = undefined;
  assert.ok(A.findJsonUnsafePath(result));
  // Proving the actual hazard: serialization drops the key entirely.
  const parsed = JSON.parse(JSON.stringify(result));
  assert.ok(!Object.prototype.hasOwnProperty.call(parsed.confidence, 'modelFamily'));
  assert.equal(A.validateFashionIdentificationResultV2(parsed).ok, false);
});

// ── Technical-failure response ───────────────────────────────────────────────

test('the technical-failure fallback is itself a valid, parseable v2 result', () => {
  const failure = A.buildTechnicalFailureResultV2(REQUEST_ID, [EVIDENCE_ID]);
  assert.equal(failure.status, 'technical_failure');
  assert.equal(failure.resolutionLevel, 'unknown');
  assert.equal(A.validateFashionIdentificationResultV2(failure).ok, true);
  assert.equal(A.findJsonUnsafePath(failure), null);
  const parsed = JSON.parse(JSON.stringify(failure));
  assert.equal(A.validateFashionIdentificationResultV2(parsed).ok, true);
  // It must not present an item a client could mistake for a real one.
  assert.equal(parsed.item.category, null);
  assert.equal(parsed.item.brand.value, null);
});

// ── Transitional response and legacy parity ──────────────────────────────────

test('the transitional response keeps legacy fields and adds exactly two', () => {
  const legacy = {
    status: 'completed',
    identification: { item_type: 'outerwear', subtype: 'chore jacket' },
    attributes: { category: 'outerwear' },
    recommendedProducts: [],
    purchaseOptions: [],
  };
  const result = normalize('complete_fashion');
  const response = A.buildTransitionalResponse(legacy, result);

  for (const key of Object.keys(legacy)) {
    assert.ok(Object.prototype.hasOwnProperty.call(response, key), `lost legacy field ${key}`);
  }
  const added = Object.keys(response).filter((key) => !(key in legacy));
  assert.deepEqual(added.sort(), ['contractVersion', 'identificationV2']);
  assert.equal(response.contractVersion, 'fashion-identification-v2');
  assert.equal(response.identificationV2.contractVersion, 'fashion-identification-v2');
});

test('legacy and V2 views of the same scan do not disagree', () => {
  const result = normalize('complete_fashion');
  const projected = V2.projectV2ToLegacy(result);
  const legacy = {
    status: projected.status,
    identification: {
      item_type: projected.item_type,
      subtype: projected.subtype,
      brand_guess: projected.brand_guess,
      primary_color: projected.primary_color,
    },
    attributes: { category: projected.item_type },
  };
  assert.deepEqual(disagreements(legacy, result), []);
});

test('a disagreeing legacy projection is detected on every shared field', () => {
  const result = normalize('visually_branded');
  const projected = V2.projectV2ToLegacy(result);
  const good = {
    status: projected.status,
    identification: {
      item_type: projected.item_type,
      subtype: projected.subtype,
      brand_guess: projected.brand_guess,
      primary_color: projected.primary_color,
    },
  };
  assert.deepEqual(disagreements(good, result), []);

  const mutations = [
    ['category', { item_type: 'handbag' }],
    ['subtype', { subtype: 'high-top sneaker' }],
    ['brand', { brand_guess: 'OtherBrand' }],
    ['primary_color', { primary_color: 'red' }],
  ];
  for (const [field, override] of mutations) {
    const bad = { ...good, identification: { ...good.identification, ...override } };
    assert.deepEqual(disagreements(bad, result), [field]);
  }
  const badStatus = { ...good, status: 'failed' };
  assert.deepEqual(disagreements(badStatus, result), ['status']);
});

// ── Telemetry ────────────────────────────────────────────────────────────────

test('telemetry is bounded and carries no identifying value', () => {
  const route = A.routeScanIdentifyRequest(selectedItemRequest({ intent: 'identify_for_style' }));
  const result = normalize('selected_item');
  const commerce = A.resolveCommerceDecision({
    intent: route.internal.intent,
    resolvedMode: route.internal.resolvedMode,
    status: result.status,
  });
  const telemetry = A.buildV2Telemetry({
    internal: route.internal,
    evidenceCount: 1,
    result,
    commerce,
    responseValidationOk: true,
  });

  assert.equal(telemetry.intent, 'identify_for_style');
  assert.equal(telemetry.commerceExecuted, false);
  assert.equal(telemetry.commerceSkipped, true);
  assert.equal(telemetry.skipReason, 'style_intent');
  assert.equal(telemetry.intentDefaulted, false);
  assert.equal(telemetry.evidenceCount, 1);

  // The evidence id is client-supplied and correlatable, so it must not appear.
  const serialized = JSON.stringify(telemetry);
  assert.ok(!serialized.includes(EVIDENCE_ID), 'telemetry leaked the evidence id');
  assert.ok(!serialized.includes('AAAA'), 'telemetry leaked image bytes');
  assert.ok(!serialized.includes(REQUEST_ID), 'telemetry leaked the request id');
});

test('legacy intent defaulting is recorded truthfully in telemetry', () => {
  const route = A.routeScanIdentifyRequest({ imageBase64: 'AAAA' });
  const result = normalize('complete_fashion');
  const telemetry = A.buildV2Telemetry({
    internal: route.internal,
    evidenceCount: 1,
    result,
    commerce: A.resolveCommerceDecision({
      intent: route.internal.intent,
      resolvedMode: route.internal.resolvedMode,
      status: result.status,
    }),
    responseValidationOk: true,
  });
  assert.equal(telemetry.intentDefaulted, true);
  assert.equal(telemetry.intent, 'identify_and_shop');
  assert.equal(telemetry.contractPath, 'legacy');
  assert.equal(telemetry.compatibilityProjectionUsed, false);
});
