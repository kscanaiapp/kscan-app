// Mirror candidate-staging coordinator suite (Build 2.5 Step 4).
//
// services/mirror/mirrorCandidateIntegration.ts is exercised against the REAL
// candidate pipeline — closetCandidateLibrary.js, closetCandidateMedia.js,
// closetCandidateSchema.js, closetCandidateStateMachine.ts, closetMirrorStaging.ts,
// closetBatchReview.ts, actorContext.js — running over an in-memory filesystem,
// the same harness __tests__/closetMirrorStaging.test.js already proves the real
// store with, extended with a Mirror-session-shaped memfs (cacheDirectory,
// file:// URIs) so crop-ownership checks run against real paths.
//
// Classification is INJECTED (deps.requeueClassification), never the real
// network-calling module: "unit and integration tests must mock or control
// backend calls" — see the Step 4 addendum. A dedicated structural test at the
// bottom of this file proves production code (the hook) does NOT override it,
// i.e. the real requeueClosetCandidatesOnReconnect is what actually runs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const CACHE = 'file:///cache/';

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

function memfs() {
  const files = new Map();
  const dirs = new Set();
  const modified = new Map();
  const api = {
    documentDirectory: '/doc/',
    cacheDirectory: CACHE,
    EncodingType: { UTF8: 'utf8', Base64: 'base64' },
    async makeDirectoryAsync(dir) {
      dirs.add(dir);
    },
    async getInfoAsync(p) {
      if (files.has(p)) {
        return {
          exists: true,
          size: Buffer.from(files.get(p), 'utf8').length,
          modificationTime: (modified.get(p) ?? 0) / 1000,
        };
      }
      // Directory-existence fallback: a stored key COUNTS only if it continues
      // past `p` with a `/` (a real path-segment boundary), never merely
      // shares `p` as a string prefix. Without the boundary check,
      // ".../kscan_closet_candidates.json" is reported as "existing" purely
      // because ".../kscan_closet_candidates.json.tmp" also starts with it —
      // which made the candidate store's own write-verify-swap sequence
      // misread its temp file as the canonical manifest already being present.
      if (
        dirs.has(p) ||
        [...files.keys()].some((f) => f.startsWith(p) && f.length > p.length && f[p.length] === '/')
      ) {
        return { exists: true, isDirectory: true, modificationTime: 1000 };
      }
      return { exists: false };
    },
    async readAsStringAsync(p) {
      if (!files.has(p)) throw new Error('ENOENT');
      return files.get(p);
    },
    async writeAsStringAsync(p, c) {
      files.set(p, c);
      modified.set(p, Date.now());
    },
    async moveAsync({ from, to }) {
      if (!files.has(from)) throw new Error('ENOENT');
      files.set(to, files.get(from));
      modified.set(to, modified.get(from) ?? Date.now());
      files.delete(from);
      modified.delete(from);
    },
    async deleteAsync(p) {
      files.delete(p);
      dirs.delete(p);
      modified.delete(p);
      for (const key of [...files.keys()]) if (key.startsWith(p)) files.delete(key);
    },
    async readDirectoryAsync(dir) {
      const names = [];
      for (const key of files.keys()) {
        if (!key.startsWith(dir)) continue;
        const rest = key.slice(dir.length);
        if (!rest || rest.includes('/')) continue;
        names.push(rest);
      }
      return names;
    },
    async getFreeDiskStorageAsync() {
      return 10 * 1024 * 1024 * 1024;
    },
  };
  return { files, dirs, api };
}

function cryptoShim() {
  let seq = 0;
  return {
    getRandomBytes(n) {
      seq += 1;
      return Uint8Array.from({ length: n }, (_, i) => (seq * 31 + i * 7) % 256);
    },
    randomUUID: () => {
      seq += 1;
      return `00000000-0000-4000-8000-${seq.toString(16).padStart(12, '0')}`;
    },
    CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
    CryptoEncoding: { HEX: 'hex', BASE64: 'base64' },
    async digestStringAsync(_algo, data) {
      let h1 = 0x811c9dc5;
      let h2 = 0x01000193;
      for (let i = 0; i < data.length; i += 1) {
        h1 = ((h1 ^ data.charCodeAt(i)) * 16777619) >>> 0;
        h2 = ((h2 + data.charCodeAt(i) * (i + 1)) * 2654435761) >>> 0;
      }
      return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`.repeat(4);
    },
  };
}

/**
 * @param options.mirrorActive default true
 * @param options.requeueClassification spy/stub for the injected classification
 *        trigger; defaults to a no-op recorder.
 */
function load(options = {}) {
  const m = memfs();
  const crypto = cryptoShim();
  const actorContext = runModule('services/actorContext.js', () => ({}));

  let cacheSeq = 0;
  const imageManipulator = {
    SaveFormat: { JPEG: 'jpeg' },
    manipulateAsync: async (uri, ops) => {
      if (options.manipulatorFailsFor && options.manipulatorFailsFor(uri)) {
        throw new Error('manipulate failed');
      }
      cacheSeq += 1;
      const width = ops?.[0]?.resize?.width ?? 0;
      const cacheUri = `/cache/derived_${cacheSeq}.jpg`;
      m.files.set(cacheUri, Buffer.from(`derived:${uri}:${width}`).toString('base64'));
      return { uri: cacheUri };
    },
  };

  const library = runModule('services/library.js', (spec) => {
    if (spec === 'expo-file-system/legacy') return m.api;
    if (spec === 'expo-image-manipulator') return imageManipulator;
    if (spec === './actorContext') return actorContext;
    return {};
  });
  const closetLibrary = runModule('services/closetLibrary.js', (spec) => {
    if (spec === 'expo-file-system/legacy') return m.api;
    if (spec === 'expo-image-manipulator') return imageManipulator;
    if (spec === 'react-native') return { Platform: { OS: 'android' } };
    if (spec === './actorContext') return actorContext;
    if (spec === './library') return library;
    return {};
  });

  const types = runModule('types/closetCandidate.ts', () => ({}));
  const stateMachine = runModule('services/closetCandidateStateMachine.ts', (spec) =>
    spec === '../types/closetCandidate' ? types : {},
  );
  const candidateErrors = runModule('services/closetCandidateErrors.ts', (spec) =>
    spec === '../types/closetCandidate' ? types : {},
  );
  const schema = runModule('services/closetCandidateSchema.js', (spec) => {
    if (spec === 'expo-crypto') return crypto;
    if (spec === '../types/closetCandidate') return types;
    if (spec === './closetCandidateErrors') return candidateErrors;
    if (spec === './closetCandidateStateMachine') return stateMachine;
    return {};
  });

  const telemetryEvents = [];
  const telemetry = runModule('services/closetTelemetry.ts', () => ({}));
  telemetry.setClosetTelemetrySink((event, payload) => telemetryEvents.push({ event, payload }));

  const media = runModule('services/closetCandidateMedia.js', (spec) => {
    if (spec === 'expo-file-system/legacy') return m.api;
    if (spec === 'expo-image-manipulator') return imageManipulator;
    if (spec === 'expo-crypto') return crypto;
    if (spec === './library') return library;
    if (spec === '../types/closetCandidate') return types;
    return {};
  });
  const store = runModule('services/closetCandidateLibrary.js', (spec) => {
    if (spec === 'react-native') return { Platform: { OS: 'android' } };
    if (spec === 'expo-file-system/legacy') return m.api;
    if (spec === './actorContext') return actorContext;
    if (spec === './closetLibrary') return closetLibrary;
    if (spec === '../types/closetCandidate') return types;
    if (spec === './closetCandidateSchema') return schema;
    if (spec === './closetCandidateStateMachine') return stateMachine;
    if (spec === './closetCandidateMedia') return media;
    if (spec === './closetTelemetry') return telemetry;
    return {};
  });

  const mirrorActive = options.mirrorActive !== false;
  const featureFlags = { MIRROR_SELFIE_V1_ACTIVE: mirrorActive };

  const staging = runModule('services/closetMirrorStaging.ts', (spec) => {
    if (spec === 'expo-crypto') return crypto;
    if (spec === './actorContext') return actorContext;
    if (spec === './closetCandidateLibrary') return store;
    if (spec === './closetCandidateSchema') return schema;
    if (spec === './closetTelemetry') return telemetry;
    if (spec === '../constants/featureFlags') return featureFlags;
    if (spec === '../types/closetCandidate') return types;
    return {};
  });

  const reviewEligibility = runModule('services/closetCandidateReviewEligibility.ts', (spec) => {
    if (spec === '../types/closetCandidate') return types;
    if (spec === './closetCandidateStateMachine') return stateMachine;
    return {};
  });
  const promotionContract = runModule('services/closetCandidatePromotionContract.ts', () => ({}));
  const batchReview = runModule('services/closetBatchReview.ts', (spec) => {
    if (spec === '../types/closetCandidate') return types;
    if (spec === './closetCandidateStateMachine') return stateMachine;
    if (spec === './closetCandidateErrors') return candidateErrors;
    if (spec === './closetCandidateReviewEligibility') return reviewEligibility;
    if (spec === './closetCandidatePromotionContract') return promotionContract;
    return {};
  });

  // The REAL contract module, not a hand-stubbed subset — a partial stub here
  // previously omitted `isValidMirrorSessionId`, which made every ownership
  // check throw internally, get swallowed by isMirrorSessionOwnedUri's own
  // try/catch, and fail closed silently. Wiring the genuine module is what
  // makes that class of bug impossible to reintroduce.
  const mirrorExtractionTypes = runModule('types/mirrorExtraction.ts', (spec) =>
    spec === './closetCandidate' ? types : {},
  );
  const mirrorSessionStorage = runModule('services/mirror/mirrorSessionStorage.ts', (spec) => {
    if (spec === 'expo-file-system/legacy') return m.api;
    if (spec === 'expo-crypto') return crypto;
    if (spec.includes('mirrorExtraction')) return mirrorExtractionTypes;
    return {};
  });

  const requeueCalls = [];
  const requeueClassification =
    options.requeueClassification ??
    (async (actorRequest) => {
      requeueCalls.push(actorRequest);
      return { ok: true, started: 0, results: [] };
    });

  const coordinator = runModule('services/mirror/mirrorCandidateIntegration.ts', (spec) => {
    if (spec === 'expo-file-system/legacy') return m.api;
    if (spec === '../actorContext') return actorContext;
    if (spec === '../closetMirrorStaging') return staging;
    if (spec === '../closetCandidateLibrary') return store;
    if (spec === '../closetCandidateClassification') return { requeueClosetCandidatesOnReconnect: requeueClassification };
    if (spec === '../closetCandidateErrors') return candidateErrors;
    if (spec === '../closetBatchReview') return batchReview;
    if (spec === './mirrorSessionStorage') return mirrorSessionStorage;
    if (spec === '../closetTelemetry') return telemetry;
    if (spec === '../../constants/featureFlags') return featureFlags;
    return {};
  });

  return {
    m,
    actorContext,
    store,
    staging,
    telemetry,
    telemetryEvents,
    batchReview,
    featureFlags,
    mirrorSessionStorage,
    coordinator,
    requeueCalls,
    types,
  };
}

function asActor(actorContext, actorId) {
  actorContext.advanceActorEpoch(actorId);
  return actorContext.createActorRequest();
}

/** A crop URI shaped exactly like a real Mirror session crop file. */
function cropPath(sessionId, key) {
  return `${CACHE}kscan_mirror_sessions/${sessionId}/crops/${key}.jpg`;
}

function seedSelection(m, sessionId, keys, markerPrefix = 'crop') {
  const crops = keys.map((key, i) => {
    const uri = cropPath(sessionId, key);
    m.files.set(uri, Buffer.from(`${markerPrefix}${i}:${uri}`).toString('base64'));
    return { cropUri: uri, cropKey: key };
  });
  return { extractionSessionId: sessionId, crops };
}

function keysOf(n, prefix = 'k') {
  return Array.from({ length: n }, (_, i) => `${prefix}${i}`);
}

// ── Handoff validation ───────────────────────────────────────────────────────

test('MIRROR-EXTRACTION-SELECTION-WIRES-TO-STAGING: a valid selection creates real candidates', async () => {
  const { m, actorContext, store, coordinator } = load();
  const actorRequest = asActor(actorContext, 'user-1');
  const selection = seedSelection(m, 'sess_1', keysOf(2));

  const result = await coordinator.integrateMirrorExtractionSelection(selection);
  assert.equal(result.outcome, 'created');
  assert.deepEqual(result.successfulCropKeys.sort(), ['k0', 'k1']);

  const listed = await store.listClosetCandidates(actorRequest);
  assert.equal(listed.candidates.length, 2);
  assert.ok(listed.candidates.every((c) => c.sourceType === 'mirror_extract'));
});

test('MIRROR-INVALID-SESSION-REJECTED', async () => {
  const { m, coordinator } = load();
  const selection = seedSelection(m, 'sess_1', ['k0']);
  selection.extractionSessionId = 'not a legal id!!';
  const result = await coordinator.integrateMirrorExtractionSelection(selection);
  assert.equal(result.outcome, 'rejected');
  assert.equal(result.rejectReason, 'mirror_integration_invalid_session');
  assert.equal(result.candidateBatchIds.length, 0);
});

test('MIRROR-DUPLICATE-CROP-KEY-REJECTED', async () => {
  const { m, coordinator } = load();
  const selection = seedSelection(m, 'sess_1', ['k0']);
  selection.crops.push({ ...selection.crops[0] });
  const result = await coordinator.integrateMirrorExtractionSelection(selection);
  assert.equal(result.outcome, 'rejected');
  assert.equal(result.rejectReason, 'mirror_integration_duplicate_crop_key');
});

test('MIRROR-UNREADABLE-CROP-REJECTED', async () => {
  const { m, coordinator } = load();
  const selection = seedSelection(m, 'sess_1', ['k0']);
  // The crop is declared but never written to the memfs.
  selection.crops.push({ cropUri: cropPath('sess_1', 'ghost'), cropKey: 'ghost' });
  const result = await coordinator.integrateMirrorExtractionSelection(selection);
  assert.equal(result.outcome, 'rejected');
  assert.equal(result.rejectReason, 'mirror_integration_crop_unreadable');
  // Nothing was created from the valid crop either — the whole handoff fails closed.
  assert.equal(result.candidateBatchIds.length, 0);
});

test('a crop URI outside the declared session is rejected even if it exists on disk', async () => {
  const { m, coordinator } = load();
  const selection = seedSelection(m, 'sess_1', ['k0']);
  // A real file, but owned by a DIFFERENT session than the one declared.
  const foreignUri = cropPath('sess_OTHER', 'k1');
  m.files.set(foreignUri, Buffer.from('x').toString('base64'));
  selection.crops.push({ cropUri: foreignUri, cropKey: 'k1' });
  const result = await coordinator.integrateMirrorExtractionSelection(selection);
  assert.equal(result.outcome, 'rejected');
  assert.equal(result.rejectReason, 'mirror_integration_crop_not_session_owned');
});

test('MIRROR-ZERO-CROP-HANDOFF-CREATES-NO-CANDIDATE', async () => {
  const { m, actorContext, store, coordinator } = load();
  const actorRequest = asActor(actorContext, 'user-1');
  const result = await coordinator.integrateMirrorExtractionSelection({
    extractionSessionId: 'sess_1',
    crops: [],
  });
  assert.equal(result.outcome, 'rejected');
  assert.equal(result.rejectReason, 'mirror_integration_empty_selection');
  const listed = await store.listClosetCandidates(actorRequest);
  assert.equal(listed.candidates.length, 0);
});

test('the flag gate: disabled means nothing is touched', async () => {
  const { m, actorContext, store, coordinator } = load({ mirrorActive: false });
  asActor(actorContext, 'user-1');
  const selection = seedSelection(m, 'sess_1', keysOf(2));
  const result = await coordinator.integrateMirrorExtractionSelection(selection);
  assert.equal(result.outcome, 'rejected');
  assert.equal(result.rejectReason, 'mirror_integration_disabled');
  const listed = await store.listClosetCandidates(asActor(actorContext, 'user-1'));
  assert.equal(listed.candidates.length, 0);
});

// ── Batching ─────────────────────────────────────────────────────────────────

test('MIRROR-ONE-CROP-CREATES-ONE-GROUP and MIRROR-EIGHT-CROPS-CREATES-ONE-GROUP', async () => {
  for (const n of [1, 8]) {
    const { m, actorContext, coordinator } = load();
    asActor(actorContext, 'user-1');
    const selection = seedSelection(m, 'sess_1', keysOf(n));
    const result = await coordinator.integrateMirrorExtractionSelection(selection);
    assert.equal(result.groups.length, 1);
    assert.equal(result.successfulCropKeys.length, n);
    assert.equal(result.candidateBatchIds.length, 1);
  }
});

test('MIRROR-NINE-CROPS-CREATES-EIGHT-PLUS-ONE', async () => {
  const { m, actorContext, coordinator } = load();
  asActor(actorContext, 'user-1');
  const selection = seedSelection(m, 'sess_1', keysOf(9));
  const result = await coordinator.integrateMirrorExtractionSelection(selection);
  assert.equal(result.groups.length, 2);
  assert.equal(result.groups[0].cropKeys.length, 8);
  assert.equal(result.groups[1].cropKeys.length, 1);
  assert.equal(result.successfulCropKeys.length, 9);
  assert.equal(result.candidateBatchIds.length, 2);
});

test('MIRROR-SIXTEEN-CROPS-CREATES-EIGHT-PLUS-EIGHT', async () => {
  const { m, actorContext, coordinator } = load();
  asActor(actorContext, 'user-1');
  const selection = seedSelection(m, 'sess_1', keysOf(16));
  const result = await coordinator.integrateMirrorExtractionSelection(selection);
  assert.equal(result.groups.length, 2);
  assert.equal(result.groups[0].cropKeys.length, 8);
  assert.equal(result.groups[1].cropKeys.length, 8);
  assert.equal(result.successfulCropKeys.length, 16);
});

test('MIRROR-SEVENTEEN-CROPS-CREATES-EIGHT-EIGHT-ONE', async () => {
  const { m, actorContext, coordinator } = load();
  asActor(actorContext, 'user-1');
  const selection = seedSelection(m, 'sess_1', keysOf(17));
  const result = await coordinator.integrateMirrorExtractionSelection(selection);
  assert.deepEqual(result.groups.map((g) => g.cropKeys.length), [8, 8, 1]);
  assert.equal(result.successfulCropKeys.length, 17);
  assert.equal(result.candidateBatchIds.length, 3);
  // Every crop appears exactly once across the whole result.
  const allKeys = result.groups.flatMap((g) => g.cropKeys);
  assert.deepEqual([...allKeys].sort(), keysOf(17).sort());
  assert.equal(new Set(allKeys).size, 17);
});

test('MIRROR-BATCHING-PRESERVES-ORDER and MIRROR-NO-CROP-IS-TRUNCATED', async () => {
  const { coordinator, m } = load();
  const keys = keysOf(17);
  const selection = seedSelection(m, 'sess_1', keys);
  const partitioned = coordinator.partitionMirrorCrops(selection.crops);
  const flat = partitioned.flatMap((g) => g.cropKeys);
  assert.deepEqual(flat, keys, 'partitioning reordered or dropped crops');
});

test('MIRROR-NO-STAGING-CALL-EXCEEDS-EIGHT', async () => {
  const { m, actorContext, coordinator, staging } = load();
  asActor(actorContext, 'user-1');
  const selection = seedSelection(m, 'sess_1', keysOf(17));
  const calls = [];
  await coordinator.integrateMirrorExtractionSelection(selection, {
    stageGroup: async (input) => {
      calls.push(input.crops.length);
      return staging.stageMirrorSelfieGarmentCrops(input);
    },
  });
  assert.ok(calls.length >= 1);
  for (const size of calls) assert.ok(size <= 8, `a staging call carried ${size} crops`);
});

// ── Serial execution ─────────────────────────────────────────────────────────

test('MIRROR-STAGING-GROUPS-EXECUTE-SERIALLY: group 2 does not begin before group 1 settles', async () => {
  const { m, actorContext, coordinator, staging } = load();
  asActor(actorContext, 'user-1');
  const selection = seedSelection(m, 'sess_1', keysOf(9));

  let inFlight = 0;
  let maxConcurrent = 0;
  const order = [];

  await coordinator.integrateMirrorExtractionSelection(selection, {
    stageGroup: async (input) => {
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      order.push(`start:${input.crops.length}`);
      // Yield to the microtask queue so a concurrent implementation WOULD
      // interleave here if the coordinator dispatched groups with Promise.all.
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(`end:${input.crops.length}`);
      inFlight -= 1;
      return staging.stageMirrorSelfieGarmentCrops(input);
    },
  });

  assert.equal(maxConcurrent, 1, 'more than one staging call was in flight at once');
  assert.deepEqual(order, ['start:8', 'end:8', 'start:1', 'end:1']);
});

// ── Contract vocabulary ──────────────────────────────────────────────────────

test('MIRROR-STAGING-USES-MIRROR-EXTRACT: candidates carry sourceType mirror_extract', async () => {
  const { m, actorContext, store, coordinator } = load();
  const actorRequest = asActor(actorContext, 'user-1');
  await coordinator.integrateMirrorExtractionSelection(seedSelection(m, 'sess_1', ['k0']));
  const listed = await store.listClosetCandidates(actorRequest);
  assert.equal(listed.candidates[0].sourceType, 'mirror_extract');
});

test('MIRROR-STAGING-NEVER-USES-IDENTIFY-AND-SHOP: the coordinator cannot reach it', () => {
  const source = fs.readFileSync(
    path.join(ROOT, 'services/mirror/mirrorCandidateIntegration.ts'),
    'utf8',
  );
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  for (const forbidden of [
    'identify_and_shop',
    'scannerIdentificationV2',
    'scanner_camera',
    'scanner_gallery',
    'closet_gallery',
    'closet_camera',
  ]) {
    assert.ok(!code.includes(forbidden), `coordinator source references ${forbidden}`);
  }
  const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
  // Exact specifiers, not substrings: the coordinator LEGITIMATELY imports
  // '../closetCandidateLibrary' (the candidate STAGING store, for
  // CLOSET_CANDIDATE_BATCH_MAX_ITEMS) — a bare substring check on "library"
  // would flag that correct import as if it were Recent Scan's
  // services/library.js, which is a different module entirely.
  for (const forbidden of ['scannerIdentificationV2', '../library', './library', 'savedScanMedia', 'commerce']) {
    assert.ok(!imports.includes(forbidden), `coordinator imports ${forbidden}`);
  }
});

// The intent/entryPath/mode contract itself (identify_for_closet, closet_mirror,
// detect_items) is already certified by __tests__/closetMirrorContractActivation
// .test.js and closetIdentificationV2's own suite — closetEntryPathKeyForSource
// resolves 'mirror_extract' to 'closet_mirror' regardless of WHO calls staging,
// so re-asserting it here would duplicate that coverage rather than test this
// coordinator. What IS this coordinator's job, and IS tested above, is that it
// stages with sourceType 'mirror_extract' and touches nothing else.

// ── Actor isolation ──────────────────────────────────────────────────────────

test('MIRROR-ACTOR-CHANGE-BEFORE-STAGING-CREATES-NOTHING', async () => {
  const { m, actorContext, store, coordinator } = load();
  // Captured BEFORE the change — exactly as
  // hooks/useClosetCandidates.js#stageMirrorSelection captures it, as its
  // first statement, before calling the coordinator. Without an externally
  // supplied snapshot there would be no earlier moment to compare against: a
  // request minted fresh INSIDE the coordinator always looks current against
  // itself, which is precisely the trap this snapshot exists to avoid.
  const capturedActorRequest = asActor(actorContext, 'user-1');
  const selection = seedSelection(m, 'sess_1', keysOf(3));
  actorContext.advanceActorEpoch('user-2'); // actor changes before the call even starts
  const result = await coordinator.integrateMirrorExtractionSelection(selection, {
    actorRequest: capturedActorRequest,
  });
  assert.equal(result.outcome, 'rejected');
  assert.equal(result.rejectReason, 'mirror_integration_actor_stale');
  const listed = await store.listClosetCandidates(asActor(actorContext, 'user-2'));
  assert.equal(listed.candidates.length, 0);
});

test('MIRROR-ACTOR-CHANGE-BETWEEN-GROUPS-STOPS-FUTURE-GROUPS', async () => {
  const { m, actorContext, store, coordinator, staging } = load();
  const actorRequest = asActor(actorContext, 'user-1');
  const selection = seedSelection(m, 'sess_1', keysOf(17));

  let groupsSeen = 0;
  const result = await coordinator.integrateMirrorExtractionSelection(selection, {
    actorRequest,
    stageGroup: async (input) => {
      groupsSeen += 1;
      // The change happens BEFORE the (real) staging call, inside what is
      // still nominally "group 2" — which means group 2 itself is rejected as
      // stale by stageMirrorSelfieGarmentCrops's OWN internal check (it
      // shares the ONE actorRequest object captured at the operation's
      // start), not merely "allowed to finish in flight". That is the
      // correct, fail-closed behaviour: the coordinator does not get to
      // decide group 2 succeeded when the pipeline itself already refused it.
      if (groupsSeen === 2) actorContext.advanceActorEpoch('user-2');
      return staging.stageMirrorSelfieGarmentCrops(input);
    },
  });

  // Group 1 (8 crops) succeeded before the change. Group 2 (8 crops) was
  // rejected AS stale the moment it reached the pipeline; group 3 (1 crop)
  // was never attempted at all. Both count as not-started.
  assert.equal(result.groups[0].status, 'succeeded');
  assert.equal(result.groups[1].status, 'not_started');
  assert.equal(result.groups[2].status, 'not_started');
  assert.equal(result.notStartedCropKeys.length, 9);
  assert.equal(groupsSeen, 2, 'a third group was dispatched after the actor changed');

  // The abandoned crops are cleaned (they belong to user-1's own session),
  // not left attributed to whoever is signed in now.
  for (const crop of [...selection.crops.slice(8, 16), selection.crops[16]]) {
    // eslint-disable-next-line no-await-in-loop
    const stillThere = await m.api.getInfoAsync(crop.cropUri);
    assert.equal(stillThere.exists, false, `${crop.cropKey} was not cleaned`);
  }

  // The stale `actorRequest` captured under user-1 cannot itself read the
  // store any more — the actor context is a single global "who is signed in
  // now", and listClosetCandidates enforces currency on reads too, correctly.
  // Proving durability means simulating user-1 signing back in later, exactly
  // like MIRROR-ACTOR-CHANGE-BEFORE-STAGING-CREATES-NOTHING already does.
  const user1Candidates = await store.listClosetCandidates(asActor(actorContext, 'user-1'));
  assert.ok(user1Candidates.candidates.length >= 8, 'user-1 lost their own successful group');
});

test('the COORDINATOR\'s own between-group check stops group 3, independent of the pipeline\'s check', async () => {
  // The test above changes the actor INSIDE group 2's callback before calling
  // the REAL stageMirrorSelfieGarmentCrops, so group 2 is rejected by the
  // PIPELINE's own internal actor check (they share one actorRequest object)
  // — which means that test cannot tell the difference between "the
  // coordinator re-checks between groups" and "the pipeline rejected group 2
  // and that alone happened to also stop group 3". This test isolates the
  // coordinator's OWN check: the mock BYPASSES the pipeline entirely and
  // fabricates a durable success for every group regardless of actor state,
  // so the only thing that can prevent group 3 from being dispatched is the
  // coordinator's own actorStillValid() gate between groups.
  const { m, actorContext, coordinator } = load();
  asActor(actorContext, 'user-1');
  const selection = seedSelection(m, 'sess_1', keysOf(17));

  let groupsSeen = 0;
  const result = await coordinator.integrateMirrorExtractionSelection(selection, {
    stageGroup: async (input) => {
      groupsSeen += 1;
      if (groupsSeen === 2) actorContext.advanceActorEpoch('user-2');
      return {
        kind: 'ok',
        batchId: `batch_fake_${groupsSeen}`,
        outcomes: input.crops.map((c, i) => ({
          cropKey: c.cropKey,
          batchPosition: i,
          outcome: 'created',
          candidateId: `fake_candidate_${c.cropKey}`,
        })),
      };
    },
  });

  assert.equal(groupsSeen, 2, 'group 3 was dispatched despite the coordinator\'s own actor check');
  assert.equal(result.groups[2].status, 'not_started');
});

test('a fresh actor request per group cannot mask a stale operation', async () => {
  // Regression guard for the bug this test exists to prevent: checking
  // isActorRequestCurrent on a FRESHLY minted request always passes trivially.
  // Only comparing against an EXTERNALLY captured starting snapshot catches
  // this — see the actorRequest note on MIRROR-ACTOR-CHANGE-BEFORE-STAGING.
  const { m, actorContext, coordinator } = load();
  const capturedActorRequest = asActor(actorContext, 'user-1');
  const selection = seedSelection(m, 'sess_1', keysOf(9));
  actorContext.advanceActorEpoch('user-1'); // same id, new epoch — sign-out/sign-in
  const result = await coordinator.integrateMirrorExtractionSelection(selection, {
    actorRequest: capturedActorRequest,
  });
  assert.equal(result.outcome, 'rejected');
  assert.equal(result.rejectReason, 'mirror_integration_actor_stale');
});

// ── Partial success and retry ────────────────────────────────────────────────

test('MIRROR-PARTIAL-GROUP-SUCCESS-PRESERVED: one bad crop does not fail the others', async () => {
  const { m, actorContext, coordinator } = load({
    // This produces candidate_media_normalization_failed — verified against
    // the real registry (services/closetCandidateErrors.ts) to be
    // NON-retryable, recovery 'retake_photo'. See the two tests below for the
    // retryable/non-retryable classification itself; this test's job is only
    // to prove that ONE bad crop does not take the rest of the group down
    // with it.
    manipulatorFailsFor: (uri) => uri.includes('k1'),
  });
  asActor(actorContext, 'user-1');
  const selection = seedSelection(m, 'sess_1', keysOf(3));
  const result = await coordinator.integrateMirrorExtractionSelection(selection);
  assert.equal(result.outcome, 'partial');
  assert.deepEqual(result.successfulCropKeys.sort(), ['k0', 'k2']);
  assert.deepEqual(result.nonRetryableCropKeys, ['k1']);
});

test('MIRROR-FAILED-GROUP-REMAINS-RETRYABLE: a genuinely retryable per-crop error keeps its file', async () => {
  // candidate_persist_failed is the one staging-time error the real registry
  // marks retryable (recovery: 'retry') — a transient manifest-write fault,
  // not something about the photo itself. Reaching it through the real
  // pipeline would mean corrupting the in-memory filesystem's write-verify
  // sequence; asserting the coordinator's own classification and cleanup
  // logic against a crafted outcome is the more direct, more legible proof of
  // the SAME code path createClosetCandidate's outer catch-all would produce.
  const { m, actorContext, coordinator } = load();
  asActor(actorContext, 'user-1');
  const selection = seedSelection(m, 'sess_1', ['k0']);
  const result = await coordinator.integrateMirrorExtractionSelection(selection, {
    stageGroup: async (input) => ({
      kind: 'ok',
      batchId: 'batch_fake_retryable',
      outcomes: input.crops.map((c, i) => ({
        cropKey: c.cropKey,
        batchPosition: i,
        outcome: 'rejected',
        errorCode: 'candidate_persist_failed',
      })),
    }),
  });
  assert.deepEqual(result.retryableCropKeys, ['k0']);
  assert.deepEqual(result.retainedCropKeys, ['k0']);
  const info = await m.api.getInfoAsync(cropPath('sess_1', 'k0'));
  assert.equal(info.exists, true, 'a retryable crop was deleted');
});

test('MIRROR-DISCARDED-CROP-DELETED: a genuinely non-retryable per-crop error is discarded', async () => {
  const { m, actorContext, coordinator } = load({
    manipulatorFailsFor: (uri) => uri.includes('k0'),
  });
  asActor(actorContext, 'user-1');
  const selection = seedSelection(m, 'sess_1', ['k0']);
  const result = await coordinator.integrateMirrorExtractionSelection(selection);
  assert.deepEqual(result.nonRetryableCropKeys, ['k0']);
  assert.deepEqual(result.cleanedCropKeys, ['k0']);
  const info = await m.api.getInfoAsync(cropPath('sess_1', 'k0'));
  assert.equal(info.exists, false, 'a non-retryable crop was retained instead of discarded');
});

test('MIRROR-RETRY-DOES-NOT-RESTAGE-SUCCESSFUL-GROUP and MIRROR-DUPLICATE-HANDOFF-DOES-NOT-DUPLICATE-CANDIDATES', async () => {
  const { m, actorContext, store, coordinator, staging } = load();
  const actorRequest = asActor(actorContext, 'user-1');
  const selection = seedSelection(m, 'sess_1', keysOf(3));

  const first = await coordinator.integrateMirrorExtractionSelection(selection);
  assert.equal(first.outcome, 'created');

  // Re-submitting the SAME selection (a retry with nothing new) must not
  // create second candidates: deterministic per-crop lineage
  // (mirror_extract:sessionId:cropKey) makes createClosetCandidate's own
  // active-candidate dedup catch it.
  const retryCalls = [];
  const second = await coordinator.integrateMirrorExtractionSelection(selection, {
    stageGroup: async (input) => {
      retryCalls.push(input.crops.map((c) => c.cropKey));
      return staging.stageMirrorSelfieGarmentCrops(input);
    },
  });
  // The crop files no longer exist (already cleaned after the first run), so
  // the retry fails handoff validation — which is itself the correct outcome:
  // nothing NEW is staged from files that are already gone.
  assert.equal(second.outcome, 'rejected');
  assert.equal(retryCalls.length, 0);

  const listed = await store.listClosetCandidates(actorRequest);
  assert.equal(listed.candidates.length, 3, 'a duplicate candidate set was created');
});

test('a retried crop derives the SAME lineage every time, which is what makes retry idempotent', async () => {
  const { staging } = load();
  // Same (sessionId, cropKey) -> same deterministic lineage, independent of
  // process, call count or in-memory state. This is the entire mechanism that
  // lets a real device retry the same crop without createClosetCandidate ever
  // producing a second candidate for it — its own active-candidate dedup check
  // matches on this id.
  const lineage1 = await staging.deriveMirrorSourceLineageId('sess_1', 'k1');
  const lineage2 = await staging.deriveMirrorSourceLineageId('sess_1', 'k1');
  const lineageDifferentKey = await staging.deriveMirrorSourceLineageId('sess_1', 'k2');
  assert.equal(lineage1, lineage2, 'retrying the same crop must derive the same lineage');
  assert.notEqual(lineage1, lineageDifferentKey, 'different crops must derive different lineage');
});

test('a retry attempt on a crop whose file still exists reaches the pipeline\'s own dedup, not a coordinator-level duplicate', async () => {
  const { m, actorContext, store, coordinator } = load();
  const actorRequest = asActor(actorContext, 'user-1');
  const selection = seedSelection(m, 'sess_1', ['k0']);

  // First attempt: a genuinely retryable staging-time fault (see
  // MIRROR-FAILED-GROUP-REMAINS-RETRYABLE) — the crop's file survives.
  const first = await coordinator.integrateMirrorExtractionSelection(selection, {
    stageGroup: async (input) => ({
      kind: 'ok',
      batchId: 'batch_fake_retryable',
      outcomes: input.crops.map((c, i) => ({
        cropKey: c.cropKey,
        batchPosition: i,
        outcome: 'rejected',
        errorCode: 'candidate_persist_failed',
      })),
    }),
  });
  assert.deepEqual(first.retryableCropKeys, ['k0']);
  const info = await m.api.getInfoAsync(cropPath('sess_1', 'k0'));
  assert.equal(info.exists, true, 'a retryable crop was deleted before the retry could use it');

  // Second attempt on the SAME still-present crop file, now against the REAL
  // pipeline. Whether it succeeds or fails again, the point is that a
  // repeated ATTEMPT at the same crop never produces a second candidate.
  const second = await coordinator.integrateMirrorExtractionSelection(selection);
  assert.equal(second.successfulCropKeys.length + second.retryableCropKeys.length, 1);

  const listed = await store.listClosetCandidates(actorRequest);
  assert.equal(
    new Set(listed.candidates.map((c) => c.candidateId)).size,
    listed.candidates.length,
    'a retry attempt produced a duplicate candidate id',
  );
});

// ── Media lifecycle ──────────────────────────────────────────────────────────

test('MIRROR-CROP-NOT-DELETED-BEFORE-CANDIDATE-MEDIA-DURABLE: cleanup never runs before the staging call resolves', async () => {
  // stageMirrorSelfieGarmentCrops is fully awaited and every one of its
  // per-crop outcomes is TERMINAL by the time it returns (createClosetCandidate
  // is itself sequentially awaited inside it) — so there is no "durability
  // still pending" state to observe AFTER the call. What IS observable, and
  // what this test proves, is the timing invariant that makes that safe in the
  // first place: the coordinator does not delete anything while the call is
  // still in flight, whatever the eventual outcome turns out to be.
  const { m, actorContext, coordinator, staging } = load();
  asActor(actorContext, 'user-1');
  const selection = seedSelection(m, 'sess_1', ['k0']);

  let releaseStaging;
  const held = new Promise((resolve) => {
    releaseStaging = resolve;
  });
  const resultPromise = coordinator.integrateMirrorExtractionSelection(selection, {
    stageGroup: async (input) => {
      await held;
      return staging.stageMirrorSelfieGarmentCrops(input);
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 10));
  const whilePending = await m.api.getInfoAsync(cropPath('sess_1', 'k0'));
  assert.equal(whilePending.exists, true, 'the crop was deleted before staging even resolved');

  releaseStaging();
  const result = await resultPromise;
  assert.deepEqual(result.successfulCropKeys, ['k0']);
  const afterward = await m.api.getInfoAsync(cropPath('sess_1', 'k0'));
  assert.equal(afterward.exists, false, 'the crop was never cleaned up after durable staging resolved');
});

test('MIRROR-SUCCESSFUL-CROP-DELETED-AFTER-DURABLE-STAGING', async () => {
  const { m, actorContext, store, coordinator } = load();
  const actorRequest = asActor(actorContext, 'user-1');
  const selection = seedSelection(m, 'sess_1', ['k0']);
  const result = await coordinator.integrateMirrorExtractionSelection(selection);
  assert.deepEqual(result.cleanedCropKeys, ['k0']);
  const info = await m.api.getInfoAsync(cropPath('sess_1', 'k0'));
  assert.equal(info.exists, false);
  // And the candidate's own media is real and durable, independent of the
  // Mirror crop file's fate.
  const listed = await store.listClosetCandidates(actorRequest);
  assert.ok(listed.candidates[0].candidateImageUri);
  const media = await m.api.getInfoAsync(listed.candidates[0].candidateImageUri);
  assert.equal(media.exists, true);
});

// Retryable-retained and non-retryable-discarded are each proved once,
// directly, by MIRROR-FAILED-GROUP-REMAINS-RETRYABLE and
// MIRROR-DISCARDED-CROP-DELETED above. A crop that hits the actor-stale path
// mid-group is a THIRD case — abandoned, not merely failed — and is cleaned;
// see MIRROR-ACTOR-CHANGE-BETWEEN-GROUPS-STOPS-FUTURE-GROUPS.

// ── Unresolved-candidate cap ─────────────────────────────────────────────────

test('MIRROR-STAGING-RESPECTS-UNRESOLVED-CANDIDATE-CAP: later groups stop, earlier ones survive', async () => {
  const { m, actorContext, store, coordinator, types } = load();
  const actorRequest = asActor(actorContext, 'user-1');

  // Fill the cap to exactly 2 below the limit using the real store's own API,
  // matching how the cap is actually enforced (CLOSET_CANDIDATE_MAX_UNRESOLVED = 40).
  const { CLOSET_CANDIDATE_MAX_UNRESOLVED } = types;
  for (let i = 0; i < CLOSET_CANDIDATE_MAX_UNRESOLVED - 2; i += 1) {
    const uri = `/seed/${i}.jpg`;
    m.files.set(uri, Buffer.from(`seed${i}`).toString('base64'));
    // eslint-disable-next-line no-await-in-loop
    await store.createClosetCandidate(actorRequest, { sourceUri: uri, sourceType: 'gallery' });
  }

  const selection = seedSelection(m, 'sess_1', keysOf(9));
  const result = await coordinator.integrateMirrorExtractionSelection(selection);

  assert.equal(result.outcome, 'capacity_blocked');
  // The first group could only accept 2 of its 8 before the cap.
  assert.ok(result.successfulCropKeys.length <= 2);
  assert.equal(result.groups[1].status, 'not_started', 'the second group was dispatched despite the cap');

  // Capacity-blocked crops are RETAINED, never discarded — nothing is wrong
  // with the crop itself, and it can succeed once the user resolves existing
  // candidates and retries. This covers both the crop that was individually
  // rejected for capacity inside the triggering group, and every crop in
  // groups that were never dispatched at all. (The 2 crops the cap DID
  // accept are legitimately cleaned — durable candidate media exists for
  // them — which is why the check below excludes successfulCropKeys.)
  assert.equal(result.nonRetryableCropKeys.length, 0, 'a capacity-blocked crop was marked non-retryable');
  assert.equal(
    result.cleanedCropKeys.length,
    result.successfulCropKeys.length,
    'something other than a successful crop was cleaned',
  );
  for (const crop of selection.crops) {
    if (result.successfulCropKeys.includes(crop.cropKey)) continue;
    // eslint-disable-next-line no-await-in-loop
    const info = await m.api.getInfoAsync(crop.cropUri);
    assert.equal(info.exists, true, `${crop.cropKey} was deleted despite being capacity-blocked, not failed`);
  }
});

// ── Classification trigger ────────────────────────────────────────────────────

test('MIRROR-CANDIDATE-CLASSIFIED-EXACTLY-ONCE and MIRROR-CLASSIFICATION-NOT-DUPLICATED', async () => {
  const { m, actorContext, coordinator, requeueCalls } = load();
  asActor(actorContext, 'user-1');
  const selection = seedSelection(m, 'sess_1', keysOf(9)); // two groups, both create candidates
  await coordinator.integrateMirrorExtractionSelection(selection);
  assert.equal(requeueCalls.length, 1, `classification was triggered ${requeueCalls.length} times`);
});

test('MIRROR-CLASSIFICATION-NOT-SKIPPED: at least one trigger when candidates are created', async () => {
  const { m, actorContext, coordinator, requeueCalls } = load();
  asActor(actorContext, 'user-1');
  await coordinator.integrateMirrorExtractionSelection(seedSelection(m, 'sess_1', ['k0']));
  assert.equal(requeueCalls.length, 1);
});

test('classification is never triggered when nothing was created', async () => {
  const { m, actorContext, coordinator, requeueCalls } = load({
    manipulatorFailsFor: () => true,
  });
  asActor(actorContext, 'user-1');
  await coordinator.integrateMirrorExtractionSelection(seedSelection(m, 'sess_1', ['k0']));
  assert.equal(requeueCalls.length, 0);
});

test('classification is never triggered under an actor that went stale AFTER the last group succeeded', async () => {
  // A candidate was durably created (anyCreated=true), but the actor changed
  // in the gap between the last group settling and the trigger running. The
  // new actor must not have classification kicked off "on their behalf" for
  // work that belongs to whoever was signed in when it was created.
  const { m, actorContext, coordinator, requeueCalls, staging } = load();
  asActor(actorContext, 'user-1');
  const selection = seedSelection(m, 'sess_1', ['k0']);
  const result = await coordinator.integrateMirrorExtractionSelection(selection, {
    stageGroup: async (input) => {
      const staged = await staging.stageMirrorSelfieGarmentCrops(input);
      actorContext.advanceActorEpoch('user-2'); // AFTER the group succeeds
      return staged;
    },
  });
  assert.equal(result.groups[0].status, 'succeeded');
  assert.equal(requeueCalls.length, 0, 'classification ran for a candidate under a now-stale actor');
});

test('the production hook uses the REAL classification entry point, not a stub', () => {
  const source = fs.readFileSync(path.join(ROOT, 'hooks/useClosetCandidates.js'), 'utf8');
  const call = source.match(/integrateMirrorExtractionSelection\(selection,\s*\{([\s\S]*?)\}\)/);
  assert.ok(call, 'stageMirrorSelection does not call the coordinator');
  assert.ok(
    !call[1].includes('requeueClassification'),
    'the hook overrides requeueClassification instead of using the coordinator default',
  );
});

test('the hook captures its actor snapshot BEFORE anything else, and passes it to the coordinator', () => {
  const source = fs.readFileSync(path.join(ROOT, 'hooks/useClosetCandidates.js'), 'utf8');
  const method = source.match(
    /const stageMirrorSelection = useCallback\(\s*\n\s*async \(selection\) => \{([\s\S]*?)\n {4}\},\s*\n {4}\[/,
  );
  assert.ok(method, 'stageMirrorSelection method body not found');
  const body = method[1];

  // The already-running guard may legitimately return first (it captures
  // nothing and touches no state). The very next statement must be the actor
  // capture — before the generation counter, before setMirrorIntegration,
  // before anything the coordinator's "before staging" check depends on
  // being the true operation start.
  const afterGuard = body.split('mirrorIntegrationLiveRef.current) {')[1] ?? body;
  const captureIndex = afterGuard.indexOf('const actorRequest = createActorRequest();');
  const generationIndex = afterGuard.indexOf('++mirrorIntegrationGenerationRef.current');
  assert.ok(captureIndex >= 0, 'actorRequest is not captured in stageMirrorSelection');
  assert.ok(
    captureIndex < generationIndex,
    'actorRequest must be captured before the generation counter advances',
  );

  assert.ok(
    /integrateMirrorExtractionSelection\(selection,\s*\{\s*\n\s*actorRequest,/.test(source),
    'the captured actorRequest is not passed to the coordinator',
  );
});

// ── Domain separation ────────────────────────────────────────────────────────

test('MIRROR-INTEGRATION-CREATES-NO-RECENT-SCAN, NO-COMMERCE, NO-PURCHASE-OPTION, NO-DIRECT-CLOSET-ITEM', () => {
  const source = fs.readFileSync(
    path.join(ROOT, 'services/mirror/mirrorCandidateIntegration.ts'),
    'utf8',
  );
  const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
  for (const forbidden of [
    'services/library',
    'savedScanMedia',
    'closetLibrary', // the COMMITTED store — promotion's job, never staging's
    'ProductShelf',
    'commerce',
  ]) {
    assert.ok(
      !imports.some((spec) => spec.toLowerCase().includes(forbidden.toLowerCase())),
      `coordinator imports ${forbidden}`,
    );
  }
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  for (const forbidden of ['createClosetItem', 'purchaseOptions', 'promoteSelectedClosetCandidates']) {
    assert.ok(!code.includes(forbidden), `coordinator source calls ${forbidden}`);
  }
});

test('MIRROR-INTEGRATION-DOES-NOT-IMPORT-SCANNER-PIPELINE', () => {
  const source = fs.readFileSync(
    path.join(ROOT, 'services/mirror/mirrorCandidateIntegration.ts'),
    'utf8',
  );
  const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
  for (const forbidden of ['scannerIdentificationV2', 'scannerEvidenceGateway', 'scanIdentification']) {
    assert.ok(
      !imports.some((spec) => spec.toLowerCase().includes(forbidden.toLowerCase())),
      `coordinator imports ${forbidden}`,
    );
  }
});

test('an automatically-created candidate is never auto-promoted', async () => {
  const { m, actorContext, store, coordinator } = load();
  const actorRequest = asActor(actorContext, 'user-1');
  await coordinator.integrateMirrorExtractionSelection(seedSelection(m, 'sess_1', ['k0']));
  const listed = await store.listClosetCandidates(actorRequest);
  assert.equal(listed.candidates[0].status, 'queued');
  assert.notEqual(listed.candidates[0].status, 'saved');
  assert.equal(listed.candidates[0].promotedClosetItemId ?? null, null);
});

// ── Review-path compatibility ────────────────────────────────────────────────

test('MIRROR-CANDIDATE-RENDERS-IN-BATCH-REVIEW: the existing projection groups it like any other candidate', async () => {
  const { m, actorContext, store, coordinator, batchReview } = load();
  const actorRequest = asActor(actorContext, 'user-1');
  const result = await coordinator.integrateMirrorExtractionSelection(seedSelection(m, 'sess_1', keysOf(2)));
  const listed = await store.listClosetCandidates(actorRequest);
  const projection = batchReview.getClosetBatchReviewProjection({
    actorId: actorRequest.actorId,
    actorEpoch: actorRequest.epoch,
    candidates: listed.candidates,
  });
  assert.ok(projection.groups.length >= 1);
  const group = projection.groups.find((g) => g.batchId === result.candidateBatchIds[0]);
  assert.ok(group, 'the Mirror-staged batch does not appear in the review projection');
  assert.equal(group.totalCount, 2);
});

test('MIRROR-DOES-NOT-MOUNT-A-SECOND-CANDIDATE-REVIEW', () => {
  const raw = fs.readFileSync(
    path.join(ROOT, 'components/closet/MirrorSelfieExtractionModal.tsx'),
    'utf8',
  );
  // Comments stripped first: the modal's own header prose NAMES
  // ClosetBatchReviewPanel to document that it is NOT mounted there. Matching
  // the raw text would fail on that documentation rather than on code.
  const modal = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  for (const forbidden of ['ClosetBatchReviewPanel', 'ClosetCandidateManualClassifyModal', 'classifyClosetCandidate']) {
    assert.ok(!modal.includes(forbidden), `the extraction modal reaches ${forbidden}`);
  }
});

// ── Privacy ──────────────────────────────────────────────────────────────────

test('MIRROR-INTEGRATION-TELEMETRY-CONTAINS-NO-URI, NO-CROP-KEY, NO-SESSION-ID', async () => {
  const { m, actorContext, coordinator, telemetryEvents } = load();
  asActor(actorContext, 'user-1');
  const selection = seedSelection(m, 'sess_1', keysOf(9));
  await coordinator.integrateMirrorExtractionSelection(selection);

  assert.ok(telemetryEvents.length > 0);
  const serialized = JSON.stringify(telemetryEvents);
  for (const forbidden of ['file://', 'sess_1', 'k0', 'k1', '.jpg', 'kscan_mirror_sessions']) {
    assert.ok(!serialized.includes(forbidden), `telemetry leaked ${forbidden}`);
  }
  for (const event of telemetryEvents) {
    assert.ok(event.event.startsWith('mirror_candidate_staging_') || event.event === 'mirror_selfie_crops_staged'
      || event.event.startsWith('closet_candidate_'), `unexpected event ${event.event}`);
  }
});

test('MIRROR-INTEGRATION-ERROR-CONTAINS-NO-FILE-PATH: rejection reasons are bounded codes', async () => {
  const { m, coordinator } = load();
  const selection = seedSelection(m, 'sess_1', ['k0']);
  selection.crops.push({ cropUri: cropPath('sess_1', 'ghost'), cropKey: 'ghost' });
  const result = await coordinator.integrateMirrorExtractionSelection(selection);
  assert.equal(result.outcome, 'rejected');
  assert.match(result.rejectReason, /^[a-z_]+$/);
  assert.ok(!result.rejectReason.includes('file://'));
  assert.ok(!result.rejectReason.includes('/'));
});

// ── Environment containment ──────────────────────────────────────────────────

test('no EAS profile or app.json key was introduced by Step 4', () => {
  const eas = fs.readFileSync(path.join(ROOT, 'eas.json'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8');
  for (const forbidden of ['MIRROR_CANDIDATE', 'MIRROR_INTEGRATION', 'mirror_candidate_integration']) {
    assert.ok(!eas.includes(forbidden), `eas.json references ${forbidden}`);
    assert.ok(!app.includes(forbidden), `app.json references ${forbidden}`);
  }
});

// ── Build 2.5 Step 5 hostile-audit regressions ───────────────────────────────
//
// Each test below was written because a specific hostile mutation SURVIVED the
// Step 4 suite (scripts/mirror-step5-audit-mutation-check.js). They are not
// extra coverage for its own sake: every one of them fails when its invariant
// is inverted, and the surviving mutation is named in the comment above it.

/**
 * F-1. `already_in_closet` is the candidate pipeline's documented idempotent
 * SUCCESS, not a failure. The Step 4 coordinator classified it as a
 * non-retryable failure, which made a fully correct operation report `partial`
 * and made the Closet screen say "We couldn't add those garments. Please try
 * again." for garments that were already in the user's Closet.
 */
test('MIRROR-ALREADY-IN-CLOSET-IS-NOT-A-STAGING-FAILURE', async () => {
  const { m, actorContext, coordinator } = load();
  asActor(actorContext, 'user-1');
  const selection = seedSelection(m, 'sess_aic', keysOf(2));

  const result = await coordinator.integrateMirrorExtractionSelection(selection, {
    stageGroup: async ({ crops }) => ({
      kind: 'ok',
      batchId: 'batch_aic',
      outcomes: crops.map((crop, index) => ({
        cropKey: crop.cropKey,
        batchPosition: index,
        outcome: 'already_in_closet',
        errorCode: 'already_in_closet',
      })),
    }),
  });

  assert.deepEqual(result.nonRetryableCropKeys, [], 'already_in_closet was counted as a failure');
  assert.deepEqual(result.retryableCropKeys, [], 'already_in_closet was offered for retry');
  assert.deepEqual(result.successfulCropKeys.sort(), ['k0', 'k1']);
  assert.equal(result.outcome, 'created', 'a fully idempotent operation reported as partial');
  assert.equal(result.groups[0].status, 'succeeded');
  // Cleanup behaviour is deliberately UNCHANGED: the crop is redundant once its
  // committed Closet twin exists, so it is still deleted, never retained.
  assert.deepEqual(result.cleanedCropKeys.sort(), ['k0', 'k1']);
  assert.deepEqual(result.retainedCropKeys, []);
});

/**
 * F-1b. `failed_non_retryable` was declared in MirrorStagingGroupStatus and
 * never assigned: a group whose every crop failed permanently was reported to
 * callers as `failed_retryable`, inviting a retry that can never succeed.
 */
test('MIRROR-GROUP-OF-ONLY-PERMANENT-FAILURES-IS-NOT-REPORTED-RETRYABLE', async () => {
  const { m, actorContext, coordinator } = load({
    manipulatorFailsFor: () => true,
  });
  asActor(actorContext, 'user-1');
  const selection = seedSelection(m, 'sess_perm', keysOf(2));

  const result = await coordinator.integrateMirrorExtractionSelection(selection);

  assert.deepEqual(result.successfulCropKeys, []);
  assert.deepEqual(result.nonRetryableCropKeys.sort(), ['k0', 'k1']);
  assert.equal(result.groups[0].status, 'failed_non_retryable');
});

/**
 * SURVIVING MUTATION MH (§29.28). Inverting `reconcileDurableMirrorCrops`'s
 * central predicate — so it deletes the crops that have NO durable twin and
 * keeps the ones that do — left the whole Step 4 suite green. That inversion is
 * unrecoverable local data loss, and nothing tested it.
 */
test('MIRROR-RECONCILE-DELETES-ONLY-THE-CROP-WHOSE-DURABLE-TWIN-EXISTS', async () => {
  const { m, actorContext, coordinator } = load();
  asActor(actorContext, 'user-1');
  const selection = seedSelection(m, 'sess_rec', ['durable', 'orphan']);

  const deleted = [];
  const outcome = await coordinator.reconcileDurableMirrorCrops(selection, {
    listDurableLineageIds: async () => new Set(['lineage:durable']),
    deriveLineageId: async (_sessionId, cropKey) => `lineage:${cropKey}`,
    deleteCropFile: async (uri) => {
      deleted.push(uri);
      m.files.delete(uri);
      return true;
    },
  });

  assert.deepEqual(outcome.reconciledCropKeys, ['durable']);
  assert.deepEqual(deleted, [cropPath('sess_rec', 'durable')]);
  // The crop with no durable twin is the ONLY copy of that garment. Deleting it
  // would destroy work the user can never get back without re-photographing.
  const orphan = await m.api.getInfoAsync(cropPath('sess_rec', 'orphan'));
  assert.equal(orphan.exists, true, 'a crop with no durable candidate was destroyed');
});

/**
 * SURVIVING MUTATION ME (§29.13). Removing the hook's re-entrancy guard — so a
 * duplicate `onExtracted` starts a SECOND coordinator over the same crop list —
 * left the suite green.
 */
test('MIRROR-DUPLICATE-HANDOFF-CANNOT-START-A-SECOND-COORDINATOR', () => {
  const source = fs.readFileSync(path.join(ROOT, 'hooks/useClosetCandidates.js'), 'utf8');
  assert.match(
    source,
    /if \(mirrorIntegrationLiveRef\.current\) \{[\s\S]{0,200}?mirror_integration_already_running/,
    'stageMirrorSelection no longer refuses a second concurrent handoff',
  );
  // The guard has to be armed for the whole operation, not just its start.
  assert.match(
    source,
    /mirrorIntegrationLiveRef\.current = true;/,
    'the running flag is never set, so the guard can never fire',
  );
  assert.match(
    source,
    /finally \{\s*\n\s*mirrorIntegrationLiveRef\.current = false;/,
    'the running flag is not cleared in a finally, so one failure wedges the feature shut',
  );
});

/**
 * SURVIVING MUTATION MF (§29.26). Making the successful handoff ALSO cancel the
 * operation it just started — the classic "unmount looks like cancellation"
 * defect — left the suite green.
 */
test('MIRROR-SUCCESSFUL-HANDOFF-DOES-NOT-CANCEL-THE-COORDINATOR', () => {
  const library = fs.readFileSync(path.join(ROOT, 'app/library.tsx'), 'utf8');
  const mount = library.match(/<MirrorSelfieExtractionModal[\s\S]*?\/>/);
  assert.ok(mount, 'the Mirror sheet is no longer mounted in the Closet screen');
  assert.ok(
    mount[0].includes('stageMirrorSelection(selection)'),
    'the handoff no longer routes through the coordinator',
  );
  assert.ok(
    !mount[0].includes('cancelMirrorIntegration'),
    'closing the extraction sheet cancels the staging operation it just started',
  );
});

/**
 * SURVIVING MUTATION MG (§29.27). Removing the unmount cleanup — so abandoning
 * the Closet screen leaves the coordinator dispatching further groups — left the
 * suite green.
 */
test('MIRROR-OWNER-ABANDONMENT-CANCELS-FUTURE-GROUPS', () => {
  const source = fs.readFileSync(path.join(ROOT, 'hooks/useClosetCandidates.js'), 'utf8');
  const effect = source.match(/AppState\.addEventListener\('change'[\s\S]*?\n  \}, \[\]\);/);
  assert.ok(effect, 'the lifecycle effect is gone');
  const cleanup = effect[0].match(/return \(\) => \{[\s\S]*?\};/);
  assert.ok(cleanup, 'the lifecycle effect no longer returns a cleanup');
  assert.ok(
    cleanup[0].includes('mirrorIntegrationLiveRef.current = false'),
    'unmounting the owner no longer stops further Mirror groups',
  );
  // Backgrounding must stop future groups for the same reason.
  assert.match(
    effect[0],
    /nextState !== 'active'\) \{[\s\S]{0,400}?mirrorIntegrationLiveRef\.current = false/,
    'backgrounding no longer stops further Mirror groups',
  );
});
