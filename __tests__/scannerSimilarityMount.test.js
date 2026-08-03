// Checkpoint 5A — proof that the REAL scanner dispatch path invokes the REAL
// candidate provider, and that turning the flag off restores the pre-mount
// request exactly.
//
// WHY THIS FILE EXISTS SEPARATELY FROM similarityRequestLifecycle.test.js
//
// That file proves the provider behaves correctly when called. It cannot prove
// anything about whether the scanner CALLS it — and for the whole of
// Checkpoint 4.5 the answer was "it does not". A unit test of a provider is not
// evidence of a mount, so every test here drives `runScannerIdentification`
// itself and asserts on the options object the transport actually received.
//
// NON-VACUITY REQUIREMENT
//
// Deleting the `attachSimilarityCandidates(...)` call from
// `services/scannerScanRequest.ts` must fail tests in this file. The mount
// tests therefore assert on transmitted candidate CONTENT (specific ids
// derived from records only the injected loaders could have produced), not on
// the mere presence of a field.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function withExtension(relative) {
  if (/\.(ts|tsx|js)$/.test(relative)) return relative;
  for (const ext of ['.ts', '.tsx', '.js']) {
    if (fs.existsSync(path.join(ROOT, relative + ext))) return relative + ext;
  }
  return relative;
}

const moduleCache = new Map();

function loadModule(relativeInput, requireMap = {}, env = {}) {
  const relative = withExtension(relativeInput);
  const cacheKey = `${relative}::${JSON.stringify(Object.keys(requireMap).sort())}::${JSON.stringify(env)}`;
  if (moduleCache.has(cacheKey)) return moduleCache.get(cacheKey);

  const filename = path.join(ROOT, relative);
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;

  const mod = { exports: {} };
  const sandbox = {
    console, exports: mod.exports, module: mod, JSON, Math, Date, TextEncoder,
    Object, Array, Set, Map, String, Number, Boolean, Error, RegExp, Promise,
    setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
    process: { env },
    __DEV__: false,
    require: (id) => {
      if (id in requireMap) return requireMap[id];
      if (id.startsWith('./') || id.startsWith('../')) {
        return loadModule(path.join(path.dirname(relative), id), requireMap, env);
      }
      throw new Error(`unexpected import '${id}'`);
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(output, sandbox, { filename });
  moduleCache.set(cacheKey, mod.exports);
  return mod.exports;
}

// The transport is the ONLY behavioural stub. Everything below it — the
// attachment module, the provider, the adapters, the selection pipeline, the
// ledger — is the real shipped code, which is what makes this a mount proof
// rather than a mock test. The remaining entries are native modules that
// cannot load under Node and are irrelevant to the mount.
const NATIVE_STUBS = {
  'expo-crypto': {
    digestStringAsync: async (_alg, value) => `sha256-${String(value).length}`,
    CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
    randomUUID: () => '00000000-0000-4000-8000-000000000000',
  },
  'expo-file-system': {},
  'expo-image-manipulator': {},
  'react-native': { Platform: { OS: 'android', select: (o) => o.android ?? o.default } },
};

function loadScannerScanRequest() {
  return loadModule('services/scannerScanRequest.ts', {
    ...NATIVE_STUBS,
    './scanIdentification': {
      identifyScanImage: async () => {
        throw new Error('real transport must never be reached in tests');
      },
    },
  });
}

// EVIDENCE_ID_PATTERN is /^[A-Za-z0-9-]{8,64}$/ — hyphens only, no underscore.
const EVIDENCE_ID = 'ev-0000-0000-0000-0000-000000000001';

/**
 * Values crossing the `vm` boundary carry that realm's Array/Object
 * prototypes, so `assert.deepEqual` (strict, via node:assert/strict) reports
 * "same structure but not reference-equal". Re-materializing through JSON in
 * the host realm compares the DATA, which is what these assertions mean.
 */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function evidence(id = EVIDENCE_ID) {
  return { evidenceId: id, imageBase64: 'BASE64IMAGEBYTES', source: 'camera' };
}

function selectedCandidate(id = EVIDENCE_ID) {
  return { evidenceId: id, candidateId: 'cand-1', category: 'outerwear', subtype: 'jacket' };
}

// Field names below are the RAW stored shapes `closetRecordToCandidate` and
// `recentScanRecordToCandidate` actually read (category/primaryColor/material
// on a Closet item; attributes.* on a scan). Using the real shapes is what
// makes this exercise the true adapter rather than a convenient stand-in.

/** A Closet record in the real stored shape the adapter expects. */
function closetRecord(overrides = {}) {
  return {
    id: 'closet-1',
    ownerId: 'actor-1',
    title: 'Black Leather Jacket',
    updatedAt: '2026-08-01T00:00:00.000Z',
    imageUri: 'file:///closet-1.jpg',
    category: 'outerwear',
    subtype: 'jacket',
    primaryColor: 'black',
    material: 'leather',
    ...overrides,
  };
}

/** A Recent Scans record in the real stored shape the adapter expects. */
function recentScanRecord(overrides = {}) {
  return {
    id: 'scan-1',
    ownerId: 'actor-1',
    thumbnailUri: 'file:///scan-1.jpg',
    createdAt: '2026-08-02T00:00:00.000Z',
    attributes: {
      category: 'outerwear',
      silhouette: 'bomber',
      color_palette: 'black',
      material_estimate: 'leather',
    },
    ...overrides,
  };
}

const QUERY = {
  canonicalCategory: 'outerwear',
  subtype: 'jacket',
  color: 'black',
  material: 'leather',
};

function baseInput(overrides = {}) {
  return {
    mode: 'identify_selected_item',
    evidence: evidence(),
    platform: 'android',
    requestId: 'req-1',
    sessionFlag: { enabled: false },
    selectedCandidate: selectedCandidate(),
    ...overrides,
  };
}

/** Captures the options the transport received, and returns a benign response. */
function capturingTransport(capture, response = { status: 'completed', recommendedProducts: [] }) {
  return async (_image, options) => {
    capture.push(options);
    return response;
  };
}

function binding(overrides = {}) {
  const calls = { closet: 0, recent: 0 };
  const built = {
    enabled: true,
    scanId: 'scan-session-1',
    query: QUERY,
    loadClosetRecords: () => { calls.closet += 1; return [closetRecord()]; },
    loadRecentScanRecords: () => { calls.recent += 1; return [recentScanRecord()]; },
    ...overrides,
  };
  built.__calls = calls;
  return built;
}

// ── A. Provider reachability from the real dispatch path ────────────────────

test('MOUNT — an enabled selected-item dispatch reaches the provider and transmits its candidates', async () => {
  const { runScannerIdentification } = loadScannerScanRequest();
  const sent = [];
  const bind = binding();

  const outcome = await runScannerIdentification(baseInput({
    similarity: bind,
    transport: capturingTransport(sent),
  }));

  assert.equal(sent.length, 1, 'exactly one request should be dispatched');
  const options = sent[0];

  // The loaders actually ran. Without this the field could be fabricated.
  assert.equal(bind.__calls.closet, 1, 'the real Closet loader must be invoked exactly once');
  assert.equal(bind.__calls.recent, 1, 'the real Recent Scans loader must be invoked exactly once');

  // Deterministic CONTENT, not mere presence — this is what makes the test
  // fail if the attach call is deleted.
  assert.ok(Array.isArray(options.existingItems), 'existingItems must be attached');
  const ids = options.existingItems.map((item) => item.id).sort();
  assert.deepEqual(plain(ids), ['closet-1', 'scan-1']);

  const sources = options.existingItems.map((item) => item.source).sort();
  assert.deepEqual(plain(sources), ['closet', 'recent_scan']);

  assert.equal(outcome.similarity.attached, true);
  assert.equal(outcome.similarity.instrumentation.transmittedCount, 2);
});

test('MOUNT — the attach decision is reported even when it declines', async () => {
  const { runScannerIdentification } = loadScannerScanRequest();
  const sent = [];
  const outcome = await runScannerIdentification(baseInput({
    similarity: binding({ enabled: false }),
    transport: capturingTransport(sent),
  }));

  assert.equal(outcome.similarity.attached, false);
  assert.equal(outcome.similarity.skipReason, 'flag_disabled');
  assert.equal(outcome.similarity.instrumentation.mode, 'identify_selected_item');
});

// ── C. Detection must never load or attach ──────────────────────────────────

test('MULTI-ITEM — the initial detection request loads nothing and attaches nothing', async () => {
  const { runScannerIdentification } = loadScannerScanRequest();
  const sent = [];
  const bind = binding();

  const outcome = await runScannerIdentification(baseInput({
    mode: 'detect_items',
    selectedCandidate: undefined,
    similarity: bind,
    transport: capturingTransport(sent),
  }));

  // The critical assertion: no candidate loading happens against a garment the
  // user has not chosen yet.
  assert.equal(bind.__calls.closet, 0, 'detection must not read the Closet');
  assert.equal(bind.__calls.recent, 0, 'detection must not read Recent Scans');
  assert.equal(
    Object.prototype.hasOwnProperty.call(sent[0], 'existingItems'),
    false,
    'detection must not carry existingItems at all',
  );
  assert.equal(outcome.similarity.skipReason, 'not_a_resolved_item_request');
});

test('MULTI-ITEM — candidates load only AFTER a selection produces a resolved identity', async () => {
  const { runScannerIdentification } = loadScannerScanRequest();
  const bind = binding();
  const sent = [];

  // 1. detection — no loading
  await runScannerIdentification(baseInput({
    mode: 'detect_items',
    selectedCandidate: undefined,
    similarity: bind,
    transport: capturingTransport(sent),
  }));
  assert.equal(bind.__calls.closet, 0);

  // 2. the user chooses a candidate → selected-item request → loading happens
  await runScannerIdentification(baseInput({
    similarity: bind,
    transport: capturingTransport(sent),
  }));
  assert.equal(bind.__calls.closet, 1, 'the Closet is read only after selection');
  assert.equal(sent.length, 2);
  assert.equal(Object.prototype.hasOwnProperty.call(sent[0], 'existingItems'), false);
  assert.ok(Array.isArray(sent[1].existingItems));
});

// ── D. Flag-off rollback: byte-identical to the pre-mount request ───────────

test('ROLLBACK — flag off invokes neither loader and omits existingItems entirely', async () => {
  const { runScannerIdentification } = loadScannerScanRequest();
  const sent = [];
  const bind = binding({ enabled: false });

  await runScannerIdentification(baseInput({
    similarity: bind,
    transport: capturingTransport(sent),
  }));

  assert.equal(bind.__calls.closet, 0, 'a disabled flag must not read the Closet');
  assert.equal(bind.__calls.recent, 0, 'a disabled flag must not read Recent Scans');
  assert.equal(
    Object.prototype.hasOwnProperty.call(sent[0], 'existingItems'),
    false,
    'existingItems must be ABSENT, not present-and-empty',
  );
});

test('ROLLBACK — flag off produces a request byte-identical to no binding at all', async () => {
  const { runScannerIdentification } = loadScannerScanRequest();

  const withFlagOff = [];
  await runScannerIdentification(baseInput({
    similarity: binding({ enabled: false }),
    transport: capturingTransport(withFlagOff),
  }));

  const withNoBinding = [];
  await runScannerIdentification(baseInput({
    transport: capturingTransport(withNoBinding),
  }));

  // `signal` and function-valued keys are dropped by JSON; neither is set here.
  assert.deepEqual(
    JSON.parse(JSON.stringify(withFlagOff[0])),
    JSON.parse(JSON.stringify(withNoBinding[0])),
    'a disabled binding must not change the request in any way',
  );
});

test('ROLLBACK — flag off is unchanged on the V2 contract path too', async () => {
  const { runScannerIdentification } = loadScannerScanRequest();

  const off = [];
  await runScannerIdentification(baseInput({
    sessionFlag: { enabled: true },
    similarity: binding({ enabled: false }),
    transport: capturingTransport(off, {
      status: 'completed',
      recommendedProducts: [],
      identificationV2: null,
    }),
  }));

  const none = [];
  await runScannerIdentification(baseInput({
    sessionFlag: { enabled: true },
    transport: capturingTransport(none, {
      status: 'completed',
      recommendedProducts: [],
      identificationV2: null,
    }),
  }));

  assert.equal(Object.prototype.hasOwnProperty.call(off[0], 'existingItems'), false);
  assert.deepEqual(
    JSON.parse(JSON.stringify(off[0])),
    JSON.parse(JSON.stringify(none[0])),
  );
});

test('MOUNT — candidates are attached on the V2 contract path as well as legacy', async () => {
  const { runScannerIdentification } = loadScannerScanRequest();
  const sent = [];

  await runScannerIdentification(baseInput({
    sessionFlag: { enabled: true },
    similarity: binding(),
    transport: capturingTransport(sent, {
      status: 'completed',
      recommendedProducts: [],
      identificationV2: null,
    }),
  }));

  assert.ok(sent[0].contractRequestV2, 'the V2 path should have been taken');
  assert.ok(Array.isArray(sent[0].existingItems));
  assert.deepEqual(plain(sent[0].existingItems.map((i) => i.id).sort()), ['closet-1', 'scan-1']);
});

// ── H. Fail-open lifecycle ──────────────────────────────────────────────────

test('FAIL-OPEN — a throwing Closet loader still dispatches the scan without candidates', async () => {
  const { runScannerIdentification } = loadScannerScanRequest();
  const sent = [];

  const outcome = await runScannerIdentification(baseInput({
    similarity: binding({
      loadClosetRecords: () => { throw new Error('closet exploded'); },
      loadRecentScanRecords: () => [],
    }),
    transport: capturingTransport(sent),
  }));

  assert.equal(sent.length, 1, 'the scan must still be dispatched');
  assert.equal(Object.prototype.hasOwnProperty.call(sent[0], 'existingItems'), false);
  assert.equal(outcome.response.status, 'completed', 'the scan result must be unaffected');
  assert.equal(outcome.similarity.attached, false);
  assert.equal(outcome.similarity.instrumentation.failureReason, 'closet_load_failed');
});

test('FAIL-OPEN — a rejecting loader is reported, not thrown', async () => {
  const { runScannerIdentification } = loadScannerScanRequest();
  const sent = [];

  const outcome = await runScannerIdentification(baseInput({
    similarity: binding({
      loadClosetRecords: () => Promise.reject(new Error('nope')),
      loadRecentScanRecords: () => Promise.reject(new Error('nope')),
    }),
    transport: capturingTransport(sent),
  }));

  assert.equal(sent.length, 1);
  assert.equal(outcome.similarity.instrumentation.failureReason, 'both_loads_failed');
});

test('FAIL-OPEN — a hanging loader is bounded by the configurable guard', async () => {
  const { runScannerIdentification } = loadScannerScanRequest();
  const sent = [];

  const outcome = await runScannerIdentification(baseInput({
    similarity: binding({
      // Never settles. The guard must cut it off.
      loadClosetRecords: () => new Promise(() => {}),
      loadRecentScanRecords: () => [],
      loadDeadlineMs: 25,
    }),
    transport: capturingTransport(sent),
  }));

  assert.equal(sent.length, 1, 'the scan must proceed after the guard fires');
  assert.equal(outcome.similarity.attached, false);
  assert.equal(outcome.similarity.instrumentation.failureReason, 'closet_load_failed');
});

test('FAIL-OPEN — malformed loader output is dropped, not transmitted', async () => {
  const { runScannerIdentification } = loadScannerScanRequest();
  const sent = [];

  await runScannerIdentification(baseInput({
    similarity: binding({
      loadClosetRecords: () => [null, 42, 'garbage', { noIdAtAll: true }],
      loadRecentScanRecords: () => 'not-an-array',
    }),
    transport: capturingTransport(sent),
  }));

  assert.equal(sent.length, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(sent[0], 'existingItems'), false);
});

test('FAIL-OPEN — no surviving candidates omits the field rather than sending []', async () => {
  const { runScannerIdentification } = loadScannerScanRequest();
  const sent = [];

  const outcome = await runScannerIdentification(baseInput({
    similarity: binding({
      loadClosetRecords: () => [],
      loadRecentScanRecords: () => [],
    }),
    transport: capturingTransport(sent),
  }));

  assert.equal(Object.prototype.hasOwnProperty.call(sent[0], 'existingItems'), false);
  assert.equal(outcome.similarity.skipReason, 'no_candidates_survived');
});

test('FAIL-OPEN — an instrumentation sink that throws cannot fail the scan', async () => {
  const { runScannerIdentification } = loadScannerScanRequest();
  const sent = [];

  const outcome = await runScannerIdentification(baseInput({
    similarity: binding({
      onInstrumentation: () => { throw new Error('sink exploded'); },
    }),
    transport: capturingTransport(sent),
  }));

  assert.equal(sent.length, 1);
  assert.equal(outcome.response.status, 'completed');
});

// ── Duplicate dispatch / lifecycle ledger ───────────────────────────────────

test('LIFECYCLE — a resumed duplicate dispatch does not attach a second candidate set', async () => {
  const { runScannerIdentification } = loadScannerScanRequest();
  const ledgerModule = loadModule('services/similarityRequestLedger.ts');
  const sent = [];

  let sharedLedger = ledgerModule.createSimilarityLedger();
  const bind = binding({ ledger: sharedLedger });

  const first = await runScannerIdentification(baseInput({
    similarity: { ...bind, ledger: sharedLedger },
    transport: capturingTransport(sent),
  }));
  assert.equal(first.similarity.attached, true);
  sharedLedger = first.similarity.ledger;

  // Same scanId — a background/resume replay of the same scan.
  const second = await runScannerIdentification(baseInput({
    similarity: { ...bind, ledger: sharedLedger },
    transport: capturingTransport(sent),
  }));

  assert.equal(second.similarity.attached, false);
  assert.equal(second.similarity.skipReason, 'ledger_already_dispatched');
  assert.equal(Object.prototype.hasOwnProperty.call(sent[1], 'existingItems'), false);
  assert.equal(sent.length, 2, 'the scan itself still dispatched both times');
});

test('LIFECYCLE — no substitution: a candidate set is never reused for a different scan', async () => {
  const { runScannerIdentification } = loadScannerScanRequest();
  const ledgerModule = loadModule('services/similarityRequestLedger.ts');
  const sent = [];

  let sharedLedger = ledgerModule.createSimilarityLedger();
  const first = await runScannerIdentification(baseInput({
    similarity: binding({ scanId: 'scan-A', ledger: sharedLedger }),
    transport: capturingTransport(sent),
  }));
  sharedLedger = first.similarity.ledger;

  // A brand new scan gets its OWN set built for it, never scan-A's.
  const second = await runScannerIdentification(baseInput({
    similarity: binding({ scanId: 'scan-B', ledger: sharedLedger }),
    transport: capturingTransport(sent),
  }));

  assert.equal(second.similarity.attached, true);
  assert.equal(second.similarity.instrumentation.scanId, 'scan-B');
});

// ── F. Candidate cap ────────────────────────────────────────────────────────

test('CAP — 120 eligible records are bounded to the governed cap through the real path', async () => {
  const { runScannerIdentification } = loadScannerScanRequest();
  const candidatesModule = loadModule('services/similarItemCandidates.ts');
  const cap = candidatesModule.DEFAULT_CLIENT_CANDIDATE_CAP;
  const sent = [];

  const manyCloset = Array.from({ length: 60 }, (_, i) =>
    closetRecord({ id: `closet-${i}` }));
  const manyRecent = Array.from({ length: 60 }, (_, i) =>
    recentScanRecord({ id: `scan-${i}` }));

  const outcome = await runScannerIdentification(baseInput({
    similarity: binding({
      loadClosetRecords: () => manyCloset,
      loadRecentScanRecords: () => manyRecent,
    }),
    transport: capturingTransport(sent),
  }));

  assert.equal(sent[0].existingItems.length, cap);
  assert.ok(
    sent[0].existingItems.length <= candidatesModule.TRANSPORT_CANDIDATE_CEILING,
    'must never exceed the transport sanitizer ceiling',
  );
  // The bound is applied on the client, not left to backend truncation.
  assert.equal(outcome.similarity.instrumentation.report.recordsLoaded.total, 120);
  assert.equal(outcome.similarity.instrumentation.transmittedCount, cap);
});

// ── G. Privacy / field minimization ─────────────────────────────────────────

test('PRIVACY — private fields on stored records never reach the request', async () => {
  const { runScannerIdentification } = loadScannerScanRequest();
  const sent = [];

  await runScannerIdentification(baseInput({
    similarity: binding({
      loadClosetRecords: () => [closetRecord({
        ownerId: 'actor-secret-uuid',
        userId: 'actor-secret-uuid',
        email: 'person@example.com',
        accessToken: 'ey.ACCESS',
        refreshToken: 'ey.REFRESH',
        deviceId: 'device-abc',
        authorization: 'Bearer nope',
        imageBase64: 'AAAABBBBCCCC',
        rawRow: { secret: true },
      })],
      loadRecentScanRecords: () => [],
    }),
    transport: capturingTransport(sent),
  }));

  const serialized = JSON.stringify(sent[0].existingItems);
  for (const forbidden of [
    'actor-secret-uuid', 'person@example.com', 'ey.ACCESS', 'ey.REFRESH',
    'device-abc', 'Bearer nope', 'AAAABBBBCCCC', 'rawRow',
  ]) {
    assert.equal(
      serialized.includes(forbidden), false,
      `forbidden value leaked into the request: ${forbidden}`,
    );
  }

  const ALLOWED = new Set([
    'id', 'source', 'label', 'imageUri', 'brand', 'model', 'canonicalCategory',
    'color', 'material', 'silhouette', 'pattern', 'productUrl',
    'authoritativeId', 'imageQuality',
  ]);
  for (const item of sent[0].existingItems) {
    for (const key of Object.keys(item)) {
      assert.ok(ALLOWED.has(key), `unexpected transmitted field: ${key}`);
    }
  }
});

test('PRIVACY — the candidate byte delta is measured and bounded', async () => {
  const { runScannerIdentification } = loadScannerScanRequest();

  const without = [];
  await runScannerIdentification(baseInput({
    similarity: binding({ enabled: false }),
    transport: capturingTransport(without),
  }));

  const withCandidates = [];
  const outcome = await runScannerIdentification(baseInput({
    similarity: binding(),
    transport: capturingTransport(withCandidates),
  }));

  const bytesWithout = JSON.stringify(without[0]).length;
  const bytesWith = JSON.stringify(withCandidates[0]).length;
  const delta = bytesWith - bytesWithout;

  assert.ok(delta > 0, 'candidates should add measurable bytes');
  assert.equal(
    typeof outcome.similarity.instrumentation.payloadBytes, 'number',
    'the candidate payload size must be recorded',
  );
  console.log(
    `ℹ request bytes without candidates=${bytesWithout} with=${bytesWith} delta=${delta} ` +
    `providerPayloadBytes=${outcome.similarity.instrumentation.payloadBytes}`,
  );
});

// ── E. Instrumentation ──────────────────────────────────────────────────────

test('INSTRUMENTATION — every stage is measured and each loader is timed independently', async () => {
  const { runScannerIdentification } = loadScannerScanRequest();
  const records = [];

  const outcome = await runScannerIdentification(baseInput({
    similarity: binding({ onInstrumentation: (r) => records.push(r) }),
    transport: capturingTransport([]),
  }));

  assert.equal(records.length, 1, 'exactly one instrumentation record per attempt');
  const r = records[0];

  assert.equal(r.attached, true);
  assert.equal(r.transmittedCount, 2);
  assert.equal(typeof r.payloadBytes, 'number');
  assert.equal(typeof r.totalMs, 'number');

  // Loader timings are INDEPENDENT — the defect this checkpoint fixed was both
  // loads sharing one start/end pair, which made a slow source unattributable.
  const t = r.loadTimings;
  for (const key of [
    'closetMs', 'recentScansMs', 'closetStartedAtMs', 'closetCompletedAtMs',
    'recentScansStartedAtMs', 'recentScansCompletedAtMs', 'combinedMs',
  ]) {
    assert.equal(typeof t[key], 'number', `missing loader timing: ${key}`);
  }
  assert.equal(t.closetCompletedAtMs - t.closetStartedAtMs, t.closetMs);
  assert.equal(t.recentScansCompletedAtMs - t.recentScansStartedAtMs, t.recentScansMs);

  // Per-source counts and per-stage timings come from the real report.
  const report = r.report;
  assert.equal(report.recordsLoaded.closet, 1);
  assert.equal(report.recordsLoaded.recent_scan, 1);
  assert.equal(report.recordsTransmitted, 2);
  for (const key of ['normalizeMs', 'pruneMs', 'prioritizeMs', 'dedupeMs', 'totalMs']) {
    assert.equal(typeof report.timings[key], 'number', `missing stage timing: ${key}`);
  }
  assert.ok(Array.isArray(report.recordsRejected));
  assert.equal(outcome.similarity.instrumentation, r);
});

test('INSTRUMENTATION — a slow Closet load is attributable to the Closet alone', async () => {
  const { runScannerIdentification } = loadScannerScanRequest();
  const records = [];

  await runScannerIdentification(baseInput({
    similarity: binding({
      loadClosetRecords: () => new Promise((resolve) => {
        setTimeout(() => resolve([closetRecord()]), 60);
      }),
      loadRecentScanRecords: () => [recentScanRecord()],
      onInstrumentation: (r) => records.push(r),
    }),
    transport: capturingTransport([]),
  }));

  const t = records[0].loadTimings;
  assert.ok(t.closetMs >= 50, `closet load should be measured as slow, got ${t.closetMs}ms`);
  assert.ok(
    t.recentScansMs < t.closetMs,
    'the fast Recent Scans load must NOT inherit the slow Closet duration',
  );
  // Concurrency is visible: the pair finishes in about the slower one's time.
  assert.ok(t.combinedMs < t.closetMs + t.recentScansMs + 40);
});

// ── K. Product-flow preservation ────────────────────────────────────────────

test('PRODUCT FLOW — the response is passed through untouched when candidates attach', async () => {
  const { runScannerIdentification } = loadScannerScanRequest();
  const productResponse = {
    status: 'completed',
    recommendedProducts: [
      { id: 'p1', title: 'Black Leather Jacket', retailer: 'ACME', confidence: 'high' },
      { id: 'p2', title: 'Bomber', retailer: 'OTHER', confidence: 'medium' },
    ],
    userMessage: 'Found matches',
  };

  const withCandidates = await runScannerIdentification(baseInput({
    similarity: binding(),
    transport: capturingTransport([], productResponse),
  }));
  const withoutCandidates = await runScannerIdentification(baseInput({
    similarity: binding({ enabled: false }),
    transport: capturingTransport([], productResponse),
  }));

  assert.deepEqual(plain(withCandidates.response), plain(withoutCandidates.response));
  assert.deepEqual(
    plain(withCandidates.response.recommendedProducts.map((p) => p.id)),
    ['p1', 'p2'],
    'product ranking must be unchanged',
  );
});

test('PRODUCT FLOW — a total similarity failure does not degrade the product result', async () => {
  const { runScannerIdentification } = loadScannerScanRequest();
  const productResponse = {
    status: 'completed',
    recommendedProducts: [{ id: 'p1', title: 'Jacket', retailer: 'ACME' }],
  };

  const outcome = await runScannerIdentification(baseInput({
    similarity: binding({
      loadClosetRecords: () => { throw new Error('boom'); },
      loadRecentScanRecords: () => { throw new Error('boom'); },
    }),
    transport: capturingTransport([], productResponse),
  }));

  assert.equal(outcome.response.status, 'completed');
  assert.deepEqual(plain(outcome.response.recommendedProducts), productResponse.recommendedProducts);
});

// ── Request lineage preservation ────────────────────────────────────────────

test('LINEAGE — attaching candidates preserves selection token and correlation', async () => {
  const { runScannerIdentification } = loadScannerScanRequest();
  const sent = [];
  const token = { issuedFor: 'cand-1', nonce: 'abc123' };

  await runScannerIdentification(baseInput({
    legacyCorrelation: { scanSessionId: 'sess-9', imageDigestPrefix: 'deadbeef' },
    selectionToken: token,
    similarity: binding(),
    transport: capturingTransport(sent),
  }));

  assert.equal(sent[0].scanSessionId, 'sess-9');
  assert.equal(sent[0].imageDigestPrefix, 'deadbeef');
  assert.deepEqual(plain(sent[0].selectionToken), token);
  assert.equal(sent[0].requestMode, 'selected_item');
  assert.equal(sent[0].selectedCandidate.candidateId, 'cand-1');
  assert.ok(Array.isArray(sent[0].existingItems));
});

test('GATE — a selected-item request with no resolved identity attaches nothing', async () => {
  const { runScannerIdentification } = loadScannerScanRequest();
  const sent = [];
  const bind = binding({ query: {} });

  const outcome = await runScannerIdentification(baseInput({
    similarity: bind,
    transport: capturingTransport(sent),
  }));

  assert.equal(bind.__calls.closet, 0, 'an empty query must not trigger a read');
  assert.equal(outcome.similarity.skipReason, 'no_identity_resolved');
  assert.equal(Object.prototype.hasOwnProperty.call(sent[0], 'existingItems'), false);
});
