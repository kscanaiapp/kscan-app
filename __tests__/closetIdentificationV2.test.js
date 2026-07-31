// Closet classification-only identification suite (Build 1).
//
// Proves the four things the Closet intake contract actually promises:
//   1. a Closet request is ALWAYS identify_for_closet and can never be made to shop
//   2. it never falls back to the legacy contract (which would shop)
//   3. a partial or taxonomy-less result is a manual-classification state, not a failure
//   4. no Closet path produces a Recent Scan, Saved Scan, Elise attachment,
//      Dressing Room item, or committed Closet item
//
// Points 1-3 are behavioural and run against the REAL adapter. Point 4 is a
// SOURCE-LEVEL governance scan, because the only trustworthy proof that a side
// effect does not happen is that no call site for it exists.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function transpile(rel) {
  return ts.transpileModule(fs.readFileSync(path.join(ROOT, rel), 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
      allowJs: true,
    },
  }).outputText;
}

function runModule(rel, requireShim) {
  const mod = { exports: {} };
  vm.runInThisContext(`(function (exports, module, require) {\n${transpile(rel)}\n})`, {
    filename: rel,
  })(mod.exports, mod, requireShim);
  return mod.exports;
}

function cryptoShim() {
  let seq = 0;
  return {
    getRandomBytes: (n) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + 3) % 256),
    randomUUID: () => {
      seq += 1;
      return `00000000-0000-4000-8000-${seq.toString(16).padStart(12, '0')}`;
    },
  };
}

function loadAdapter(flagValue = true) {
  const crypto = cryptoShim();
  const contractTypes = runModule('types/fashionIdentificationV2.ts', () => ({}));
  const candidateTypes = runModule('types/closetCandidate.ts', () => ({}));
  const gateway = runModule('services/fashionEvidenceGateway.ts', (spec) =>
    spec === 'expo-crypto' ? crypto : {},
  );
  const core = runModule('services/fashionIdentificationV2Core.ts', (spec) => {
    if (spec === '../types/fashionIdentificationV2') return contractTypes;
    if (spec === './fashionEvidenceGateway') return gateway;
    return {};
  });
  const adapter = runModule('services/closetIdentificationV2.ts', (spec) => {
    if (spec === '../types/fashionIdentificationV2') return contractTypes;
    if (spec === '../types/closetCandidate') return candidateTypes;
    if (spec === './fashionEvidenceGateway') return gateway;
    if (spec === './fashionIdentificationV2Core') return core;
    if (spec === '../constants/featureFlags') {
      return { resolveClosetCandidateStagingEnabled: () => flagValue };
    }
    return {};
  });
  return { adapter, gateway, core, contractTypes, candidateTypes };
}

const { adapter, gateway } = loadAdapter();

function evidence(overrides = {}) {
  return {
    evidenceId: '11111111-2222-4333-8444-555555555555',
    imageBase64: 'QUJDRA==',
    mimeType: 'image/jpeg',
    width: 896,
    height: 1200,
    source: 'gallery',
    ...overrides,
  };
}

function request(overrides = {}) {
  const built = adapter.buildClosetV2Request({
    evidence: evidence(),
    entryPath: 'gallery',
    platform: 'android',
    requestId: 'req_closet_1',
    ...overrides,
  });
  assert.equal(built.kind, 'ok', JSON.stringify(built));
  return built.request;
}

/** A structurally valid V2 result. Fields are overridden per test. */
function v2Result(overrides = {}) {
  return {
    contractVersion: 'fashion-identification-v2',
    requestId: 'req_closet_1',
    status: 'completed',
    resolutionLevel: 'brand_and_subtype',
    item: {
      category: 'Outerwear',
      subtype: 'Trench coat',
      brand: { value: 'Burberry', confidence: 0.7, provenance: 'visual', evidence: [] },
      colors: { primary: 'Beige', secondary: ['Cream'] },
      material: ['Cotton gabardine'],
      silhouette: [],
      pattern: [],
      attributes: { pockets: [], visible: [], distinctive: [] },
      ...overrides.item,
    },
    confidence: {
      category: 0.9,
      subtype: 0.8,
      brand: 0.7,
      modelFamily: null,
      exactProduct: null,
      ...overrides.confidence,
    },
    exactProduct: null,
    evidence: [],
    conflicts: [],
    compatibility: { legacyProjectionAvailable: true, globalConfidence: 0.85 },
    ...(overrides.status ? { status: overrides.status } : {}),
    ...(overrides.candidates ? { candidates: overrides.candidates } : {}),
  };
}

// ── Intent governance ────────────────────────────────────────────────────────

test('a Closet request always carries identify_for_closet', () => {
  assert.equal(adapter.CLOSET_INTENT, 'identify_for_closet');
  assert.equal(request().intent, 'identify_for_closet');
});

test('there is no parameter a caller could use to make Closet shop', () => {
  // The builder takes no intent argument at all; passing one changes nothing.
  const built = adapter.buildClosetV2Request({
    evidence: evidence(),
    entryPath: 'gallery',
    platform: 'android',
    requestId: 'req_closet_1',
    intent: 'identify_and_shop',
    mode: 'identify_selected_item',
  });
  assert.equal(built.kind, 'ok');
  assert.equal(built.request.intent, 'identify_for_closet');
  assert.equal(built.request.mode, 'detect_items');
});

test('validation rejects a request assembled with any other intent or mode', () => {
  assert.equal(adapter.validateClosetV2Request(request()), true);
  assert.equal(
    adapter.validateClosetV2Request({ ...request(), intent: 'identify_and_shop' }),
    false,
  );
  assert.equal(
    adapter.validateClosetV2Request({ ...request(), intent: 'identify_for_style' }),
    false,
  );
  assert.equal(
    adapter.validateClosetV2Request({ ...request(), mode: 'identify_selected_item' }),
    false,
  );
});

test('validation rejects a Scanner or Elise entry path on a Closet request', () => {
  for (const entryPath of [
    'scanner_camera',
    'scanner_gallery',
    'scanner_handoff',
    'elise_camera',
    'elise_gallery',
    'elise_header_gallery',
  ]) {
    const hostile = request();
    hostile.source.entryPath = entryPath;
    assert.equal(adapter.validateClosetV2Request(hostile), false, entryPath);
  }
});

test('camera, gallery and mirror map to their own distinct entry paths', () => {
  assert.equal(request({ entryPath: 'camera' }).source.entryPath, 'closet_camera');
  assert.equal(request({ entryPath: 'gallery' }).source.entryPath, 'closet_gallery');
  assert.equal(request({ entryPath: 'mirror' }).source.entryPath, 'closet_mirror');
  assert.equal(adapter.closetEntryPathKeyForSource('camera'), 'camera');
  assert.equal(adapter.closetEntryPathKeyForSource('gallery'), 'gallery');
  assert.equal(adapter.closetEntryPathKeyForSource('mirror_extract'), 'mirror');
  // Three keys, three distinct wire values, no aliasing.
  const wire = Object.values(adapter.CLOSET_ENTRY_PATHS);
  assert.deepEqual(wire, ['closet_camera', 'closet_gallery', 'closet_mirror']);
  assert.equal(new Set(wire).size, wire.length);
});

// MIRROR-UNKNOWN-SOURCE-FAILS-CLOSED (Build 2.5 Step 1, preserved through Step 2).
//
// Before Step 1, anything that was not `camera` silently became `gallery`,
// which was safe only while `camera` and `gallery` were the sole reachable
// candidate sources. Step 2 activated `mirror_extract` by giving it its OWN
// key — it did NOT restore the fallback. The mapping is still a CLOSED set:
// every value outside the three known sources returns `null` rather than a
// guessed entry path.
test('unrecognised sources resolve to no entry path, never gallery', () => {
  assert.equal(adapter.closetEntryPathKeyForSource('mystery'), null);
  assert.equal(adapter.closetEntryPathKeyForSource('mirror'), null);
  assert.equal(adapter.closetEntryPathKeyForSource('mirror_selfie'), null);
  assert.equal(adapter.closetEntryPathKeyForSource('closet_mirror'), null);
  assert.equal(adapter.closetEntryPathKeyForSource(undefined), null);
  assert.equal(adapter.closetEntryPathKeyForSource(null), null);
  assert.equal(adapter.closetEntryPathKeyForSource(''), null);
  assert.equal(adapter.closetEntryPathKeyForSource({}), null);
});

// MIRROR-EXTRACT-BUILDS-CLOSET-MIRROR-ENTRY-PATH /
// MIRROR-EXTRACT-RETAINS-IDENTIFY-FOR-CLOSET /
// MIRROR-EXTRACT-RETAINS-DETECT-ITEMS-MODE (Build 2.5 Step 2).
//
// Replaces Step 1's dormancy assertion. That test proved `closet_mirror` could
// NOT be produced by `buildClosetV2Request`; the contract is now active, so the
// equivalent protection is the positive form — the value is produced, from the
// mirror source alone, and carries the Closet intent and detection mode
// unchanged. `MIRROR_INTENDED_ENTRY_PATH`/`mirrorIntendedEntryPathFor` were the
// dormancy mechanism itself and are gone; nothing may reintroduce a second
// answer for the same question.
test('mirror_extract builds a real closet_mirror request on the Closet intent', () => {
  const built = adapter.buildClosetV2Request({
    evidence: evidence(),
    entryPath: adapter.closetEntryPathKeyForSource('mirror_extract'),
    platform: 'android',
    requestId: 'req_closet_mirror_1',
  });
  assert.equal(built.kind, 'ok', JSON.stringify(built));
  assert.equal(built.request.contractVersion, 'fashion-identification-v2');
  assert.equal(built.request.source.entryPath, 'closet_mirror');
  assert.equal(built.request.intent, 'identify_for_closet');
  assert.equal(built.request.mode, 'detect_items');
  assert.equal(adapter.validateClosetV2Request(built.request), true);
  // The dormancy mechanism is retired, not merely bypassed.
  assert.equal(adapter.MIRROR_INTENDED_ENTRY_PATH, undefined);
  assert.equal(adapter.mirrorIntendedEntryPathFor, undefined);
});

// CLOSET-MIRROR-DOES-NOT-PERSIST-ORIGINAL-SELFIE (transport half).
//
// The prepared-evidence object carries a local `source` bookkeeping field.
// `buildClosetV2Request` must never forward it: it is a second, unpoliced
// provenance channel whose vocabulary ('camera'/'gallery'/'header_gallery')
// cannot express `mirror` and would therefore transmit a false one.
test('no evidence-level source field reaches the wire on any Closet path', () => {
  for (const entryPath of ['camera', 'gallery', 'mirror']) {
    const built = request({ entryPath });
    assert.equal(built.evidence.length, 1);
    assert.ok(
      !Object.prototype.hasOwnProperty.call(built.evidence[0], 'source'),
      `${entryPath} leaked an evidence-level source`,
    );
    assert.deepEqual(
      Object.keys(built.source).sort(),
      ['entryPath', 'platform'],
      `${entryPath} source carries an unexpected key`,
    );
  }
});

test('the request carries exactly one evidence object and a truthful privacy attestation', () => {
  const built = request();
  assert.equal(built.evidence.length, 1);
  assert.equal(built.evidence[0].transport.type, 'jpeg_base64');
  assert.deepEqual(built.privacy, {
    localFaceMaskApplied: false,
    localPlateMaskApplied: false,
    rawExifTransmitted: false,
  });
});

test('a Closet request never carries a selectedCandidate', () => {
  const built = request();
  assert.equal(Object.prototype.hasOwnProperty.call(built, 'selectedCandidate'), false);
});

test('malformed inputs are rejected locally before any network call', () => {
  const cases = [
    [{ evidence: null }, 'invalid_evidence'],
    [{ evidence: evidence({ evidenceId: '/data/photo.jpg' }) }, 'invalid_evidence_id'],
    [{ evidence: evidence({ evidenceId: 'short' }) }, 'invalid_evidence_id'],
    [{ evidence: evidence({ imageBase64: '' }) }, 'invalid_evidence'],
    [{ requestId: '' }, 'invalid_request_id'],
    [{ entryPath: 'scanner' }, 'invalid_entry_path'],
  ];
  for (const [overrides, reason] of cases) {
    const built = adapter.buildClosetV2Request({
      evidence: evidence(),
      entryPath: 'gallery',
      platform: 'android',
      requestId: 'req_closet_1',
      ...overrides,
    });
    assert.equal(built.kind, 'rejected', JSON.stringify(overrides));
    assert.equal(built.reason, reason, JSON.stringify(overrides));
  }
});

// ── No legacy fallback ───────────────────────────────────────────────────────

test('a contract rejection is terminal — Closet never falls back to legacy', () => {
  for (const code of [
    'UNSUPPORTED_CONTRACT_VERSION',
    'INVALID_INTENT',
    'MISSING_INTENT',
    'INVALID_MODE',
    'INVALID_SOURCE',
  ]) {
    assert.equal(
      adapter.classifyClosetTransportFailure({ httpStatus: 400, contractErrorCode: code }),
      'classification_contract_rejected',
      code,
    );
  }
  // The adapter exposes no fallback affordance whatsoever.
  assert.equal(typeof adapter.isUnsupportedContractVersion, 'undefined');
  const telemetry = adapter.buildClosetV2Telemetry({
    enabled: true,
    attempted: true,
    accepted: false,
    entryPath: 'gallery',
    platform: 'android',
    result: null,
  });
  assert.equal(telemetry.fallbackUsed, false);
});

test('the adapter source contains no legacy-contract retry path', () => {
  const source = fs.readFileSync(path.join(ROOT, 'services/closetIdentificationV2.ts'), 'utf8');
  const code = source.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/legacyRequestBody|contractRequestV2\s*:\s*undefined/.test(code));
  assert.ok(!/fallbackToLegacy|retryAsLegacy/.test(code));
});

// ── Transport failure mapping ────────────────────────────────────────────────

test('every transport failure maps to exactly one registered code', () => {
  const cases = [
    [{ aborted: true }, 'candidate_request_aborted'],
    [{ offline: true }, 'candidate_offline'],
    // Abort wins over offline: cancellation is not a connectivity problem.
    [{ aborted: true, offline: true }, 'candidate_request_aborted'],
    [{ httpStatus: 401 }, 'classification_auth_failed'],
    [{ httpStatus: 403 }, 'classification_auth_failed'],
    [{ httpStatus: 402 }, 'classification_quota_exhausted'],
    [{ httpStatus: 429 }, 'classification_rate_limited'],
    [{ httpStatus: 408 }, 'classification_timeout'],
    [{ httpStatus: 504 }, 'classification_timeout'],
    [{ httpStatus: 400, contractErrorCode: 'PAYLOAD_TOO_LARGE' }, 'candidate_media_unsupported'],
    [{ httpStatus: 400, contractErrorCode: 'INVALID_EVIDENCE' }, 'candidate_media_unsupported'],
    [{ malformed: true }, 'classification_malformed_response'],
    [{}, 'classification_provider_failed'],
    [{ httpStatus: 500 }, 'classification_provider_failed'],
  ];
  const { candidateTypes } = loadAdapter();
  for (const [signal, expected] of cases) {
    const code = adapter.classifyClosetTransportFailure(signal);
    assert.equal(code, expected, JSON.stringify(signal));
    assert.ok(
      candidateTypes.CLOSET_CANDIDATE_ERROR_CODES.includes(code),
      `${code} is not a registered error code`,
    );
  }
});

// ── Classification normalization and fallback ────────────────────────────────

test('a complete result is projected onto the candidate fields verbatim', () => {
  const outcome = adapter.resolveClassificationOutcome(v2Result());
  assert.equal(outcome.status, 'ready_for_review');
  assert.equal(outcome.errorCode, null);
  assert.equal(outcome.classification.category, 'Outerwear');
  assert.equal(outcome.classification.subtype, 'Trench coat');
  assert.equal(outcome.classification.brand, 'Burberry');
  assert.equal(outcome.classification.primaryColor, 'Beige');
  assert.deepEqual(outcome.classification.secondaryColors, ['Cream']);
  assert.deepEqual(outcome.classification.material, ['Cotton gabardine']);
  assert.equal(outcome.classification.classificationVersion, 'fashion-identification-v2');
});

test('partial results are accepted — nothing absent is invented', () => {
  const categoryOnly = adapter.resolveClassificationOutcome(
    v2Result({
      item: {
        category: 'Footwear',
        subtype: null,
        brand: { value: null, confidence: null, provenance: 'unknown', evidence: [] },
        colors: { primary: null, secondary: [] },
        material: [],
        silhouette: [],
        pattern: [],
        attributes: { pockets: [], visible: [], distinctive: [] },
      },
    }),
  );
  assert.equal(categoryOnly.status, 'ready_for_review');
  assert.equal(categoryOnly.classification.category, 'Footwear');
  assert.equal(categoryOnly.classification.brand, null, 'unknown brand stays unknown');
  assert.equal(categoryOnly.classification.primaryColor, null, 'unknown colour stays unknown');
  assert.deepEqual(categoryOnly.classification.material, []);

  const subtypeOnly = adapter.resolveClassificationOutcome(
    v2Result({
      status: 'partial',
      item: {
        category: null,
        subtype: 'Chelsea boot',
        brand: { value: null, confidence: null, provenance: 'unknown', evidence: [] },
        colors: { primary: 'Black', secondary: [] },
        material: [],
        silhouette: [],
        pattern: [],
        attributes: { pockets: [], visible: [], distinctive: [] },
      },
    }),
  );
  assert.equal(subtypeOnly.status, 'ready_for_review');
});

test('colour and material confidence are null rather than borrowed', () => {
  const outcome = adapter.resolveClassificationOutcome(v2Result());
  assert.equal(outcome.classification.confidence.category, 0.9);
  assert.equal(outcome.classification.confidence.color, null);
  assert.equal(outcome.classification.confidence.material, null);
});

test('a confidence outside the contract range is unavailable, never clamped', () => {
  // CLAMPING IS THE DANGEROUS DIRECTION. Turning a malformed 5 into 1 would hand
  // every downstream consumer the strongest claim the system can make, produced
  // by a response the backend never sent. Out of range means "we cannot read
  // this", which is what null says.
  for (const value of [1.5, 5, 42, -0.1, -1]) {
    const outcome = adapter.resolveClassificationOutcome(
      v2Result({ confidence: { category: value, subtype: null, brand: null, modelFamily: null, exactProduct: null } }),
    );
    assert.equal(
      outcome.classification.confidence.category,
      null,
      `out-of-range confidence ${value} was accepted`,
    );
  }

  // The boundaries themselves are valid, and zero is an answer rather than a gap.
  for (const value of [0, 0.5, 1]) {
    const outcome = adapter.resolveClassificationOutcome(
      v2Result({ confidence: { category: value, subtype: null, brand: null, modelFamily: null, exactProduct: null } }),
    );
    assert.equal(outcome.classification.confidence.category, value, `rejected valid ${value}`);
  }
});

test('clothingType is never populated from classification', () => {
  // The contract has no clothing-type concept distinct from item.category, so
  // writing both would be redundant names for one thing.
  const outcome = adapter.resolveClassificationOutcome(v2Result());
  assert.equal(outcome.classification.clothingType, null);
});

test('a valid result with no usable taxonomy needs a category, not a retry', () => {
  const bare = {
    category: null,
    subtype: null,
    brand: { value: null, confidence: null, provenance: 'unknown', evidence: [] },
    colors: { primary: 'Blue', secondary: [] },
    material: [],
    silhouette: [],
    pattern: [],
    attributes: { pockets: [], visible: [], distinctive: [] },
  };
  for (const status of ['completed', 'partial', 'insufficient_visual_evidence', 'non_fashion']) {
    const outcome = adapter.resolveClassificationOutcome(v2Result({ status, item: bare }));
    assert.equal(outcome.status, 'needs_manual_classification', status);
    assert.equal(outcome.errorCode, 'classification_requires_manual_category', status);
    assert.notEqual(outcome.status, 'failed', `${status} must not be a hard failure`);
  }
});

test('multiple detected items need a human choice, not a guessed one', () => {
  const outcome = adapter.resolveClassificationOutcome(
    v2Result({
      status: 'multiple_items_need_selection',
      candidates: [
        { candidateId: 'c1', evidenceId: 'e1', category: 'Top' },
        { candidateId: 'c2', evidenceId: 'e1', category: 'Trousers' },
      ],
    }),
  );
  assert.equal(outcome.status, 'needs_manual_classification');
  assert.equal(outcome.errorCode, 'classification_requires_manual_category');
  // The taxonomy is preserved for Build 2's picker, but is not treated as chosen.
  assert.equal(outcome.classification.candidateCount, 2);
});

test('a backend technical_failure is a real failure, distinct from a malformed payload', () => {
  const outcome = adapter.resolveClassificationOutcome(v2Result({ status: 'technical_failure' }));
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.errorCode, 'classification_provider_failed');
  assert.equal(outcome.classification, null);
});

test('a malformed V2 payload is rejected by the shared validator', () => {
  for (const bad of [
    null,
    {},
    { contractVersion: 'fashion-identification-v1' },
    { ...v2Result(), status: 'invented_status' },
    { ...v2Result(), confidence: { category: 0.5 } },
    { ...v2Result(), item: null },
    { ...v2Result(), compatibility: null },
  ]) {
    assert.equal(adapter.validateClosetV2Response(bad).kind, 'invalid');
  }
  assert.equal(adapter.validateClosetV2Response(v2Result()).kind, 'ok');
});

// ── Session flag ─────────────────────────────────────────────────────────────

test('the session flag is latched once and fails closed on a resolver fault', () => {
  const on = adapter.beginClosetV2Session(() => true);
  assert.equal(on.enabled, true);
  assert.equal(adapter.beginClosetV2Session(() => false).enabled, false);
  assert.equal(
    adapter.beginClosetV2Session(() => {
      throw new Error('resolver exploded');
    }).enabled,
    false,
  );
  // Latched: the object is frozen, so a mid-operation change cannot reach it.
  assert.throws(() => {
    'use strict';
    on.enabled = false;
  });
});

test('the default resolver is the closet staging flag, not a scanner or elise flag', () => {
  assert.equal(loadAdapter(false).adapter.beginClosetV2Session().enabled, false);
  assert.equal(loadAdapter(true).adapter.beginClosetV2Session().enabled, true);
});

// ── Telemetry ────────────────────────────────────────────────────────────────

test('Closet telemetry carries no identifier, payload, or provider output', () => {
  const telemetry = adapter.buildClosetV2Telemetry({
    enabled: true,
    attempted: true,
    accepted: true,
    entryPath: 'gallery',
    platform: 'android',
    result: v2Result(),
    candidateCount: 2,
    attemptCount: 1,
    latencyMs: 2400,
    errorCode: null,
  });
  const serialized = JSON.stringify(telemetry);
  for (const forbidden of [
    'Burberry',
    'Trench coat',
    'Beige',
    'QUJDRA',
    '11111111-2222-4333-8444-555555555555',
    'req_closet_1',
  ]) {
    assert.ok(!serialized.includes(forbidden), `telemetry leaked ${forbidden}`);
  }
  assert.equal(telemetry.entryPath, 'closet_gallery');
  assert.equal(telemetry.requestMode, 'detect_items');
  assert.equal(telemetry.candidateCountBucket, '2-3');
  assert.equal(telemetry.latencyBucket, '1-3s');
});

// ── Side-effect governance (source-level) ────────────────────────────────────

const CLOSET_CANDIDATE_SOURCES = [
  'services/closetIdentificationV2.ts',
  'services/closetCandidateClassification.js',
  'services/closetCandidateLibrary.js',
  'services/closetCandidateMedia.js',
  'services/closetCandidateSchema.js',
  'services/closetCandidateStateMachine.ts',
  'services/closetCandidateErrors.ts',
  'services/closetConnectivity.js',
  'services/closetTelemetry.ts',
  'hooks/useClosetCandidates.js',
  'components/closet/ClosetCandidateStatusPanel.tsx',
  // Build 2 Phase 2: the review projection, the one eligibility predicate, the
  // transient selection hook and the review surface join the same side-effect
  // governance as everything else on the candidate path.
  'services/closetBatchReview.ts',
  'services/closetCandidateReviewEligibility.ts',
  'hooks/useClosetBatchSelection.ts',
  'components/closet/ClosetBatchReviewPanel.tsx',
  // Build 2.5 Phase 0B: the Mirror Selfie crop-staging adapter joins the same
  // side-effect governance as every other module on the candidate path.
  'services/closetMirrorStaging.ts',
];

function readCandidateSources() {
  return CLOSET_CANDIDATE_SOURCES.map((rel) => ({
    rel,
    // Comments are stripped so a doc comment that MENTIONS a forbidden symbol
    // (this build has several, deliberately) is not mistaken for a call site.
    code: fs
      .readFileSync(path.join(ROOT, rel), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, ''),
  }));
}

test('no Closet candidate module imports a commerce or retailer surface', () => {
  const forbidden = [
    'purchaseOptions',
    'scanCommerceRouter',
    'shoppingProvider',
    'similarityMatcher',
    'dressingRoomCommerce',
    'recommendedProducts',
    'ProductShelf',
  ];
  for (const { rel, code } of readCandidateSources()) {
    for (const symbol of forbidden) {
      assert.ok(!code.includes(symbol), `${rel} references commerce symbol ${symbol}`);
    }
  }
});

test('no Closet candidate module writes a Recent Scan or a cloud Saved Scan', () => {
  const forbidden = ['saveScan', 'savedScansCloud', 'saveScanToCloud', 'privacyImageUpload'];
  for (const { rel, code } of readCandidateSources()) {
    for (const symbol of forbidden) {
      assert.ok(!code.includes(symbol), `${rel} references Recent/Saved Scan symbol ${symbol}`);
    }
  }
});

test('no Closet candidate module creates an Elise attachment or Dressing Room item', () => {
  const forbidden = [
    'styleChatAttachmentStore',
    'setAttachmentHandoff',
    'eliseIdentificationV2',
    'fashionContextV2',
    'dressingRoom',
    'stylechat-generate',
  ];
  for (const { rel, code } of readCandidateSources()) {
    for (const symbol of forbidden) {
      assert.ok(!code.includes(symbol), `${rel} references ${symbol}`);
    }
  }
});

test('no Closet candidate module commits an item into the authoritative Closet', () => {
  for (const { rel, code } of readCandidateSources()) {
    assert.ok(!code.includes('createClosetItem'), `${rel} commits a Closet item`);
    assert.ok(!code.includes('promoteScanToCloset'), `${rel} promotes into the Closet`);
    assert.ok(!code.includes('updateClosetItem'), `${rel} mutates a Closet item`);
    assert.ok(!code.includes('deleteClosetItem'), `${rel} deletes a Closet item`);
  }
});

test('the store reads the committed Closet but never writes to it', () => {
  const code = fs.readFileSync(path.join(ROOT, 'services/closetCandidateLibrary.js'), 'utf8');
  // Read-only imports are the only ones permitted from closetLibrary.
  const importMatch = code.match(/import\s*\{([^}]*)\}\s*from '\.\/closetLibrary'/);
  assert.ok(importMatch, 'expected a closetLibrary import');
  const imported = importMatch[1]
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  assert.deepEqual(imported.sort(), ['findClosetItemByLineage', 'loadCloset']);
});

test('the ONE Closet network call goes through the Closet adapter', () => {
  const orchestrator = fs.readFileSync(
    path.join(ROOT, 'services/closetCandidateClassification.js'),
    'utf8',
  );
  // The transport is called exactly once, and the V2 envelope is always attached.
  const calls = [...orchestrator.matchAll(/identifyScanImage\(/g)];
  assert.equal(calls.length, 1, 'exactly one Closet transport call site');
  assert.ok(orchestrator.includes('contractRequestV2: built.request'));
  assert.ok(orchestrator.includes("from './closetIdentificationV2'"));
  // No other Closet module may call the transport at all.
  for (const { rel, code } of readCandidateSources()) {
    if (rel === 'services/closetCandidateClassification.js') continue;
    assert.ok(!code.includes('identifyScanImage'), `${rel} calls the transport directly`);
  }
});

test('the candidate media root is disjoint from the Closet and Recent Scan roots', () => {
  const code = fs.readFileSync(path.join(ROOT, 'services/closetCandidateMedia.js'), 'utf8');
  assert.ok(code.includes("'kscan_closet_candidates/'"));
  assert.ok(!code.includes("documentDirectory + 'kscan_closet/'"));
  assert.ok(!code.includes("documentDirectory + 'kscan_library/'"));
});
