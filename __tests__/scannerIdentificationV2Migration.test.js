// Phase 2B.2 — Scanner fashion-identification-v2 migration.
//
// Covers path governance, rollout gating, the single permitted legacy fallback,
// evidence lifecycle, multi-image correlation, single-item resolution, response
// authority, null-safe rendering, versioned persistence, and Elise isolation.
//
// Everything below the transport is the REAL implementation. Only
// `identifyScanImage` is stubbed, so these tests describe what actually goes on
// the wire rather than a re-implementation of it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

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
  vm.runInNewContext(output, {
    exports: mod.exports,
    module: mod,
    console,
    __DEV__: false,
    process: { env: {} },
    require: (id) => {
      if (id.startsWith('node:')) return require(id);
      if (id in requireMap) return requireMap[id];
      throw new Error(`Unexpected import ${id} from ${relativePath}`);
    },
  });
  return mod.exports;
}

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * Source with comments removed.
 *
 * The intent assertions below are about what the code SENDS. Reading raw source
 * would also match a comment that merely explains the architecture — which is how
 * "Elise must never reference the shopping intent" would fail on a doc block
 * describing why Scanner uses it. Stripping comments keeps the assertion pointed
 * at behaviour.
 */
function readCode(rel) {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// Deterministic secure-random substitute. The real generator is crypto-backed,
// which would make evidence-id assertions unstable.
let cryptoCounter = 0;
const contractTypes = loadTsModule('types/fashionIdentificationV2.ts', {});
// Phase 2B.3 re-based the Scanner gateway onto the shared one. Scanner's own
// public API is unchanged, so every assertion below still runs against
// `services/scannerEvidenceGateway.ts` — only the module graph beneath it grew.
const sharedEvidenceGateway = loadTsModule('services/fashionEvidenceGateway.ts', {
  'expo-crypto': {
    getRandomBytes: (n) => {
      cryptoCounter += 1;
      return Uint8Array.from({ length: n }, (_, i) => (i * 31 + cryptoCounter * 7) & 0xff);
    },
  },
});
const sharedV2Core = loadTsModule('services/fashionIdentificationV2Core.ts', {
  '../types/fashionIdentificationV2': contractTypes,
  './fashionEvidenceGateway': sharedEvidenceGateway,
});
const evidenceGateway = loadTsModule('services/scannerEvidenceGateway.ts', {
  './fashionEvidenceGateway': sharedEvidenceGateway,
});
const snapshotModule = loadTsModule('services/identificationSnapshot.ts', {
  '../types/scanIdentification': {},
  '../types/fashionIdentificationV2': {},
});
const displayModule = loadTsModule('services/scannerV2Display.ts', {
  '../types/fashionIdentificationV2': {},
});

function loadAdapter(flagEnabled) {
  return loadTsModule('services/scannerIdentificationV2.ts', {
    '../types/fashionIdentificationV2': contractTypes,
    './scannerEvidenceGateway': evidenceGateway,
    './fashionIdentificationV2Core': sharedV2Core,
    '../constants/featureFlags': {
      resolveScannerIdentificationV2Enabled: () => flagEnabled,
    },
  });
}

const adapter = loadAdapter(false);

function loadRunner(transport, flagEnabled = false) {
  return loadTsModule('services/scannerScanRequest.ts', {
    './scanIdentification': { identifyScanImage: transport },
    '../types/scanIdentification': {},
    '../types/fashionIdentificationV2': contractTypes,
    './scannerEvidenceGateway': evidenceGateway,
    './scannerIdentificationV2': loadAdapter(flagEnabled),
  });
}

const multiImageScan = loadTsModule('services/multiImageScan.ts', {
  '../types/scanIdentification': {},
  '../types/fashionIdentificationV2': {},
  './scannerEvidenceGateway': {},
  './scannerIdentificationV2': {},
});

// ── Fixtures ────────────────────────────────────────────────────────────────

function validV2Result(overrides = {}) {
  return {
    contractVersion: 'fashion-identification-v2',
    requestId: 'req-1',
    status: 'completed',
    resolutionLevel: 'brand_and_subtype',
    item: {
      category: 'Outerwear',
      subtype: 'Puffer Jacket',
      brand: { value: 'Arcteryx', confidence: 0.8, provenance: 'visible_text', evidence: [] },
      colors: { primary: 'Black', secondary: ['Grey'] },
      material: ['Nylon'],
      silhouette: ['Boxy'],
      pattern: [],
      attributes: { pockets: [], visible: ['Zip'], distinctive: [] },
    },
    confidence: {
      category: 0.9, subtype: 0.8, brand: 0.7, modelFamily: null, exactProduct: null,
    },
    exactProduct: null,
    evidence: [{ evidenceId: 'evidence-aaaaaaaa', observations: [] }],
    conflicts: [],
    compatibility: { legacyProjectionAvailable: true, globalConfidence: 0.85 },
    ...overrides,
  };
}

function transitionalResponse(v2, extra = {}) {
  return {
    status: 'completed',
    attributes: { category: 'Outerwear' },
    identification: { item_type: 'Outerwear' },
    recommendedProducts: [{ id: 'p1', title: 'Jacket', price: 100, currency: 'USD', url: 'https://x' }],
    similarityMatches: [],
    contractVersion: 'fashion-identification-v2',
    identificationV2: v2,
    ...extra,
  };
}

function evidenceFor(id = 'evidence-aaaaaaaa', source = 'camera') {
  return {
    evidenceId: id,
    imageBase64: 'BASE64BYTES',
    mimeType: 'image/jpeg',
    source,
  };
}

const enabledFlag = { enabled: true };
const disabledFlag = { enabled: false };

// ── §34 Path governance ─────────────────────────────────────────────────────

test('governance: no active Scanner path calls identifyScanImage directly', () => {
  const hook = read('hooks/useKScan.js');
  assert.doesNotMatch(
    hook,
    /identifyScanImage/,
    'the Scanner hook must reach the network only through the shared adapter',
  );
  assert.match(hook, /runScannerIdentification\(/);
});

test('governance: camera, gallery, multi-image, detection and selection all reach the adapter', () => {
  const hook = read('hooks/useKScan.js');
  // One detection call site, inside the per-image map, and one selection call
  // site, inside the sequential queue. Camera and gallery share both.
  const runCalls = hook.match(/runScannerIdentification\(\{/g) ?? [];
  assert.equal(runCalls.length, 2, 'exactly one detection and one selection call site');
  assert.match(hook, /Promise\.allSettled\(imagesForAttempt\.map/);
  assert.match(hook, /mode:\s*'detect_items'/);
  assert.match(hook, /mode:\s*'identify_selected_item'/);
});

test('governance: Scanner always sends identify_and_shop, never identify_for_style', () => {
  assert.equal(adapter.SCANNER_INTENT, 'identify_and_shop');
  const built = adapter.buildScannerV2Request({
    mode: 'detect_items', evidence: evidenceFor(), platform: 'android', requestId: 'r1',
  });
  assert.equal(built.kind, 'ok');
  assert.equal(built.request.intent, 'identify_and_shop');
  const adapterSource = read('services/scannerIdentificationV2.ts');
  assert.doesNotMatch(
    adapterSource.replace(/^\s*(\/\/|\*).*$/gm, ''),
    /identify_for_style/,
    'Scanner must never reference the style intent outside comments',
  );
});

// ── §35 Flag ────────────────────────────────────────────────────────────────

test('flag: production-compatible default is disabled', () => {
  const flags = loadTsModule('constants/featureFlags.ts', {});
  assert.equal(flags.resolveScannerIdentificationV2Enabled(undefined), false);
  assert.equal(flags.resolveScannerIdentificationV2Enabled(''), false);
  assert.equal(flags.resolveScannerIdentificationV2Enabled('false'), false);
});

test('flag: only the exact string "true" enables it', () => {
  const flags = loadTsModule('constants/featureFlags.ts', {});
  assert.equal(flags.resolveScannerIdentificationV2Enabled('true'), true);
  for (const value of ['TRUE', 'True', ' true', 'true ', '1', 'yes', 'enabled']) {
    assert.equal(
      flags.resolveScannerIdentificationV2Enabled(value),
      false,
      `${JSON.stringify(value)} must not enable Scanner V2`,
    );
  }
});

test('flag: resolved once per session and latched against mid-session change', () => {
  let current = true;
  const session = adapter.beginScannerV2Session(() => current);
  assert.equal(session.enabled, true);
  current = false;
  assert.equal(session.enabled, true, 'a latched session must not observe a later change');
  // A NEW session picks up the new value.
  assert.equal(adapter.beginScannerV2Session(() => current).enabled, false);
});

test('flag: a throwing resolver fails closed onto the legacy path', () => {
  const session = adapter.beginScannerV2Session(() => { throw new Error('boom'); });
  assert.equal(session.enabled, false);
});

test('flag off: the legacy request is sent unchanged and carries no V2 envelope', async () => {
  const calls = [];
  const runner = loadRunner(async (image, options) => {
    calls.push({ image, options });
    return { status: 'completed', recommendedProducts: [] };
  });
  const outcome = await runner.runScannerIdentification({
    mode: 'detect_items', evidence: evidenceFor(), platform: 'android',
    requestId: 'r1', sessionFlag: disabledFlag,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.contractRequestV2, undefined);
  assert.equal(calls[0].options.requestMode, 'multi_item_detection');
  assert.equal(outcome.contractPath, 'legacy');
  assert.equal(outcome.identificationV2, null);
});

test('flag on: a V2 envelope is sent with the correct contract, intent and mode', async () => {
  const calls = [];
  const runner = loadRunner(async (image, options) => {
    calls.push({ image, options });
    return transitionalResponse(validV2Result());
  }, true);
  const outcome = await runner.runScannerIdentification({
    mode: 'detect_items', evidence: evidenceFor(), platform: 'android',
    requestId: 'r1', sessionFlag: enabledFlag,
  });
  const body = calls[0].options.contractRequestV2;
  assert.equal(body.contractVersion, 'fashion-identification-v2');
  assert.equal(body.intent, 'identify_and_shop');
  assert.equal(body.mode, 'detect_items');
  assert.equal(body.source.entryPath, 'scanner_camera');
  assert.equal(body.source.platform, 'android');
  assert.equal(outcome.contractPath, 'v2');
});

// ── §36 Fallback ────────────────────────────────────────────────────────────

test('fallback: unsupported contract version triggers exactly one legacy retry', async () => {
  const calls = [];
  const runner = loadRunner(async (image, options) => {
    calls.push({ image, options });
    if (options.contractRequestV2) {
      return {
        status: 'failed',
        recommendedProducts: [],
        httpStatus: 400,
        contractErrorCode: 'UNSUPPORTED_CONTRACT_VERSION',
      };
    }
    return { status: 'completed', recommendedProducts: [], attributes: { category: 'Top' } };
  }, true);

  const outcome = await runner.runScannerIdentification({
    mode: 'detect_items', evidence: evidenceFor(), platform: 'android',
    requestId: 'r1', sessionFlag: enabledFlag,
  });

  assert.equal(calls.length, 2, 'exactly one V2 attempt and one legacy retry — never a loop');
  assert.ok(calls[0].options.contractRequestV2, 'first call is V2');
  assert.equal(calls[1].options.contractRequestV2, undefined, 'retry is legacy');
  assert.equal(outcome.fallbackUsed, true);
  assert.equal(outcome.contractPath, 'legacy');
});

test('fallback: the retry reuses the same derivative with no recompression', async () => {
  const calls = [];
  const runner = loadRunner(async (image, options) => {
    calls.push({ image, options });
    return options.contractRequestV2
      ? { status: 'failed', recommendedProducts: [], httpStatus: 400, contractErrorCode: 'UNSUPPORTED_CONTRACT_VERSION' }
      : { status: 'completed', recommendedProducts: [] };
  }, true);
  const evidence = evidenceFor('evidence-stable-1');
  await runner.runScannerIdentification({
    mode: 'detect_items', evidence, platform: 'android', requestId: 'r1', sessionFlag: enabledFlag,
  });
  assert.equal(calls[0].image, calls[1].image, 'identical bytes on both attempts');
  assert.equal(calls[0].image, evidence.imageBase64);
  assert.equal(
    calls[0].options.contractRequestV2.evidence[0].evidenceId,
    'evidence-stable-1',
    'no new evidence id is minted for the attempted operation',
  );
});

test('fallback: requests are sequential, never parallel', async () => {
  let inFlight = 0;
  let maxConcurrent = 0;
  const runner = loadRunner(async (image, options) => {
    inFlight += 1;
    maxConcurrent = Math.max(maxConcurrent, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    return options.contractRequestV2
      ? { status: 'failed', recommendedProducts: [], httpStatus: 400, contractErrorCode: 'UNSUPPORTED_CONTRACT_VERSION' }
      : { status: 'completed', recommendedProducts: [] };
  }, true);
  await runner.runScannerIdentification({
    mode: 'detect_items', evidence: evidenceFor(), platform: 'android', requestId: 'r1', sessionFlag: enabledFlag,
  });
  assert.equal(maxConcurrent, 1, 'V2 and legacy must never be in flight together');
});

test('fallback: forbidden for timeout, HTTP 500, auth, quota and technical failure', async () => {
  const forbidden = [
    { label: 'timeout', response: { status: 'failed', recommendedProducts: [], userMessage: 'Analysis is taking longer than expected.' } },
    { label: 'http_500', response: { status: 'failed', recommendedProducts: [], httpStatus: 500, contractErrorCode: 'INTERNAL' } },
    { label: 'auth', response: { status: 'failed', recommendedProducts: [], httpStatus: 401, contractErrorCode: 'UNAUTHORIZED' } },
    { label: 'quota', response: { status: 'rate_limited', recommendedProducts: [] } },
    { label: 'bad_request_other_code', response: { status: 'failed', recommendedProducts: [], httpStatus: 400, contractErrorCode: 'MALFORMED_REQUEST' } },
  ];
  for (const { label, response } of forbidden) {
    const calls = [];
    const runner = loadRunner(async (image, options) => {
      calls.push(options);
      return response;
    }, true);
    const outcome = await runner.runScannerIdentification({
      mode: 'detect_items', evidence: evidenceFor(), platform: 'android', requestId: 'r1', sessionFlag: enabledFlag,
    });
    assert.equal(calls.length, 1, `${label} must not trigger a second request`);
    assert.equal(outcome.fallbackUsed, false, `${label} must not report a fallback`);
  }
});

test('fallback: a malformed V2 payload fails without falling back', async () => {
  const calls = [];
  const runner = loadRunner(async (image, options) => {
    calls.push(options);
    return transitionalResponse({ contractVersion: 'fashion-identification-v2', requestId: 'r1' });
  }, true);
  const outcome = await runner.runScannerIdentification({
    mode: 'detect_items', evidence: evidenceFor(), platform: 'android', requestId: 'r1', sessionFlag: enabledFlag,
  });
  assert.equal(calls.length, 1, 'malformed V2 must not spend a second scan');
  assert.equal(outcome.fallbackUsed, false);
  assert.equal(outcome.identificationV2, null);
  assert.ok(outcome.v2ValidationFailure, 'the validation failure is surfaced, not hidden');
});

test('fallback: only 400 + UNSUPPORTED_CONTRACT_VERSION qualifies', () => {
  assert.equal(adapter.isUnsupportedContractVersion({ httpStatus: 400, errorCode: 'UNSUPPORTED_CONTRACT_VERSION' }), true);
  assert.equal(adapter.isUnsupportedContractVersion({ httpStatus: 400, errorCode: 'MALFORMED_REQUEST' }), false);
  assert.equal(adapter.isUnsupportedContractVersion({ httpStatus: 500, errorCode: 'UNSUPPORTED_CONTRACT_VERSION' }), false);
  assert.equal(adapter.isUnsupportedContractVersion({ httpStatus: null, errorCode: null }), false);
});

// ── §37 Evidence ────────────────────────────────────────────────────────────

test('evidence: generated ids satisfy the contract format', () => {
  for (let i = 0; i < 40; i += 1) {
    const id = evidenceGateway.createEvidenceId();
    assert.match(id, /^[A-Za-z0-9-]{8,64}$/, `bad evidence id: ${id}`);
  }
});

test('evidence: ids are never derived from a path, filename or user identifier', () => {
  const prepared = evidenceGateway.prepareScannerEvidence({
    preparedImage: 'data:image/jpeg;base64,AAA',
    source: 'gallery',
    evidenceId: 'file:///var/mobile/photo.jpg',
  });
  assert.match(prepared.evidenceId, /^[A-Za-z0-9-]{8,64}$/);
  assert.doesNotMatch(prepared.evidenceId, /file|photo|jpg|\//);
  assert.equal(prepared.imageBase64, 'AAA', 'the data-URI prefix never reaches the wire');
});

test('evidence: each image of a batch receives a unique id', () => {
  const ids = new Set();
  for (let i = 0; i < 5; i += 1) {
    ids.add(evidenceGateway.prepareScannerEvidence({
      preparedImage: `bytes-${i}`, source: 'gallery',
      evidenceId: evidenceGateway.createEvidenceId(),
    }).evidenceId);
  }
  assert.equal(ids.size, 5, 'five images must produce five distinct evidence ids');
});

test('evidence: an unchanged image keeps its id through selection', () => {
  const first = evidenceGateway.prepareScannerEvidence({ preparedImage: 'same-bytes', source: 'camera' });
  const reused = evidenceGateway.prepareScannerEvidence({
    preparedImage: 'same-bytes', source: 'camera', evidenceId: first.evidenceId,
  });
  assert.equal(reused.evidenceId, first.evidenceId);
  assert.equal(reused.imageBase64, first.imageBase64, 'and the same bytes');
});

test('evidence: a retake mints a new id, invalidating old candidates', () => {
  const first = evidenceGateway.prepareScannerEvidence({ preparedImage: 'take-1', source: 'camera' });
  const retake = evidenceGateway.prepareScannerEvidence({ preparedImage: 'take-2', source: 'camera' });
  assert.notEqual(retake.evidenceId, first.evidenceId);
  // A candidate from the old evidence can no longer be selected against the new.
  const built = adapter.buildScannerV2Request({
    mode: 'identify_selected_item',
    evidence: retake,
    platform: 'android',
    requestId: 'r1',
    selectedCandidate: {
      evidenceId: first.evidenceId, candidateId: 'c1', category: 'Top',
    },
  });
  assert.equal(built.kind, 'rejected');
  assert.equal(built.reason, 'evidence_id_mismatch');
});

test('evidence: exactly one evidence object per request, with no silent truncation', () => {
  const built = adapter.buildScannerV2Request({
    mode: 'detect_items', evidence: evidenceFor(), platform: 'android', requestId: 'r1',
  });
  assert.equal(built.request.evidence.length, 1);
  assert.equal(built.request.evidence[0].sequenceIndex, 0);
  assert.equal(built.request.evidence[0].transport.type, 'jpeg_base64');
});

test('evidence: the request carries no URI, filename, EXIF, account or device data', () => {
  const built = adapter.buildScannerV2Request({
    mode: 'detect_items',
    evidence: { ...evidenceFor(), source: 'gallery' },
    platform: 'android',
    requestId: 'r1',
  });
  const serialized = JSON.stringify(built.request);
  for (const forbidden of ['file://', 'content://', 'ph://', '.jpg', 'exif', 'assetId', 'deviceId', 'userId']) {
    assert.ok(!serialized.includes(forbidden), `request must not contain ${forbidden}`);
  }
  assert.equal(built.request.privacy.rawExifTransmitted, false);
  assert.equal(built.request.privacy.localFaceMaskApplied, false);
  assert.equal(built.request.privacy.localPlateMaskApplied, false);
});

// ── §38 Multi-image ─────────────────────────────────────────────────────────

test('multi-image: one request per image, none dropped, none combined', async () => {
  const requests = [];
  const runner = loadRunner(async (image, options) => {
    requests.push({ image, body: options.contractRequestV2 });
    return transitionalResponse(validV2Result());
  }, true);

  const images = ['bytes-1', 'bytes-2', 'bytes-3', 'bytes-4', 'bytes-5'];
  await Promise.all(images.map((bytes, index) => runner.runScannerIdentification({
    mode: 'detect_items',
    evidence: evidenceFor(`evidence-batch-${index}${'x'.repeat(3)}`, 'gallery'),
    platform: 'android',
    requestId: `req-${index}`,
    sessionFlag: enabledFlag,
  })));

  assert.equal(requests.length, 5, 'five images must produce five requests');
  for (const request of requests) {
    assert.equal(request.body.evidence.length, 1, 'never more than one evidence per request');
  }
  const ids = new Set(requests.map((r) => r.body.evidence[0].evidenceId));
  assert.equal(ids.size, 5, 'evidence ids must not be reused across different images');
});

test('multi-image: candidates stay partitioned by their source evidence', () => {
  const batches = [
    {
      image: { id: 'img-a', uri: 'file://a.jpg', source: 'upload', originalIndex: 0 },
      preparedImage: 'prep-a',
      evidence: evidenceFor('evidence-imagea-1', 'gallery'),
      evidenceId: 'evidence-imagea-1',
      response: {
        status: 'completed',
        detectedGarments: [{
          candidateId: 'cand-a', order: 0, label: 'A', category: 'Top', subtype: 'Tee',
          attributes: {}, identification: {},
        }],
      },
      v2Candidates: [{ evidenceId: 'evidence-imagea-1', candidateId: 'cand-a', category: 'Top', detectionDigest: 'digest-a' }],
    },
    {
      image: { id: 'img-b', uri: 'file://b.jpg', source: 'upload', originalIndex: 1 },
      preparedImage: 'prep-b',
      evidence: evidenceFor('evidence-imageb-1', 'gallery'),
      evidenceId: 'evidence-imageb-1',
      response: {
        status: 'completed',
        detectedGarments: [{
          candidateId: 'cand-b', order: 0, label: 'B', category: 'Shoes', subtype: 'Sneaker',
          attributes: {}, identification: {},
        }],
      },
      v2Candidates: [{ evidenceId: 'evidence-imageb-1', candidateId: 'cand-b', category: 'Shoes', detectionDigest: 'digest-b' }],
    },
  ];
  const candidates = multiImageScan.buildMultiScanCandidates(batches);
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].v2Correlation.evidenceId, 'evidence-imagea-1');
  assert.equal(candidates[0].v2Correlation.detectionDigest, 'digest-a');
  assert.equal(candidates[0].preparedImage, 'prep-a');
  assert.equal(candidates[1].v2Correlation.evidenceId, 'evidence-imageb-1');
  assert.equal(candidates[1].v2Correlation.detectionDigest, 'digest-b');
  assert.equal(candidates[1].preparedImage, 'prep-b');
  // Candidates from different evidence are never merged into one correlation.
  assert.notEqual(candidates[0].v2Correlation.evidenceId, candidates[1].v2Correlation.evidenceId);
});

test('multi-image: selection uses the candidate identity, never array position', async () => {
  const sent = [];
  const runner = loadRunner(async (image, options) => {
    sent.push({ image, body: options.contractRequestV2 });
    return transitionalResponse(validV2Result());
  }, true);

  // Select the SECOND image's candidate first.
  await runner.runScannerIdentification({
    mode: 'identify_selected_item',
    evidence: evidenceFor('evidence-imageb-1', 'gallery'),
    platform: 'android',
    requestId: 'req-sel',
    sessionFlag: enabledFlag,
    selectedCandidate: {
      evidenceId: 'evidence-imageb-1', candidateId: 'cand-b', category: 'Shoes', detectionDigest: 'digest-b',
    },
  });

  assert.equal(sent[0].image, 'BASE64BYTES');
  assert.equal(sent[0].body.selectedCandidate.evidenceId, 'evidence-imageb-1');
  assert.equal(sent[0].body.selectedCandidate.candidateId, 'cand-b');
  assert.equal(sent[0].body.evidence[0].evidenceId, 'evidence-imageb-1');
});

// ── §39 Single item ─────────────────────────────────────────────────────────

test('single item: the Scanner is detection-first on both stages', () => {
  const hook = read('hooks/useKScan.js');
  const detectionIndex = hook.indexOf("mode: 'detect_items'");
  const selectionIndex = hook.indexOf("mode: 'identify_selected_item'");
  assert.ok(detectionIndex > 0, 'detection stage exists');
  assert.ok(selectionIndex > detectionIndex, 'selection follows detection');
  // No fabricated candidate tuple anywhere in the hook.
  assert.doesNotMatch(hook, /candidateId:\s*['"`]/, 'no hardcoded candidate id');
});

test('single item: a detection request never carries a selected candidate', () => {
  const built = adapter.buildScannerV2Request({
    mode: 'detect_items', evidence: evidenceFor(), platform: 'android', requestId: 'r1',
    selectedCandidate: { evidenceId: 'evidence-aaaaaaaa', candidateId: 'c1', category: 'Top' },
  });
  assert.equal(built.kind, 'ok');
  assert.equal(built.request.selectedCandidate, undefined);
  assert.equal(adapter.validateScannerV2Request({
    ...built.request,
    selectedCandidate: { evidenceId: 'evidence-aaaaaaaa', candidateId: 'c1', category: 'Top' },
  }), false, 'a detection request carrying a candidate is invalid');
});

test('single item: zero candidates is a valid, safe detection outcome', () => {
  const result = validV2Result({ status: 'insufficient_visual_evidence', candidates: [] });
  const extracted = adapter.extractScannerV2Candidates(result, 'evidence-aaaaaaaa');
  assert.equal(extracted.length, 0);
  assert.equal(displayModule.classifyScannerV2Status(result.status), 'insufficient_visual_evidence');
  assert.equal(displayModule.isCompletedIdentity(result.status), false);
});

test('single item: a malformed sole candidate is dropped, never auto-selected', () => {
  const result = validV2Result({
    candidates: [{ candidateId: 'c1', evidenceId: 'evidence-aaaaaaaa' }],
  });
  assert.equal(
    adapter.extractScannerV2Candidates(result, 'evidence-aaaaaaaa').length,
    0,
    'a candidate with no category cannot form a selection tuple',
  );
});

// ── §40 Correlation ─────────────────────────────────────────────────────────

test('correlation: the full tuple is preserved onto the wire', async () => {
  const sent = [];
  const runner = loadRunner(async (image, options) => {
    sent.push(options.contractRequestV2);
    return transitionalResponse(validV2Result());
  }, true);
  const bounds = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 };
  await runner.runScannerIdentification({
    mode: 'identify_selected_item',
    evidence: evidenceFor('evidence-tuple-01'),
    platform: 'android',
    requestId: 'r1',
    sessionFlag: enabledFlag,
    selectedCandidate: {
      evidenceId: 'evidence-tuple-01',
      candidateId: 'cand-9',
      category: 'Outerwear',
      subtype: 'Puffer',
      bounds,
      detectionDigest: 'server-digest-xyz',
    },
  });
  const candidate = sent[0].selectedCandidate;
  assert.equal(candidate.evidenceId, 'evidence-tuple-01');
  assert.equal(candidate.candidateId, 'cand-9');
  assert.equal(candidate.category, 'Outerwear');
  assert.equal(candidate.subtype, 'Puffer');
  assert.deepEqual(candidate.bounds, bounds);
  assert.equal(candidate.detectionDigest, 'server-digest-xyz');
  assert.equal(sent[0].mode, 'identify_selected_item');
});

test('correlation: the detection digest is server-derived and never invented', () => {
  // Absent from detection → absent from the selected-item request.
  const built = adapter.buildScannerV2Request({
    mode: 'identify_selected_item',
    evidence: evidenceFor('evidence-tuple-01'),
    platform: 'android',
    requestId: 'r1',
    selectedCandidate: { evidenceId: 'evidence-tuple-01', candidateId: 'c1', category: 'Top' },
  });
  assert.equal(built.kind, 'ok');
  assert.ok(
    !Object.prototype.hasOwnProperty.call(built.request.selectedCandidate, 'detectionDigest'),
    'no digest is fabricated when detection supplied none',
  );

  // The client never computes one, and never reuses the session id as one.
  const source = read('services/scannerIdentificationV2.ts').replace(/^\s*(\/\/|\*|\/\*).*$/gm, '');
  assert.doesNotMatch(source, /detectionDigest\s*[:=]\s*(sha|digest\(|hash|scanSessionId)/i);
  assert.doesNotMatch(read('services/scannerScanRequest.ts'), /detectionDigest:\s*\w*[Ss]ession/);
});

test('correlation: a missing required value is rejected locally with no network call', async () => {
  const calls = [];
  const runner = loadRunner(async (...args) => { calls.push(args); return {}; }, true);

  for (const candidate of [
    undefined,
    { evidenceId: 'evidence-tuple-01', candidateId: 'c1' },              // no category
    { evidenceId: 'evidence-tuple-01', category: 'Top' },                // no candidateId
    { candidateId: 'c1', category: 'Top' },                              // no evidenceId
    { evidenceId: 'evidence-other-99', candidateId: 'c1', category: 'Top' }, // mismatch
  ]) {
    const outcome = await runner.runScannerIdentification({
      mode: 'identify_selected_item',
      evidence: evidenceFor('evidence-tuple-01'),
      platform: 'android',
      requestId: 'r1',
      sessionFlag: enabledFlag,
      selectedCandidate: candidate,
    });
    assert.ok(outcome.rejection, 'the request is rejected locally');
    assert.equal(outcome.identificationV2, null);
  }
  assert.equal(calls.length, 0, 'no invalid selection may reach the network');
});

test('correlation: candidates naming another evidence id are discarded', () => {
  const result = validV2Result({
    candidates: [
      { candidateId: 'mine', evidenceId: 'evidence-aaaaaaaa', category: 'Top', subtype: 'Tee' },
      { candidateId: 'theirs', evidenceId: 'evidence-bbbbbbbb', category: 'Shoes' },
    ],
  });
  const extracted = adapter.extractScannerV2Candidates(result, 'evidence-aaaaaaaa');
  assert.equal(extracted.length, 1);
  assert.equal(extracted[0].candidateId, 'mine');
});

// ── §41 Rendering ───────────────────────────────────────────────────────────

test('rendering: a null brand neither throws nor renders the text "null"', () => {
  const result = validV2Result();
  result.item.brand.value = null;
  result.item.brand.confidence = null;
  const display = displayModule.buildScannerV2Display(result);
  assert.equal(display.brand, '');
  assert.ok(!display.title.includes('null'));
  assert.ok(!display.title.includes('undefined'));
  assert.equal(display.title, 'Puffer Jacket', 'category/subtype still render without a brand');
  assert.doesNotThrow(() => display.brand.toUpperCase());
});

test('rendering: undefined and missing fields never render as text', () => {
  const display = displayModule.buildScannerV2Display({
    contractVersion: 'fashion-identification-v2',
    requestId: 'r', status: 'partial', resolutionLevel: 'category',
    item: { category: 'Top', subtype: undefined, brand: { value: undefined }, colors: {}, attributes: {} },
    confidence: {}, evidence: [], conflicts: [], compatibility: {},
  });
  const serialized = JSON.stringify(display);
  assert.ok(!serialized.includes('"null"'));
  assert.ok(!serialized.includes('"undefined"'));
  assert.equal(display.title, 'Top');
});

test('rendering: a literal "null" string from a provider is scrubbed', () => {
  assert.equal(displayModule.safeText('null'), '');
  assert.equal(displayModule.safeText('undefined'), '');
  assert.equal(displayModule.safeText('  Nike  '), 'Nike');
  assert.equal(displayModule.safeText(null), '');
  assert.equal(displayModule.safeText(42), '');
});

test('rendering: labels are built from filtered non-empty parts', () => {
  assert.equal(displayModule.joinLabel([null, 'Jacket']), 'Jacket');
  assert.equal(displayModule.joinLabel(['Nike', undefined, 'Jacket']), 'Nike Jacket');
  assert.equal(displayModule.joinLabel([null, undefined]), '');
  assert.equal(displayModule.joinLabel(['Black', 'Grey'], ', '), 'Black, Grey');
});

test('rendering: an unknown confidence is never rendered as zero', () => {
  assert.equal(displayModule.safeConfidence(null), undefined);
  assert.equal(displayModule.safeConfidence(undefined), undefined);
  assert.equal(displayModule.safeConfidence(NaN), undefined);
  assert.equal(displayModule.safeConfidence(0), 0, 'a real zero is preserved');
  const result = validV2Result();
  result.confidence.category = null;
  result.compatibility.globalConfidence = null;
  assert.equal(displayModule.buildScannerV2Display(result).confidence, undefined);
});

test('rendering: a partial result still shows the strongest supported identity', () => {
  const result = validV2Result({ status: 'partial', resolutionLevel: 'category' });
  result.item.brand.value = null;
  result.item.subtype = null;
  const display = displayModule.buildScannerV2Display(result);
  assert.equal(display.category, 'Outerwear');
  assert.equal(display.title, 'Outerwear');
  assert.equal(displayModule.classifyScannerV2Status('partial'), 'partial');
  assert.equal(displayModule.allowsCommerceDisplay('partial'), true);
});

test('rendering: a malformed result degrades to empty rather than throwing', () => {
  for (const bad of [null, undefined, 'string', 42, []]) {
    assert.doesNotThrow(() => displayModule.buildScannerV2Display(bad));
    assert.equal(displayModule.buildScannerV2Display(bad).title, '');
  }
});

// ── §42 Response ────────────────────────────────────────────────────────────

test('response: a valid V2 payload is accepted', () => {
  const validation = adapter.validateScannerV2Response(validV2Result());
  assert.equal(validation.kind, 'ok');
  assert.equal(validation.result.status, 'completed');
});

test('response: wrong version, missing payload and structural damage are rejected', () => {
  assert.equal(adapter.validateScannerV2Response({ ...validV2Result(), contractVersion: 'fashion-identification-v1' }).kind, 'invalid');
  assert.equal(adapter.validateScannerV2Response(undefined).kind, 'invalid');
  assert.equal(adapter.validateScannerV2Response({}).kind, 'invalid');
  const noItem = validV2Result(); delete noItem.item;
  assert.equal(adapter.validateScannerV2Response(noItem).kind, 'invalid');
  const badStatus = validV2Result({ status: 'made_up' });
  assert.equal(adapter.validateScannerV2Response(badStatus).kind, 'invalid');
});

test('response: a missing confidence KEY is rejected, not treated as zero', () => {
  const result = validV2Result();
  delete result.confidence.brand;
  const validation = adapter.validateScannerV2Response(result);
  assert.equal(validation.kind, 'invalid');
  assert.match(validation.category, /confidence_missing_brand/);
  // An explicit null is valid — "unknown" is a real answer.
  const withNull = validV2Result();
  withNull.confidence.brand = null;
  assert.equal(adapter.validateScannerV2Response(withNull).kind, 'ok');
});

test('response: HTTP 200 alone is not treated as validation', async () => {
  const runner = loadRunner(async () => ({
    status: 'completed',
    recommendedProducts: [],
    attributes: { category: 'Top' },
    contractVersion: 'fashion-identification-v2',
    identificationV2: { contractVersion: 'fashion-identification-v2', requestId: 'r', status: 'completed' },
  }), true);
  const outcome = await runner.runScannerIdentification({
    mode: 'detect_items', evidence: evidenceFor(), platform: 'android', requestId: 'r1', sessionFlag: enabledFlag,
  });
  assert.equal(outcome.identificationV2, null, 'a 200 with a malformed body yields no identity');
  assert.ok(outcome.v2ValidationFailure);
});

test('response: statuses stay distinct from one another', () => {
  assert.equal(displayModule.classifyScannerV2Status('insufficient_visual_evidence'), 'insufficient_visual_evidence');
  assert.equal(displayModule.classifyScannerV2Status('technical_failure'), 'technical_failure');
  assert.equal(displayModule.classifyScannerV2Status('non_fashion'), 'non_fashion');
  assert.equal(displayModule.classifyScannerV2Status('multiple_items_need_selection'), 'needs_selection');
  assert.notEqual(
    displayModule.classifyScannerV2Status('insufficient_visual_evidence'),
    displayModule.classifyScannerV2Status('technical_failure'),
  );
});

test('response: non-fashion and detection candidates never show commerce', () => {
  assert.equal(displayModule.allowsCommerceDisplay('non_fashion'), false);
  assert.equal(displayModule.allowsCommerceDisplay('multiple_items_need_selection'), false);
  assert.equal(displayModule.allowsCommerceDisplay('technical_failure'), false);
  assert.equal(displayModule.isCompletedIdentity('multiple_items_need_selection'), false);
});

test('response: purchase options remain available from the legacy-compatible field', async () => {
  const runner = loadRunner(async () => transitionalResponse(validV2Result()), true);
  const outcome = await runner.runScannerIdentification({
    mode: 'identify_selected_item',
    evidence: evidenceFor('evidence-tuple-01'),
    platform: 'android', requestId: 'r1', sessionFlag: enabledFlag,
    selectedCandidate: { evidenceId: 'evidence-tuple-01', candidateId: 'c1', category: 'Top' },
  });
  assert.equal(outcome.response.recommendedProducts.length, 1);
  assert.equal(outcome.response.recommendedProducts[0].id, 'p1');
  assert.equal(outcome.response.recommendedProducts[0].currency, 'USD');
  assert.equal(outcome.response.recommendedProducts[0].url, 'https://x');
  assert.ok(outcome.identificationV2, 'and the V2 identity arrives alongside it');
});

// ── §43 Persistence ─────────────────────────────────────────────────────────

test('persistence: a V2 write records snapshot version 2 and the contract version', () => {
  const snapshot = snapshotModule.buildIdentificationSnapshotV2({
    identification: validV2Result(),
    purchaseOptions: [{ id: 'p1' }],
    source: 'gallery',
    createdAt: '2026-07-27T00:00:00.000Z',
  });
  assert.equal(snapshot.snapshotVersion, 2);
  assert.equal(snapshot.contractVersion, 'fashion-identification-v2');
  assert.equal(snapshot.source, 'gallery');
  assert.equal(snapshot.purchaseOptions.length, 1);
  assert.equal(snapshot.updatedAt, snapshot.createdAt);
});

test('persistence: no image bytes or correlation data are stored', () => {
  const snapshot = snapshotModule.buildIdentificationSnapshotV2({
    identification: validV2Result(),
    purchaseOptions: [],
    source: 'camera',
    createdAt: '2026-07-27T00:00:00.000Z',
  });
  const serialized = JSON.stringify(snapshot);
  for (const forbidden of ['imageBase64', 'BASE64BYTES', 'detectionDigest', 'candidateId', 'file://', 'exif', 'bounds']) {
    assert.ok(!serialized.includes(forbidden), `snapshot must not persist ${forbidden}`);
  }
  assert.ok(!Object.prototype.hasOwnProperty.call(snapshot, 'evidenceId'));
});

test('persistence: a mixed history hydrates per record and one corrupt entry cannot clear it', () => {
  const v2Record = {
    identificationSnapshotV2: snapshotModule.buildIdentificationSnapshotV2({
      identification: validV2Result(), purchaseOptions: [], source: 'camera',
      createdAt: '2026-07-27T00:00:00.000Z',
    }),
  };
  const v1Record = {
    identificationSnapshot: {
      contractVersion: 'fashion-identification-v1', status: 'completed', category: 'Top',
      brand: { value: null, confidence: null, evidence: [] },
      colors: { primary: 'Black', secondary: [] },
      material: [], silhouette: [], pattern: [],
      attributes: { visible: [], distinctive: [] }, confidence: { overall: null },
      source: { entryPath: 'scanner_camera' },
    },
  };
  const legacyRecord = { attributes: { category: 'Shoes', color_palette: 'White' } };

  const raw = [v2Record, null, v1Record, 'not-an-object', legacyRecord, { junk: true }];
  const { records, corruptedCount } = snapshotModule.hydrateScanHistory(raw, (record) =>
    snapshotModule.hydrateScanIdentificationRecord(record));

  assert.equal(records.length, 3, 'every valid record survives');
  assert.equal(records[0].kind, 'v2');
  assert.equal(records[1].kind, 'v1');
  assert.equal(records[2].kind, 'v1', 'unversioned legacy still hydrates');
  assert.equal(corruptedCount, 3);
});

test('persistence: a throwing record drops only itself', () => {
  const { records, corruptedCount } = snapshotModule.hydrateScanHistory([1, 2, 3], (record) => {
    if (record === 2) throw new Error('corrupt');
    return { value: record };
  });
  assert.equal(records.length, 2);
  assert.equal(records[0].value, 1);
  assert.equal(records[1].value, 3);
  assert.equal(corruptedCount, 1);
});

test('persistence: a malformed V2 snapshot does not block a valid V1 on the same record', () => {
  const hydrated = snapshotModule.hydrateScanIdentificationRecord({
    identificationSnapshotV2: { snapshotVersion: 2, contractVersion: 'fashion-identification-v2', identification: 'garbage' },
    identificationSnapshot: {
      contractVersion: 'fashion-identification-v1', status: 'completed', category: 'Top',
      brand: { value: null, confidence: null, evidence: [] },
      colors: { primary: null, secondary: [] }, material: [], silhouette: [], pattern: [],
      attributes: { visible: [], distinctive: [] }, confidence: { overall: null },
      source: { entryPath: 'scanner_camera' },
    },
  });
  assert.equal(hydrated.kind, 'v1', 'invalid V2 must never outrank valid V1');
  assert.equal(hydrated.snapshot.category, 'Top');
});

test('persistence: a valid V2 outranks a matching V1 on the same record', () => {
  const hydrated = snapshotModule.hydrateScanIdentificationRecord({
    identificationSnapshotV2: snapshotModule.buildIdentificationSnapshotV2({
      identification: validV2Result(), purchaseOptions: [], source: 'camera',
      createdAt: '2026-07-27T00:00:00.000Z',
    }),
    identificationSnapshot: {
      contractVersion: 'fashion-identification-v1', status: 'completed', category: 'Stale',
      brand: { value: null, confidence: null, evidence: [] },
      colors: { primary: null, secondary: [] }, material: [], silhouette: [], pattern: [],
      attributes: { visible: [], distinctive: [] }, confidence: { overall: null },
      source: { entryPath: 'scanner_camera' },
    },
  });
  assert.equal(hydrated.kind, 'v2');
});

test('persistence: a V2 envelope is refused for a non-V2 identification', () => {
  assert.equal(snapshotModule.buildIdentificationSnapshotV2({
    identification: { contractVersion: 'fashion-identification-v1' },
    source: 'camera', createdAt: '2026-07-27T00:00:00.000Z',
  }), null);
  assert.equal(snapshotModule.buildIdentificationSnapshotV2({
    identification: validV2Result(), source: 'camera', createdAt: '',
  }), null);
});

test('persistence: reading never rewrites history', () => {
  const librarySource = read('services/library.js');
  // Bounded window after the read entry point. Taken by offset rather than by
  // a following-symbol marker because the two platforms order this file
  // differently.
  const readStart = librarySource.indexOf('async function readAllLibrary');
  assert.ok(readStart > 0, 'the library read path must exist');
  const readSection = librarySource.slice(readStart, readStart + 1400);
  assert.doesNotMatch(readSection, /writeAllLibrary|saveScanToCloud/, 'the read path performs no write');
  assert.match(readSection, /hydrateScanHistory/, 'and hydrates per record');
});

// ── §44 Elise / StyleChat isolation ─────────────────────────────────────────

test('isolation: the Scanner V2 flag is referenced only by Scanner code', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(ts|tsx|js|jsx)$/.test(entry.name)) continue;
      const rel = path.relative(ROOT, full).replace(/\\/g, '/');
      if (rel.startsWith('__tests__/') || rel.startsWith('docs/') || rel.startsWith('_rollback/')) continue;
      const source = fs.readFileSync(full, 'utf8');
      if (!source.includes('SCANNER_IDENTIFICATION_V2')) continue;
      const allowed = rel === 'constants/featureFlags.ts'
        || rel.startsWith('services/scanner');
      if (!allowed) offenders.push(rel);
    }
  };
  walk(ROOT);
  assert.equal(
    offenders.join(', '),
    '',
    'only Scanner modules and the flag definition may reference the flag',
  );
});

test('isolation: Elise and StyleChat never construct a Scanner V2 request', () => {
  const eliseFiles = [
    'components/style-chat/StyleChatPhotoIntake.tsx',
  ].filter((rel) => fs.existsSync(path.join(ROOT, rel)));
  assert.ok(eliseFiles.length > 0, 'the Elise intake surface must exist to be audited');
  for (const rel of eliseFiles) {
    const source = read(rel);
    assert.doesNotMatch(source, /contractRequestV2/, `${rel} must not send a V2 envelope directly`);
    assert.doesNotMatch(source, /runScannerIdentification/, `${rel} must not use the Scanner adapter`);
    assert.doesNotMatch(source, /scannerEvidenceGateway/, `${rel} must not use the Scanner evidence gateway`);
    assert.doesNotMatch(source, /scannerIdentificationV2/, `${rel} must not use the Scanner V2 adapter`);
    assert.doesNotMatch(source, /beginScannerV2Session/, `${rel} must not latch the Scanner flag`);
    // Phase 2B.3 SUPERSEDES the Phase 2B.2 form of this assertion.
    //
    // 2B.2 required that Elise set no contract intent at all, because Elise had
    // not been migrated. 2B.3 migrates it, so the invariant becomes the stronger
    // one: Elise reaches the contract only through its OWN adapter, and the
    // shopping intent must be unreachable from an Elise surface. Keeping the old
    // "no intent" form would now assert that the migration did not happen.
    assert.doesNotMatch(
      readCode(rel),
      /identify_and_shop/,
      `${rel} must never reference the shopping intent in code`,
    );
  }
});

test('isolation: Elise reaches scan-identify only through the Elise adapter', () => {
  // The Elise adapter is the only module allowed to name the style intent, and it
  // writes the constant itself rather than accepting one from a caller — so there
  // is no argument any Elise surface could pass to make Elise shop.
  const adapterSource = readCode('services/style-chat/eliseIdentificationV2.ts');
  assert.match(
    adapterSource,
    /export const ELISE_INTENT = 'identify_for_style' as const;/,
    'the Elise intent is a module constant',
  );
  assert.match(adapterSource, /intent: ELISE_INTENT,/, 'the request writes the constant');
  assert.doesNotMatch(
    adapterSource,
    /identify_and_shop/,
    'the Elise adapter must never name the shopping intent',
  );
  // `intent` must not be an input field: an intent parameter is precisely how a
  // caller could smuggle the shopping intent through an Elise request.
  assert.doesNotMatch(
    adapterSource,
    /^\s*intent\??:\s*Fashion/m,
    'EliseV2RequestInput must not accept an intent',
  );

  // Elise's orchestrator must not delegate to the Scanner request builder, which
  // would inject the shopping intent no matter what the Elise surface intended.
  const orchestratorSource = readCode('services/style-chat/eliseIdentifyForStyle.ts');
  assert.doesNotMatch(orchestratorSource, /buildScannerV2Request/);
  assert.doesNotMatch(orchestratorSource, /runScannerIdentification/);
  assert.doesNotMatch(orchestratorSource, /SCANNER_INTENT/);
  assert.doesNotMatch(orchestratorSource, /identify_and_shop/);
});

test('isolation: the Elise and Scanner rollout flags are independent', () => {
  const flags = read('constants/featureFlags.ts');
  assert.match(flags, /EXPO_PUBLIC_ELISE_IDENTIFICATION_V2_ENABLED/);
  assert.match(flags, /EXPO_PUBLIC_SCANNER_IDENTIFICATION_V2_ENABLED/);
  // Neither resolver may read the other's variable: one flag enabling the other
  // consumer is the coupling this separation exists to prevent.
  const eliseResolver = flags.slice(flags.indexOf('resolveEliseIdentificationV2Enabled'));
  assert.doesNotMatch(
    eliseResolver.slice(0, 400),
    /EXPO_PUBLIC_SCANNER_IDENTIFICATION_V2_ENABLED/,
    'the Elise flag must not read the Scanner variable',
  );
  const scannerResolverIndex = flags.indexOf('resolveScannerIdentificationV2Enabled(');
  assert.doesNotMatch(
    flags.slice(scannerResolverIndex, scannerResolverIndex + 400),
    /EXPO_PUBLIC_ELISE_IDENTIFICATION_V2_ENABLED/,
    'the Scanner flag must not read the Elise variable',
  );
});

test('isolation: the shared transport keeps legacy behaviour when no V2 envelope is passed', () => {
  const source = read('services/scanIdentification.ts');
  // The V2 body is used only when the caller explicitly supplies it.
  assert.match(source, /options\.contractRequestV2\s*\n?\s*\?/);
  assert.match(source, /:\s*\(legacyRequestBody as unknown as Record<string, unknown>\)/);
  assert.match(source, /contractRequestV2\?:\s*Record<string, unknown>/, 'the option is optional');
});

test('isolation: the shared mapper is unchanged for callers that pass no V2 result', () => {
  const mapperSource = read('services/scanIdentificationMapper.ts');
  assert.match(mapperSource, /options: MapScanIdentifyOptions = \{\}/, 'options default to empty');
  assert.match(mapperSource, /const v2Result = options\.identificationV2 \?\? null;/);
  assert.match(mapperSource, /if \(v2Result\) \{/, 'the V2 snapshot is written only when supplied');
});

// ── §33 Telemetry ───────────────────────────────────────────────────────────

test('telemetry: only bounded, non-identifying fields are recorded', () => {
  const telemetry = adapter.buildScannerV2Telemetry({
    enabled: true, attempted: true, accepted: true,
    mode: 'identify_selected_item', evidenceSource: 'gallery', platform: 'android',
    result: validV2Result(), candidateCount: 3, snapshotVersion: 2,
  });
  const serialized = JSON.stringify(telemetry);
  for (const forbidden of [
    'evidence-', 'BASE64', 'detectionDigest', 'candidateId', 'bounds',
    'file://', '.jpg', 'https://', 'userId', 'deviceId', 'email',
  ]) {
    assert.ok(!serialized.includes(forbidden), `telemetry must not contain ${forbidden}`);
  }
  assert.equal(telemetry.candidateCountBucket, '2-3', 'counts are bucketed, not exact');
  assert.equal(telemetry.entryPath, 'scanner_gallery');
  assert.equal(telemetry.snapshotVersion, 2);
});

test('telemetry: the only fallback reason is unsupported_version', () => {
  const withFallback = adapter.buildScannerV2Telemetry({
    enabled: true, attempted: true, accepted: false, mode: 'detect_items',
    evidenceSource: 'camera', platform: 'android', result: null, fallbackUsed: true,
  });
  assert.equal(withFallback.fallbackUsed, true);
  assert.equal(withFallback.fallbackReason, 'unsupported_version');

  const noFallback = adapter.buildScannerV2Telemetry({
    enabled: true, attempted: true, accepted: false, mode: 'detect_items',
    evidenceSource: 'camera', platform: 'android', result: null, fallbackUsed: false,
  });
  assert.equal(noFallback.fallbackReason, null, 'no other reason can ever be recorded');
});

test('telemetry: counts are bucketed at every boundary', () => {
  assert.equal(adapter.bucketCount(0), '0');
  assert.equal(adapter.bucketCount(1), '1');
  assert.equal(adapter.bucketCount(3), '2-3');
  assert.equal(adapter.bucketCount(5), '4-5');
  assert.equal(adapter.bucketCount(99), '6+');
  assert.equal(adapter.bucketCount(null), null);
  assert.equal(adapter.bucketCount(-1), null);
});
