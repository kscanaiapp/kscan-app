// Closet candidate ORCHESTRATION suite — offline handling, abort, actor-epoch
// revalidation, bounded retry, backoff, concurrency and crash-loop prevention.
//
// The orchestrator, the store, the media layer, the adapter and the real
// actorContext all run for real against an in-memory filesystem. Only the two
// genuinely external things are doubled: the image compressor (native) and the
// `scan-identify` transport (network).

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

function memfs() {
  const files = new Map();
  return {
    files,
    api: {
      documentDirectory: '/doc/',
      EncodingType: { UTF8: 'utf8', Base64: 'base64' },
      async makeDirectoryAsync() {},
      async getInfoAsync(p) {
        if (!files.has(p)) return { exists: false };
        return { exists: true, size: Buffer.from(files.get(p), 'utf8').length };
      },
      async readAsStringAsync(p) {
        if (!files.has(p)) throw new Error('ENOENT');
        return files.get(p);
      },
      async writeAsStringAsync(p, c) {
        files.set(p, c);
      },
      async moveAsync({ from, to }) {
        if (!files.has(from)) throw new Error('ENOENT');
        files.set(to, files.get(from));
        files.delete(from);
      },
      async deleteAsync(p) {
        files.delete(p);
      },
      async getFreeDiskStorageAsync() {
        return 10 * 1024 * 1024 * 1024;
      },
    },
  };
}

function cryptoShim() {
  let seq = 0;
  return {
    getRandomBytes: (n) => {
      seq += 1;
      return Uint8Array.from({ length: n }, (_, i) => (seq * 31 + i * 7) % 256);
    },
    randomUUID: () => {
      seq += 1;
      return `00000000-0000-4000-8000-${seq.toString(16).padStart(12, '0')}`;
    },
    CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
    CryptoEncoding: { HEX: 'hex', BASE64: 'base64' },
    async digestStringAsync(_a, data) {
      let h = 0x811c9dc5;
      for (let i = 0; i < data.length; i += 1) h = ((h ^ data.charCodeAt(i)) * 16777619) >>> 0;
      return h.toString(16).padStart(8, '0').repeat(8);
    },
  };
}

function okResult(overrides = {}) {
  return {
    contractVersion: 'fashion-identification-v2',
    requestId: 'req',
    status: 'completed',
    resolutionLevel: 'brand_and_subtype',
    item: {
      category: 'Outerwear',
      subtype: 'Trench coat',
      brand: { value: 'Burberry', confidence: 0.7, provenance: 'visual', evidence: [] },
      colors: { primary: 'Beige', secondary: [] },
      material: [],
      silhouette: [],
      pattern: [],
      attributes: { pockets: [], visible: [], distinctive: [] },
    },
    confidence: { category: 0.9, subtype: 0.8, brand: 0.7, modelFamily: null, exactProduct: null },
    exactProduct: null,
    evidence: [],
    conflicts: [],
    compatibility: { legacyProjectionAvailable: true, globalConfidence: 0.85 },
    ...overrides,
  };
}

function load(platformOS = 'android') {
  const m = memfs();
  const crypto = cryptoShim();
  const actorContext = runModule('services/actorContext.js', () => ({}));

  let cacheSeq = 0;
  const imageManipulator = {
    SaveFormat: { JPEG: 'jpeg' },
    manipulateAsync: async (uri, ops) => {
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
    if (spec === './savedScansCloud') {
      return { saveScanToCloud: async () => ({ ok: true }), softDeleteCloudSavedScan: async () => ({ ok: true }) };
    }
    if (spec === './identificationSnapshot') {
      return { hydrateScanHistory: () => ({ records: [], corruptedCount: 0 }) };
    }
    if (spec === './purchaseOptions' || spec === './dressingRoomCommerce') {
      return { isPurchaseOptionsSnapshot: () => false, normalizePurchaseOptions: () => [] };
    }
    if (spec === './actorContext') return actorContext;
    return {};
  });

  const closetLibrary = runModule('services/closetLibrary.js', (spec) => {
    if (spec === 'expo-file-system/legacy') return m.api;
    if (spec === 'expo-image-manipulator') return imageManipulator;
    if (spec === 'react-native') return { Platform: { OS: platformOS } };
    if (spec === './actorContext') return actorContext;
    if (spec === './library') return library;
    return {};
  });

  const contractTypes = runModule('types/fashionIdentificationV2.ts', () => ({}));
  const types = runModule('types/closetCandidate.ts', () => ({}));
  const stateMachine = runModule('services/closetCandidateStateMachine.ts', (s) =>
    s === '../types/closetCandidate' ? types : {},
  );
  const candidateErrors = runModule('services/closetCandidateErrors.ts', (s) =>
    s === '../types/closetCandidate' ? types : {},
  );
  const schema = runModule('services/closetCandidateSchema.js', (s) => {
    if (s === 'expo-crypto') return crypto;
    if (s === '../types/closetCandidate') return types;
    if (s === './closetCandidateErrors') return candidateErrors;
    if (s === './closetCandidateStateMachine') return stateMachine;
    return {};
  });
  const telemetry = runModule('services/closetTelemetry.ts', () => ({}));
  const media = runModule('services/closetCandidateMedia.js', (s) => {
    if (s === 'expo-file-system/legacy') return m.api;
    if (s === 'expo-image-manipulator') return imageManipulator;
    if (s === 'expo-crypto') return crypto;
    if (s === './library') return library;
    if (s === '../types/closetCandidate') return types;
    return {};
  });
  const store = runModule('services/closetCandidateLibrary.js', (s) => {
    if (s === 'react-native') return { Platform: { OS: platformOS } };
    if (s === 'expo-file-system/legacy') return m.api;
    if (s === './actorContext') return actorContext;
    if (s === './closetLibrary') return closetLibrary;
    if (s === '../types/closetCandidate') return types;
    if (s === './closetCandidateSchema') return schema;
    if (s === './closetCandidateStateMachine') return stateMachine;
    if (s === './closetCandidateMedia') return media;
    if (s === './closetTelemetry') return telemetry;
    return {};
  });

  const gateway = runModule('services/fashionEvidenceGateway.ts', (s) =>
    s === 'expo-crypto' ? crypto : {},
  );
  const core = runModule('services/fashionIdentificationV2Core.ts', (s) => {
    if (s === '../types/fashionIdentificationV2') return contractTypes;
    if (s === './fashionEvidenceGateway') return gateway;
    return {};
  });
  const adapter = runModule('services/closetIdentificationV2.ts', (s) => {
    if (s === '../types/fashionIdentificationV2') return contractTypes;
    if (s === '../types/closetCandidate') return types;
    if (s === './fashionEvidenceGateway') return gateway;
    if (s === './fashionIdentificationV2Core') return core;
    if (s === '../constants/featureFlags') {
      return { resolveClosetCandidateStagingEnabled: () => true };
    }
    return {};
  });
  const connectivity = runModule('services/closetConnectivity.js', () => ({}));

  /** Transport double. Records every request body so governance can inspect it. */
  const transport = {
    calls: [],
    /** (request, signal) => response | throws */
    handler: async () => ({ status: 'completed', identificationV2: okResult() }),
    async identifyScanImage(image, options = {}) {
      transport.calls.push({ image, options });
      return transport.handler(options, options.signal);
    },
  };

  const classification = runModule('services/closetCandidateClassification.js', (s) => {
    if (s === 'react-native') return { Platform: { OS: platformOS } };
    if (s === './actorContext') return actorContext;
    if (s === './imageUtils') {
      return { compressForUpload: async (uri) => `data:image/jpeg;base64,${m.files.get(uri) ?? 'QUJDRA=='}` };
    }
    if (s === './scanIdentification') return { identifyScanImage: transport.identifyScanImage };
    if (s === './fashionEvidenceGateway') return gateway;
    if (s === './closetIdentificationV2') return adapter;
    if (s === './closetCandidateLibrary') return store;
    if (s === '../types/closetCandidate') return types;
    if (s === './closetCandidateErrors') return candidateErrors;
    if (s === './closetConnectivity') return connectivity;
    if (s === './closetTelemetry') return telemetry;
    return {};
  });

  return { m, actorContext, store, classification, connectivity, transport, types, schema };
}

function asActor(actorContext, actorId) {
  actorContext.advanceActorEpoch(actorId);
  return actorContext.createActorRequest();
}

function seedSource(m, uri) {
  m.files.set(uri, Buffer.from(`original:${uri}`).toString('base64'));
  return uri;
}

async function stage(env, req, uri) {
  const result = await env.store.createClosetCandidate(req, {
    sourceUri: uri,
    sourceType: 'gallery',
    ownerId: req.actorId,
  });
  assert.equal(result.kind, 'created', JSON.stringify(result));
  return result.candidate;
}

async function reload(env, req, id) {
  const found = await env.store.getClosetCandidate(req, id);
  return found.ok ? found.candidate : null;
}

// ── Happy path ───────────────────────────────────────────────────────────────

test('a successful classification reaches ready_for_review with the projected metadata', async () => {
  const env = load();
  env.connectivity.resetClosetConnectivityProvider();
  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');
  const candidate = await stage(env, req, '/picker/a.jpg');

  const outcome = await env.classification.classifyClosetCandidate(req, candidate.candidateId);
  assert.equal(outcome.kind, 'resolved');
  assert.equal(outcome.status, 'ready_for_review');

  const after = await reload(env, req, candidate.candidateId);
  assert.equal(after.status, 'ready_for_review');
  assert.equal(after.category, 'Outerwear');
  assert.equal(after.subtype, 'Trench coat');
  assert.equal(after.brand, 'Burberry');
  assert.equal(after.primaryColor, 'Beige');
  assert.equal(after.classificationVersion, 'fashion-identification-v2');
  assert.equal(after.errorCode, null);
  assert.equal(after.attemptCount, 1);
});

test('the request body always carries the Closet V2 envelope and never a legacy body', async () => {
  const env = load();
  env.connectivity.resetClosetConnectivityProvider();
  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');
  const candidate = await stage(env, req, '/picker/a.jpg');
  await env.classification.classifyClosetCandidate(req, candidate.candidateId);

  assert.equal(env.transport.calls.length, 1);
  const { options } = env.transport.calls[0];
  assert.ok(options.contractRequestV2, 'no V2 envelope was sent');
  assert.equal(options.contractRequestV2.intent, 'identify_for_closet');
  assert.equal(options.contractRequestV2.mode, 'detect_items');
  assert.equal(options.contractRequestV2.source.entryPath, 'closet_gallery');
  // The legacy correlation fields belong to the Scanner selected-item flow and
  // must not appear on a Closet request.
  assert.equal(options.scanSessionId, undefined);
  assert.equal(options.imageDigestPrefix, undefined);
  assert.equal(options.multiItemDetection, undefined);
  assert.equal(options.selectedCandidate, undefined);
  assert.ok(options.signal, 'an AbortSignal must always be supplied');
});

test('a taxonomy-less result becomes needs_manual_classification, and manual entry completes it', async () => {
  const env = load();
  env.connectivity.resetClosetConnectivityProvider();
  env.transport.handler = async () => ({
    status: 'completed',
    identificationV2: okResult({
      item: {
        category: null,
        subtype: null,
        brand: { value: null, confidence: null, provenance: 'unknown', evidence: [] },
        colors: { primary: 'Blue', secondary: [] },
        material: [],
        silhouette: [],
        pattern: [],
        attributes: { pockets: [], visible: [], distinctive: [] },
      },
    }),
  });
  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');
  const candidate = await stage(env, req, '/picker/a.jpg');

  const outcome = await env.classification.classifyClosetCandidate(req, candidate.candidateId);
  assert.equal(outcome.status, 'needs_manual_classification');
  let after = await reload(env, req, candidate.candidateId);
  assert.equal(after.errorCode, 'classification_requires_manual_category');
  assert.equal(after.primaryColor, 'Blue', 'the usable part of the result is kept');

  // The user supplies the missing taxonomy and the candidate advances.
  await env.store.updateClosetCandidate(req, candidate.candidateId, {
    category: 'Outerwear',
    clothingType: 'Coat',
    subtype: 'Trench coat',
  });
  const advanced = await env.store.transitionClosetCandidate(req, candidate.candidateId, {
    to: 'ready_for_review',
    errorCode: null,
  });
  assert.equal(advanced.ok, true);
  after = await reload(env, req, candidate.candidateId);
  assert.equal(after.status, 'ready_for_review');
  assert.equal(after.clothingType, 'Coat');
  assert.equal(after.errorCode, null);
});

// ── Offline and reconnect ────────────────────────────────────────────────────

test('a candidate created offline parks in waiting_for_network without a network call', async () => {
  const env = load();
  env.connectivity.setClosetConnectivityProvider({ isOnline: () => false });
  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');
  const candidate = await stage(env, req, '/picker/a.jpg');

  const outcome = await env.classification.classifyClosetCandidate(req, candidate.candidateId);
  assert.equal(outcome.kind, 'deferred');
  assert.equal(outcome.errorCode, 'candidate_offline');
  assert.equal(env.transport.calls.length, 0, 'no request was spent while offline');

  const after = await reload(env, req, candidate.candidateId);
  assert.equal(after.status, 'waiting_for_network');
  assert.equal(after.errorCode, 'candidate_offline');
  assert.equal(after.attemptCount, 0, 'parking is not an attempt');
});

test('the waiting state survives a restart and the record is not lost', async () => {
  const env = load();
  env.connectivity.setClosetConnectivityProvider({ isOnline: () => false });
  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');
  const candidate = await stage(env, req, '/picker/a.jpg');
  await env.classification.classifyClosetCandidate(req, candidate.candidateId);

  const restarted = load();
  for (const [k, v] of env.m.files) restarted.m.files.set(k, v);
  const req2 = asActor(restarted.actorContext, 'user-a');
  const after = await reload(restarted, req2, candidate.candidateId);
  assert.equal(after.status, 'waiting_for_network');
});

test('reconnect requeues within the concurrency cap — no stampede', async () => {
  const env = load();
  env.connectivity.setClosetConnectivityProvider({ isOnline: () => false });
  const req = asActor(env.actorContext, 'user-a');
  const ids = [];
  for (let i = 0; i < 6; i += 1) {
    seedSource(env.m, `/picker/${i}.jpg`);
    const candidate = await stage(env, req, `/picker/${i}.jpg`);
    ids.push(candidate.candidateId);
    await env.classification.classifyClosetCandidate(req, candidate.candidateId);
  }
  for (const id of ids) {
    assert.equal((await reload(env, req, id)).status, 'waiting_for_network');
  }

  // Back online. One bounded pass may start at most two.
  env.connectivity.setClosetConnectivityProvider({ isOnline: () => true });
  const pass = await env.classification.requeueClosetCandidatesOnReconnect(req);
  assert.equal(pass.ok, true);
  assert.equal(pass.started, 2, 'a reconnect must not start every parked candidate');
  assert.equal(env.transport.calls.length, 2);

  const resolved = [];
  for (const id of ids) {
    const record = await reload(env, req, id);
    if (record.status === 'ready_for_review') resolved.push(id);
  }
  assert.equal(resolved.length, 2);
});

test('a transport network failure parks the candidate rather than failing it', async () => {
  const env = load();
  env.connectivity.resetClosetConnectivityProvider();
  env.transport.handler = async () => {
    throw new Error('Network request failed');
  };
  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');
  const candidate = await stage(env, req, '/picker/a.jpg');

  const outcome = await env.classification.classifyClosetCandidate(req, candidate.candidateId);
  assert.equal(outcome.kind, 'deferred');
  assert.equal(outcome.errorCode, 'candidate_offline');
  assert.equal((await reload(env, req, candidate.candidateId)).status, 'waiting_for_network');
});

// ── Abort and actor safety ───────────────────────────────────────────────────

test('an in-flight request is aborted and the candidate returns to queued', async () => {
  const env = load();
  env.connectivity.resetClosetConnectivityProvider();
  let sawAbort = false;
  env.transport.handler = (options, signal) =>
    new Promise((resolve) => {
      signal.addEventListener('abort', () => {
        sawAbort = true;
        resolve({ status: 'failed' });
      });
    });

  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');
  const candidate = await stage(env, req, '/picker/a.jpg');

  const pending = env.classification.classifyClosetCandidate(req, candidate.candidateId);
  // Wait for the request to actually be in flight before cancelling it.
  while (env.classification.inFlightClosetClassificationCount() === 0) {
    await new Promise((r) => setImmediate(r));
  }
  assert.equal(env.classification.cancelAllClosetClassifications(), 1);
  const outcome = await pending;

  assert.equal(sawAbort, true, 'the AbortSignal reached the transport');
  assert.equal(outcome.kind, 'deferred');
  assert.equal(outcome.errorCode, 'candidate_request_aborted');
  const after = await reload(env, req, candidate.candidateId);
  assert.equal(after.status, 'queued', 'a cancelled candidate is not a failed candidate');
  assert.equal(after.errorCode, null, 'a cancellation leaves no error on the record');
});

test('actor A -> actor B mid-request: the late completion writes to NEITHER actor', async () => {
  const env = load();
  env.connectivity.resetClosetConnectivityProvider();
  let release;
  env.transport.handler = () => new Promise((resolve) => { release = resolve; });

  const reqA = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');
  const candidate = await stage(env, reqA, '/picker/a.jpg');

  const pending = env.classification.classifyClosetCandidate(reqA, candidate.candidateId);
  while (env.classification.inFlightClosetClassificationCount() === 0) {
    await new Promise((r) => setImmediate(r));
  }

  // Actor switch AFTER the network call started. Abort fires, but the response
  // is released anyway — the race the epoch check exists to lose safely.
  env.classification.cancelAllClosetClassifications();
  const reqB = asActor(env.actorContext, 'user-b');
  release({ status: 'completed', identificationV2: okResult() });
  const outcome = await pending;
  assert.equal(outcome.kind, 'skipped');
  assert.equal(outcome.errorCode, 'candidate_actor_stale');

  // Nothing was written under B.
  const listedB = await env.store.listClosetCandidates(reqB);
  assert.equal(listedB.candidates.length, 0);

  // And nothing was written under A either: the candidate is still classifying,
  // which the interruption recovery pass will handle on the next launch.
  const reqA2 = asActor(env.actorContext, 'user-a');
  const afterA = await reload(env, reqA2, candidate.candidateId);
  assert.equal(afterA.status, 'classifying');
  assert.equal(afterA.category, null, 'no classification metadata was persisted');
});

test('a completion arriving after a same-user sign-out/sign-in cycle is rejected', async () => {
  const env = load();
  env.connectivity.resetClosetConnectivityProvider();
  let release;
  env.transport.handler = () => new Promise((resolve) => { release = resolve; });

  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');
  const candidate = await stage(env, req, '/picker/a.jpg');
  const pending = env.classification.classifyClosetCandidate(req, candidate.candidateId);
  while (env.classification.inFlightClosetClassificationCount() === 0) {
    await new Promise((r) => setImmediate(r));
  }

  // Same actorId, new epoch — the case a userId check alone cannot catch.
  env.actorContext.advanceActorEpoch(null);
  env.actorContext.advanceActorEpoch('user-a');
  release({ status: 'completed', identificationV2: okResult() });
  const outcome = await pending;
  assert.equal(outcome.kind, 'skipped');
  assert.equal(outcome.errorCode, 'candidate_actor_stale');

  const req2 = env.actorContext.createActorRequest();
  const after = await reload(env, req2, candidate.candidateId);
  assert.equal(after.category, null);
});

test('a candidate rejected mid-flight is not resurrected by the response', async () => {
  const env = load();
  env.connectivity.resetClosetConnectivityProvider();
  let release;
  env.transport.handler = () => new Promise((resolve) => { release = resolve; });

  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');
  const candidate = await stage(env, req, '/picker/a.jpg');
  const pending = env.classification.classifyClosetCandidate(req, candidate.candidateId);
  while (env.classification.inFlightClosetClassificationCount() === 0) {
    await new Promise((r) => setImmediate(r));
  }

  await env.store.rejectClosetCandidate(req, candidate.candidateId);
  release({ status: 'completed', identificationV2: okResult() });
  const outcome = await pending;
  assert.equal(outcome.kind, 'skipped');
  assert.equal(outcome.errorCode, 'candidate_invalid_transition');

  const after = await reload(env, req, candidate.candidateId);
  assert.equal(after.status, 'rejected');
  assert.equal(after.category, null);
});

test('a stale actor request cannot start a classification at all', async () => {
  const env = load();
  env.connectivity.resetClosetConnectivityProvider();
  const stale = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');
  const candidate = await stage(env, stale, '/picker/a.jpg');
  env.actorContext.advanceActorEpoch('user-b');

  const outcome = await env.classification.classifyClosetCandidate(stale, candidate.candidateId);
  assert.equal(outcome.kind, 'skipped');
  assert.equal(env.transport.calls.length, 0);
});

// ── Retry, backoff and budgets ───────────────────────────────────────────────

test('backoff grows exponentially, is bounded, and carries bounded jitter', () => {
  const env = load();
  const { retryBackoffMs } = env.classification;
  assert.equal(retryBackoffMs(0, () => 0.5), 2000);
  assert.equal(retryBackoffMs(1, () => 0.5), 4000);
  assert.equal(retryBackoffMs(2, () => 0.5), 8000);
  // Ceiling.
  assert.equal(retryBackoffMs(50, () => 0.5), 60000);
  // Jitter stays within +/-25% and never goes negative.
  for (const roll of [0, 0.25, 0.75, 1]) {
    const value = retryBackoffMs(1, () => roll);
    assert.ok(value >= 3000 && value <= 5000, `jitter out of range: ${value}`);
  }
  assert.ok(retryBackoffMs(0, () => 0) >= 0);
});

test('a retryable failure fails the candidate and is picked up by the next queue pass', async () => {
  const env = load();
  env.connectivity.resetClosetConnectivityProvider();
  env.transport.handler = async () => ({ status: 'failed', httpStatus: 429 });
  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');
  const candidate = await stage(env, req, '/picker/a.jpg');

  const outcome = await env.classification.classifyClosetCandidate(req, candidate.candidateId);
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.errorCode, 'classification_rate_limited');
  const after = await reload(env, req, candidate.candidateId);
  assert.equal(after.status, 'failed');
  assert.equal(after.attemptCount, 1);
  // The FIRST automatic attempt is not a retry. Counting it would spend one of
  // the two retries before anything had failed.
  assert.equal(after.automaticRetryCount, 0);
});

test('automatic retry stops at the budget and never spends a fourth attempt', async () => {
  const env = load();
  env.connectivity.resetClosetConnectivityProvider();
  env.transport.handler = async () => ({ status: 'failed', httpStatus: 429 });
  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');
  const candidate = await stage(env, req, '/picker/a.jpg');

  // Retry eligibility ignores backoff here by advancing the clock generously.
  let now = Date.now();
  for (let pass = 0; pass < 6; pass += 1) {
    now += 10 * 60 * 1000;
    const record = await reload(env, req, candidate.candidateId);
    if (record.status === 'failed') {
      await env.store.transitionClosetCandidate(req, candidate.candidateId, { to: 'queued' }, { nowMs: now });
    }
    await env.classification.runClosetCandidateQueue(req, { nowMs: now });
  }

  const after = await reload(env, req, candidate.candidateId);
  // 1 initial automatic attempt + MAX_AUTOMATIC_RETRIES retries = 3 total.
  assert.equal(after.automaticRetryCount, 2, 'exactly MAX_AUTOMATIC_RETRIES retries');
  assert.equal(after.attemptCount, 3, 'exactly MAX_TOTAL_ATTEMPTS automatic attempts');
  assert.equal(env.transport.calls.length, 3);
  // And it ends visibly actionable rather than silently parked.
  assert.equal(after.status, 'failed');
});

test('an aborted candidate resumes on the next pass instead of stranding', async () => {
  const env = load();
  env.connectivity.resetClosetConnectivityProvider();
  env.transport.handler = (options, signal) =>
    new Promise((resolve) => {
      signal.addEventListener('abort', () => resolve({ status: 'failed' }));
    });

  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');
  const candidate = await stage(env, req, '/picker/a.jpg');

  const pending = env.classification.classifyClosetCandidate(req, candidate.candidateId);
  while (env.classification.inFlightClosetClassificationCount() === 0) {
    await new Promise((r) => setImmediate(r));
  }
  env.classification.cancelAllClosetClassifications();
  await pending;

  const aborted = await reload(env, req, candidate.candidateId);
  assert.equal(aborted.status, 'queued');
  // A pristine queue entry: an aborted request is work not done, not work failed.
  // Carrying `candidate_request_aborted` here would make the runner skip it
  // forever, because that code is not automatically retryable.
  assert.equal(aborted.errorCode, null);

  // Navigating back re-runs the queue and the candidate simply resumes.
  env.transport.handler = async () => ({ status: 'completed', identificationV2: okResult() });
  const pass = await env.classification.runClosetCandidateQueue(req, {
    nowMs: Date.now() + 120_000,
  });
  assert.equal(pass.started, 1);
  assert.equal((await reload(env, req, candidate.candidateId)).status, 'ready_for_review');
});

test('a pending candidate the runner will never pick up is failed, never stranded', async () => {
  const env = load();
  env.connectivity.resetClosetConnectivityProvider();
  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');
  const candidate = await stage(env, req, '/picker/a.jpg');

  // A queued candidate carrying a failure that retrying cannot fix.
  await env.store.transitionClosetCandidate(req, candidate.candidateId, {
    to: 'failed',
    errorCode: 'classification_quota_exhausted',
  });
  await env.store.transitionClosetCandidate(req, candidate.candidateId, {
    to: 'queued',
    errorCode: 'classification_quota_exhausted',
  });

  const pass = await env.classification.runClosetCandidateQueue(req);
  assert.equal(pass.started, 0);
  assert.equal(env.transport.calls.length, 0);

  const after = await reload(env, req, candidate.candidateId);
  // `queued` offers no retry affordance and `queued -> queued` is illegal, so
  // leaving it there would be a permanent dead end for the user.
  assert.equal(after.status, 'failed');
  assert.equal(after.errorCode, 'classification_quota_exhausted');
  // `failed -> queued` is the legal manual-retry edge, so the user is not stuck.
  assert.equal((await env.store.retryClosetCandidate(req, candidate.candidateId)).ok, true);
});

test('a non-retryable failure is never automatically retried', async () => {
  const env = load();
  env.connectivity.resetClosetConnectivityProvider();
  env.transport.handler = async () => ({
    status: 'failed',
    httpStatus: 400,
    contractErrorCode: 'INVALID_INTENT',
  });
  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');
  const candidate = await stage(env, req, '/picker/a.jpg');

  const outcome = await env.classification.classifyClosetCandidate(req, candidate.candidateId);
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.errorCode, 'classification_contract_rejected');

  // Guarantee 1: `failed` is not a state the automatic runner picks up at all.
  const before = env.transport.calls.length;
  const pass = await env.classification.runClosetCandidateQueue(req, { nowMs: Date.now() + 3600_000 });
  assert.equal(pass.started, 0);
  assert.equal(env.transport.calls.length, before, 'a contract rejection was retried');

  // Guarantee 2: even if the candidate is requeued with its error preserved, the
  // runner refuses to spend another identification unit on a determined outcome.
  await env.store.transitionClosetCandidate(req, candidate.candidateId, {
    to: 'queued',
    errorCode: 'classification_contract_rejected',
  });
  const second = await env.classification.runClosetCandidateQueue(req, {
    nowMs: Date.now() + 3600_000,
  });
  assert.equal(second.started, 0);
  assert.equal(env.transport.calls.length, before, 'a contract rejection was retried');
  // It is returned to `failed` so the user still has a visible, actionable state.
  const settled = await reload(env, req, candidate.candidateId);
  assert.equal(settled.status, 'failed');
  assert.equal(settled.errorCode, 'classification_contract_rejected');
});

// MIRROR-EXTRACT-BUILDS-CLOSET-MIRROR-ENTRY-PATH (end-to-end) —
// Build 2.5 Step 2, replacing Step 1's dormancy assertion.
//
// Step 1 asserted the opposite of this test: that a `mirror_extract` candidate
// reaching this queue failed closed with `classification_contract_rejected`,
// because `closet_mirror` was absent from the shared vocabulary and the only
// alternative was mislabelling it `closet_gallery`. Step 2 added the vocabulary
// value, so failing closed is no longer the correct behaviour and asserting it
// would now pin a bug.
//
// The protected property is unchanged and is what this test still proves: a
// Mirror crop's provenance is never laundered. Step 1 proved that by showing
// NO request went out; Step 2 proves it by showing the request that DOES go out
// carries `closet_mirror` — and specifically not `closet_gallery`, and not a
// Scanner path or a shopping intent.
test('a mirror_extract candidate classifies as closet_mirror, never as closet_gallery', async () => {
  const env = load();
  env.connectivity.resetClosetConnectivityProvider();
  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/mirror/a.jpg');
  const created = await env.store.createClosetCandidate(req, {
    sourceUri: '/mirror/a.jpg',
    sourceType: 'mirror_extract',
    ownerId: req.actorId,
  });
  assert.equal(created.kind, 'created');

  const outcome = await env.classification.classifyClosetCandidate(req, created.candidate.candidateId);
  assert.equal(outcome.status, 'ready_for_review');

  assert.equal(env.transport.calls.length, 1, 'the mirror candidate did not reach the backend');
  const { options } = env.transport.calls[0];
  assert.ok(options.contractRequestV2, 'no V2 envelope was sent');
  assert.equal(options.contractRequestV2.contractVersion, 'fashion-identification-v2');
  assert.equal(options.contractRequestV2.source.entryPath, 'closet_mirror');
  assert.notEqual(options.contractRequestV2.source.entryPath, 'closet_gallery');
  assert.equal(options.contractRequestV2.intent, 'identify_for_closet');
  assert.equal(options.contractRequestV2.mode, 'detect_items');
  // Scanner-only correlation fields stay absent on a Mirror request exactly as
  // they do on camera and gallery ones.
  assert.equal(options.scanSessionId, undefined);
  assert.equal(options.imageDigestPrefix, undefined);
  assert.equal(options.multiItemDetection, undefined);
  assert.equal(options.selectedCandidate, undefined);

  // The candidate lands in review. It is NOT promoted into the Closet here.
  const settled = await reload(env, req, created.candidate.candidateId);
  assert.equal(settled.status, 'ready_for_review');
});

// UNKNOWN-CANDIDATE-SOURCE-STILL-FAILS-CLOSED (Build 2.5 Step 2).
//
// Activating `mirror_extract` widened the closed entry-path mapping by exactly
// one member. It must not have reintroduced the pre-Step-1 behaviour where any
// non-camera source silently became `closet_gallery`.
//
// The probes are the still-RESERVED members of `CLOSET_CANDIDATE_SOURCES`.
// They are the only usable ones: `buildClosetCandidateRecord` coerces a source
// outside that vocabulary to `gallery` on write (Build 1 behaviour, unchanged
// here), so a wholly invented string never reaches this orchestrator as itself.
// These four do reach it verbatim, have no backend entry path, and must
// therefore spend no network call at all.
for (const reservedSource of [
  'recent_scan',
  'receipt_screenshot',
  'retailer_url',
  'share_sheet',
]) {
  test(`a ${reservedSource} candidate still fails closed before any network call`, async () => {
    const env = load();
    env.connectivity.resetClosetConnectivityProvider();
    const req = asActor(env.actorContext, 'user-a');
    seedSource(env.m, `/reserved/${reservedSource}.jpg`);
    const created = await env.store.createClosetCandidate(req, {
      sourceUri: `/reserved/${reservedSource}.jpg`,
      sourceType: reservedSource,
      ownerId: req.actorId,
    });
    assert.equal(created.kind, 'created');
    assert.equal(created.candidate.sourceType, reservedSource, 'the store rewrote the source');

    const outcome = await env.classification.classifyClosetCandidate(
      req,
      created.candidate.candidateId,
    );
    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.errorCode, 'classification_contract_rejected');
    assert.equal(env.transport.calls.length, 0, `${reservedSource} must never reach the network`);

    const settled = await reload(env, req, created.candidate.candidateId);
    assert.equal(settled.status, 'failed');
    assert.equal(settled.errorCode, 'classification_contract_rejected');
  });
}

test('the UI does not offer retry for a failure retrying cannot fix', () => {
  const env = load();
  const errorsModule = runModule('services/closetCandidateErrors.ts', (s) =>
    s === '../types/closetCandidate' ? env.types : {},
  );
  // Offered: the user may reasonably try these again.
  for (const code of [
    'classification_timeout',
    'classification_rate_limited',
    'classification_provider_failed',
    'classification_malformed_response',
    'candidate_offline',
    'candidate_request_aborted',
  ]) {
    assert.equal(errorsModule.isUserRetryable(code), true, code);
  }
  // Not offered: retrying is guaranteed not to help.
  for (const code of [
    'classification_contract_rejected',
    'classification_quota_exhausted',
    'classification_auth_failed',
    'classification_requires_manual_category',
    'candidate_media_unsupported',
    'candidate_storage_insufficient',
    'candidate_limit_reached',
    'classification_interrupted_repeatedly',
  ]) {
    assert.equal(errorsModule.isUserRetryable(code), false, code);
  }
});

test('a candidate still inside its backoff window is skipped by the queue', async () => {
  const env = load();
  env.connectivity.resetClosetConnectivityProvider();
  env.transport.handler = async () => ({ status: 'failed', httpStatus: 429 });
  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');
  const candidate = await stage(env, req, '/picker/a.jpg');

  await env.classification.classifyClosetCandidate(req, candidate.candidateId);
  await env.store.transitionClosetCandidate(req, candidate.candidateId, { to: 'queued' });

  const before = env.transport.calls.length;
  // Immediately after the attempt: still inside the backoff window.
  await env.classification.runClosetCandidateQueue(req, { nowMs: Date.now(), random: () => 0.5 });
  assert.equal(env.transport.calls.length, before);

  // Well past it.
  await env.classification.runClosetCandidateQueue(req, {
    nowMs: Date.now() + 120_000,
    random: () => 0.5,
  });
  assert.equal(env.transport.calls.length, before + 1);
});

// ── Concurrency ──────────────────────────────────────────────────────────────

test('at most two classifications run concurrently', async () => {
  const env = load();
  env.connectivity.resetClosetConnectivityProvider();
  let concurrent = 0;
  let peak = 0;
  const releases = [];
  env.transport.handler = () =>
    new Promise((resolve) => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      releases.push(() => {
        concurrent -= 1;
        resolve({ status: 'completed', identificationV2: okResult() });
      });
    });

  const req = asActor(env.actorContext, 'user-a');
  for (let i = 0; i < 5; i += 1) {
    seedSource(env.m, `/picker/${i}.jpg`);
    await stage(env, req, `/picker/${i}.jpg`);
  }

  const pass = env.classification.runClosetCandidateQueue(req);
  while (releases.length < 2) await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(peak, 2, `peak concurrency was ${peak}`);
  for (const release of [...releases]) release();
  const result = await pass;
  assert.equal(result.started, 2);
});

test('the queue never exceeds the cap even when asked for more', async () => {
  const env = load();
  env.connectivity.resetClosetConnectivityProvider();
  const req = asActor(env.actorContext, 'user-a');
  for (let i = 0; i < 5; i += 1) {
    seedSource(env.m, `/picker/${i}.jpg`);
    await stage(env, req, `/picker/${i}.jpg`);
  }
  const result = await env.classification.runClosetCandidateQueue(req, { maxConcurrent: 99 });
  assert.equal(result.started, 2);
});

test('oldest candidates are drained first', async () => {
  const env = load();
  env.connectivity.resetClosetConnectivityProvider();
  const req = asActor(env.actorContext, 'user-a');
  const ids = [];
  for (let i = 0; i < 4; i += 1) {
    seedSource(env.m, `/picker/${i}.jpg`);
    const candidate = await stage(env, req, `/picker/${i}.jpg`);
    ids.push(candidate.candidateId);
    // Force distinct createdAt values.
    await new Promise((r) => setTimeout(r, 2));
  }
  await env.classification.runClosetCandidateQueue(req);
  const first = await reload(env, req, ids[0]);
  const second = await reload(env, req, ids[1]);
  const last = await reload(env, req, ids[3]);
  assert.equal(first.status, 'ready_for_review');
  assert.equal(second.status, 'ready_for_review');
  assert.equal(last.status, 'queued');
});

// ── Crash-loop prevention end to end ─────────────────────────────────────────

test('an image that kills the process twice stops being requeued automatically', async () => {
  const env = load();
  env.connectivity.resetClosetConnectivityProvider();
  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');
  const candidate = await stage(env, req, '/picker/a.jpg');

  // Launch 1: the request starts and the process dies.
  await env.store.transitionClosetCandidate(req, candidate.candidateId, {
    to: 'classifying',
    attempt: 'automatic',
  });
  // Launch 2: recovery requeues it, it starts again, the process dies again.
  await env.store.recoverInterruptedClosetCandidates(req);
  assert.equal((await reload(env, req, candidate.candidateId)).status, 'queued');
  await env.store.transitionClosetCandidate(req, candidate.candidateId, {
    to: 'classifying',
    attempt: 'automatic',
  });
  // Launch 3: recovery must now fail it permanently.
  await env.store.recoverInterruptedClosetCandidates(req);
  const after = await reload(env, req, candidate.candidateId);
  assert.equal(after.status, 'failed');
  assert.equal(after.errorCode, 'classification_interrupted_repeatedly');

  // And the queue runner must not pick it back up on its own.
  const before = env.transport.calls.length;
  await env.classification.runClosetCandidateQueue(req, { nowMs: Date.now() + 3600_000 });
  assert.equal(env.transport.calls.length, before, 'a crash-looping image was requeued');
});

test('an expired candidate is never classified', async () => {
  const env = load();
  env.connectivity.resetClosetConnectivityProvider();
  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');
  const candidate = await stage(env, req, '/picker/a.jpg');
  const future = Date.parse(candidate.expiresAt) + 1000;

  const outcome = await env.classification.classifyClosetCandidate(req, candidate.candidateId, {
    nowMs: future,
  });
  assert.equal(outcome.kind, 'skipped');
  assert.equal(env.transport.calls.length, 0);

  const queued = await env.classification.runClosetCandidateQueue(req, { nowMs: future });
  assert.equal(queued.started, 0);
  assert.equal(env.transport.calls.length, 0);
});

test('a candidate with no durable media fails rather than calling the backend', async () => {
  const env = load();
  env.connectivity.resetClosetConnectivityProvider();
  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');
  const candidate = await stage(env, req, '/picker/a.jpg');

  // Simulate a manifest whose media reference was lost.
  const raw = JSON.parse(
    env.m.files.get('/doc/kscan_closet_candidates/kscan_closet_candidates.json'),
  );
  raw[0] = { ...raw[0], candidateImageUri: null };
  env.m.files.set(
    '/doc/kscan_closet_candidates/kscan_closet_candidates.json',
    JSON.stringify(raw),
  );

  const outcome = await env.classification.classifyClosetCandidate(req, candidate.candidateId);
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.errorCode, 'candidate_media_unreadable');
  assert.equal(env.transport.calls.length, 0);
});

test('a duplicate-state candidate is never classified automatically', async () => {
  const env = load();
  env.connectivity.resetClosetConnectivityProvider();
  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');
  const candidate = await stage(env, req, '/picker/a.jpg');

  const raw = JSON.parse(
    env.m.files.get('/doc/kscan_closet_candidates/kscan_closet_candidates.json'),
  );
  raw[0] = { ...raw[0], status: 'duplicate' };
  env.m.files.set(
    '/doc/kscan_closet_candidates/kscan_closet_candidates.json',
    JSON.stringify(raw),
  );

  const outcome = await env.classification.classifyClosetCandidate(req, candidate.candidateId);
  assert.equal(outcome.kind, 'skipped');
  const queued = await env.classification.runClosetCandidateQueue(req);
  assert.equal(queued.started, 0);
  assert.equal(env.transport.calls.length, 0);
});

// ── Latched-offline recovery (audit repair D) ────────────────────────────────

test('a latched offline belief is escapable without an app restart', async () => {
  const env = load();
  // The REAL reactive default provider, not an injected stub: the defect being
  // certified here lives in how that provider latches.
  env.connectivity.resetClosetConnectivityProvider();
  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');
  const candidate = await stage(env, req, '/picker/a.jpg');

  // 1. One transport-level network failure latches the port offline.
  env.transport.handler = async () => {
    throw new Error('Network request failed');
  };
  await env.classification.classifyClosetCandidate(req, candidate.candidateId);
  assert.equal((await reload(env, req, candidate.candidateId)).status, 'waiting_for_network');
  assert.equal(env.connectivity.isClosetOnline instanceof Function, true);
  assert.equal(await env.connectivity.isClosetOnline(), false, 'the port latched offline');

  // 2. Connectivity is genuinely back.
  env.transport.handler = async () => ({
    status: 'completed',
    identificationV2: okResult(),
  });
  const callsBeforeRecovery = env.transport.calls.length;

  // 3. The BARE queue cannot recover: the offline preflight parks the candidate
  //    again without ever touching the network. This is the defect.
  const bare = await env.classification.runClosetCandidateQueue(req);
  assert.equal(bare.started, 0);
  assert.equal(
    env.transport.calls.length,
    callsBeforeRecovery,
    'the bare queue never attempts a request while the belief is latched',
  );
  assert.equal((await reload(env, req, candidate.candidateId)).status, 'waiting_for_network');

  // 4. The reconnect entry point — what focus and manual retry now call —
  //    refreshes the belief first, so the candidate re-enters the bounded queue.
  //    The clock is advanced past the retry backoff the spent attempt earned;
  //    the backoff is orthogonal to the latch this test is about.
  const recovered = await env.classification.requeueClosetCandidatesOnReconnect(req, {
    nowMs: Date.now() + 5 * 60 * 1000,
  });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.started, 1);

  // 5. Classification succeeds in the SAME session.
  const settled = await reload(env, req, candidate.candidateId);
  assert.equal(settled.status, 'ready_for_review');
  assert.equal(settled.category, 'Outerwear');
  assert.equal(await env.connectivity.isClosetOnline(), true);
});

test('the recovery pass stays bounded and does not resurrect determined failures', async () => {
  const env = load();
  env.connectivity.resetClosetConnectivityProvider();
  const req = asActor(env.actorContext, 'user-a');

  // Four parked candidates plus one that failed for a non-retryable reason.
  const parked = [];
  for (let i = 0; i < 4; i += 1) {
    seedSource(env.m, `/picker/p${i}.jpg`);
    parked.push((await stage(env, req, `/picker/p${i}.jpg`)).candidateId);
  }
  seedSource(env.m, '/picker/auth.jpg');
  const authFailed = (await stage(env, req, '/picker/auth.jpg')).candidateId;

  env.transport.handler = async () => ({ status: 'failed', httpStatus: 401 });
  await env.classification.classifyClosetCandidate(req, authFailed);
  assert.equal((await reload(env, req, authFailed)).errorCode, 'classification_auth_failed');

  env.transport.handler = async () => {
    throw new Error('Network request failed');
  };
  for (const id of parked) {
    await env.classification.classifyClosetCandidate(req, id);
  }

  env.transport.handler = async () => ({
    status: 'completed',
    identificationV2: okResult(),
  });
  const callsBefore = env.transport.calls.length;
  const pass = await env.classification.requeueClosetCandidatesOnReconnect(req, {
    nowMs: Date.now() + 5 * 60 * 1000,
  });

  // Concurrency two is preserved by the recovery path.
  assert.equal(pass.started, 2);
  assert.equal(env.transport.calls.length - callsBefore, 2);
  // The auth failure is never re-attempted by a reconnect.
  assert.equal((await reload(env, req, authFailed)).status, 'failed');
  assert.equal((await reload(env, req, authFailed)).errorCode, 'classification_auth_failed');
});
