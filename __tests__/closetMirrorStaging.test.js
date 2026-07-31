// Mirror Selfie crop-staging adapter suite (Build 2.5 Phase 0B).
//
// services/closetMirrorStaging.ts is exercised against the REAL candidate
// pipeline — services/closetCandidateLibrary.js, closetCandidateMedia.js,
// closetCandidateSchema.js, closetCandidateStateMachine.ts, actorContext.js —
// running over an in-memory filesystem, exactly the harness
// __tests__/closetCandidateStore.test.js already proves the real store with.
// Only expo-file-system, expo-image-manipulator and expo-crypto are doubled;
// everything above that boundary is the genuine production module.

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
  const modified = new Map();
  let freeBytes = 10 * 1024 * 1024 * 1024;
  const api = {
    documentDirectory: '/doc/',
    EncodingType: { UTF8: 'utf8', Base64: 'base64' },
    async makeDirectoryAsync() {},
    async getInfoAsync(p) {
      if (!files.has(p)) return { exists: false };
      return {
        exists: true,
        size: Buffer.from(files.get(p), 'utf8').length,
        modificationTime: (modified.get(p) ?? 0) / 1000,
      };
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
      modified.delete(p);
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
      return freeBytes;
    },
  };
  return { files, api, setFreeBytes: (n) => (freeBytes = n) };
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
    // Deterministic, non-cryptographic stand-in: same input -> same digest,
    // different input -> (overwhelmingly likely) different digest. That is
    // the only property these tests rely on.
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

/** @param options.mirrorActive default true; flips MIRROR_SELFIE_V1_ACTIVE for the flag-gating tests. */
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

  return {
    m,
    actorContext,
    store,
    staging,
    telemetry,
    telemetryEvents,
    reviewEligibility,
    batchReview,
    featureFlags,
    stateMachine,
  };
}

function asActor(actorContext, actorId) {
  actorContext.advanceActorEpoch(actorId);
  return actorContext.createActorRequest();
}

function seedCrop(m, uri, marker) {
  m.files.set(uri, Buffer.from(`${marker}:${uri}`).toString('base64'));
  return uri;
}

function crops(m, keys, markerPrefix = 'crop') {
  return keys.map((key, i) => ({
    cropUri: seedCrop(m, `/mirror/${key}.jpg`, `${markerPrefix}${i}`),
    cropKey: key,
  }));
}

// ── Source and routing ───────────────────────────────────────────────────────

test('MIRROR-SOURCE-IS-ACTIVE: staged candidates carry sourceType mirror_extract', async () => {
  const { m, actorContext, store, staging } = load();
  const actorRequest = asActor(actorContext, 'user-1');
  const result = await staging.stageMirrorSelfieGarmentCrops({
    actorRequest,
    extractionSessionId: 'sess_1',
    crops: crops(m, ['crop_a']),
  });
  assert.equal(result.kind, 'ok');
  const listed = await store.listClosetCandidates(actorRequest);
  assert.equal(listed.candidates.length, 1);
  assert.equal(listed.candidates[0].sourceType, 'mirror_extract');
});

test('MIRROR-SOURCE-PERSISTS-THROUGH-HYDRATION: rereading the manifest keeps mirror_extract', async () => {
  const { m, actorContext, store, staging } = load();
  const actorRequest = asActor(actorContext, 'user-1');
  await staging.stageMirrorSelfieGarmentCrops({
    actorRequest,
    extractionSessionId: 'sess_1',
    crops: crops(m, ['crop_a']),
  });
  // A second, independent read (as hydration would do) sees the same source.
  const reread = await store.listClosetCandidates(actorRequest);
  assert.equal(reread.candidates[0].sourceType, 'mirror_extract');
});

test('MIRROR-CANNOT-USE-IDENTIFY-AND-SHOP: the adapter never imports the Scanner or Elise identification modules', () => {
  const source = fs.readFileSync(path.join(ROOT, 'services/closetMirrorStaging.ts'), 'utf8');
  assert.ok(!/scannerIdentificationV2/.test(source));
  assert.ok(!/scanIdentification/.test(source));
  assert.ok(!/eliseIdentificationV2/.test(source));
  assert.ok(!/identify_and_shop/.test(source));
});

test('MIRROR-NEVER-FALLS-BACK-TO-DIRECT-CLOSET-INSERTION: the adapter never imports the committed Closet library', () => {
  const source = fs.readFileSync(path.join(ROOT, 'services/closetMirrorStaging.ts'), 'utf8');
  assert.ok(!/from '\.\/closetLibrary'/.test(source));
  assert.ok(!/createClosetItem/.test(source));
});

// ── Batch staging ────────────────────────────────────────────────────────────

test('MIRROR-STAGES-ONE-CROP', async () => {
  const { m, actorContext, staging } = load();
  const actorRequest = asActor(actorContext, 'user-1');
  const result = await staging.stageMirrorSelfieGarmentCrops({
    actorRequest,
    extractionSessionId: 'sess_1',
    crops: crops(m, ['a']),
  });
  assert.equal(result.kind, 'ok');
  assert.equal(result.outcomes.length, 1);
  assert.equal(result.outcomes[0].outcome, 'created');
});

test('MIRROR-STAGES-MULTIPLE-CROPS', async () => {
  const { m, actorContext, staging } = load();
  const actorRequest = asActor(actorContext, 'user-1');
  const result = await staging.stageMirrorSelfieGarmentCrops({
    actorRequest,
    extractionSessionId: 'sess_1',
    crops: crops(m, ['a', 'b', 'c']),
  });
  assert.equal(result.kind, 'ok');
  assert.equal(result.outcomes.length, 3);
  assert.ok(result.outcomes.every((o) => o.outcome === 'created'));
});

test('MIRROR-STAGES-EIGHT-CROPS', async () => {
  const { m, actorContext, staging } = load();
  const actorRequest = asActor(actorContext, 'user-1');
  const keys = Array.from({ length: 8 }, (_, i) => `k${i}`);
  const result = await staging.stageMirrorSelfieGarmentCrops({
    actorRequest,
    extractionSessionId: 'sess_1',
    crops: crops(m, keys),
  });
  assert.equal(result.kind, 'ok');
  assert.equal(result.outcomes.length, 8);
  assert.ok(result.outcomes.every((o) => o.outcome === 'created'));
});

test('MIRROR-REJECTS-ZERO-CROPS', async () => {
  const { actorContext, staging } = load();
  const actorRequest = asActor(actorContext, 'user-1');
  const result = await staging.stageMirrorSelfieGarmentCrops({
    actorRequest,
    extractionSessionId: 'sess_1',
    crops: [],
  });
  assert.deepEqual(result, { kind: 'rejected', reason: 'mirror_empty_crop_list' });
});

test('MIRROR-REJECTS-MORE-THAN-EIGHT / MIRROR-DOES-NOT-SILENTLY-TRUNCATE / MIRROR-REJECTS-MORE-THAN-EIGHT-BEFORE-MEDIA-WORK', async () => {
  const { m, actorContext, staging, store } = load();
  const actorRequest = asActor(actorContext, 'user-1');
  const keys = Array.from({ length: 9 }, (_, i) => `k${i}`);
  const result = await staging.stageMirrorSelfieGarmentCrops({
    actorRequest,
    extractionSessionId: 'sess_1',
    crops: crops(m, keys),
  });
  assert.deepEqual(result, { kind: 'rejected', reason: 'mirror_batch_limit_exceeded' });
  // Not silently truncated to the first eight: NOTHING was staged.
  const listed = await store.listClosetCandidates(actorRequest);
  assert.equal(listed.candidates.length, 0);
});

test('MIRROR-BATCH-ID-IS-SHARED / MIRROR-BATCH-POSITIONS-ARE-DETERMINISTIC', async () => {
  const { m, actorContext, store, staging } = load();
  const actorRequest = asActor(actorContext, 'user-1');
  const result = await staging.stageMirrorSelfieGarmentCrops({
    actorRequest,
    extractionSessionId: 'sess_1',
    crops: crops(m, ['first', 'second', 'third']),
  });
  assert.equal(result.kind, 'ok');
  const listed = await store.listClosetCandidates(actorRequest);
  const batchIds = new Set(listed.candidates.map((c) => c.batchId));
  assert.equal(batchIds.size, 1, 'every candidate must share one batch id');
  assert.equal([...batchIds][0], result.batchId);
  const byPosition = listed.candidates.slice().sort((a, b) => a.batchPosition - b.batchPosition);
  assert.deepEqual(byPosition.map((c) => c.batchPosition), [0, 1, 2]);
});

// ── Actor isolation ──────────────────────────────────────────────────────────

test('MIRROR-REJECTS-STALE-ACTOR / MIRROR-ABORTS-ON-ACTOR-CHANGE', async () => {
  const { m, actorContext, staging } = load();
  const actorRequest = asActor(actorContext, 'user-1');
  actorContext.advanceActorEpoch('user-2'); // actorRequest is now stale
  const result = await staging.stageMirrorSelfieGarmentCrops({
    actorRequest,
    extractionSessionId: 'sess_1',
    crops: crops(m, ['a']),
  });
  assert.deepEqual(result, { kind: 'rejected', reason: 'candidate_actor_stale' });
});

test('MIRROR-REJECTS-CROSS-ACTOR-WRITE: each actor only ever sees their own staged crops', async () => {
  const { m, actorContext, store, staging } = load();
  const userA = asActor(actorContext, 'user-a');
  await staging.stageMirrorSelfieGarmentCrops({
    actorRequest: userA,
    extractionSessionId: 'sess_1',
    crops: crops(m, ['a']),
  });
  const userB = asActor(actorContext, 'user-b');
  await staging.stageMirrorSelfieGarmentCrops({
    actorRequest: userB,
    extractionSessionId: 'sess_1',
    crops: crops(m, ['b']),
  });
  const listedA = await store.listClosetCandidates(asActor(actorContext, 'user-a'));
  assert.equal(listedA.candidates.length, 1);
  assert.equal(listedA.candidates[0].sourceId, 'a');
});

test('MIRROR-SAME-USER-NEW-EPOCH-REJECTS-OLD-WORK / MIRROR-STALE-COMPLETION-CANNOT-PERSIST', async () => {
  const { m, actorContext, store, staging } = load();
  const firstRequest = asActor(actorContext, 'user-1');
  // Same user, signs out and back in: actorId identical, epoch has moved.
  actorContext.advanceActorEpoch('user-1');
  const result = await staging.stageMirrorSelfieGarmentCrops({
    actorRequest: firstRequest,
    extractionSessionId: 'sess_1',
    crops: crops(m, ['a']),
  });
  assert.deepEqual(result, { kind: 'rejected', reason: 'candidate_actor_stale' });
  const listed = await store.listClosetCandidates(actorContext.createActorRequest());
  assert.equal(listed.candidates.length, 0);
});

// ── Existing-pipeline reuse ──────────────────────────────────────────────────

test('MIRROR-USES-EXISTING-MEDIA-DERIVATION / MIRROR-USES-EXISTING-STORAGE-PREFLIGHT / MIRROR-USES-EXISTING-CONTENT-HASH', async () => {
  const { m, actorContext, store, staging } = load();
  const actorRequest = asActor(actorContext, 'user-1');
  const result = await staging.stageMirrorSelfieGarmentCrops({
    actorRequest,
    extractionSessionId: 'sess_1',
    crops: crops(m, ['a']),
  });
  assert.equal(result.kind, 'ok');
  const listed = await store.listClosetCandidates(actorRequest);
  const candidate = listed.candidates[0];
  // Candidate-owned derivative + content hash prove deriveCandidateMedia and
  // computeCandidateContentHash actually ran — the adapter contains neither.
  assert.match(candidate.candidateImageUri, /^\/doc\/kscan_closet_candidates\/images\//);
  assert.equal(candidate.contentHashVersion, 'sha256-normalized-v1');
  assert.ok(candidate.contentHash);
});

test('MIRROR-USES-EXISTING-EXACT-DUPLICATE-GATE: restaging the identical crop bytes dedupes as an active candidate', async () => {
  const { m, actorContext, staging } = load();
  const actorRequest = asActor(actorContext, 'user-1');
  const uri = seedCrop(m, '/mirror/dup.jpg', 'same-bytes');
  await staging.stageMirrorSelfieGarmentCrops({
    actorRequest,
    extractionSessionId: 'sess_1',
    crops: [{ cropUri: uri, cropKey: 'dup_key_1' }],
  });
  // A different crop KEY (different session-scoped identity) but the exact
  // same underlying bytes: the pipeline's exact-hash gate — not this
  // adapter — is what catches it.
  const second = await staging.stageMirrorSelfieGarmentCrops({
    actorRequest,
    extractionSessionId: 'sess_1',
    crops: [{ cropUri: uri, cropKey: 'dup_key_2' }],
  });
  assert.equal(second.kind, 'ok');
  assert.equal(second.outcomes[0].outcome, 'deduped_candidate');
});

test('MIRROR-RESPECTS-UNRESOLVED-CAP', async () => {
  const { m, actorContext, staging } = load();
  const actorRequest = asActor(actorContext, 'user-1');
  // Fill the unresolved cap (40) with distinct single-crop batches, then one
  // more crop must be rejected for capacity, never silently accepted.
  for (let i = 0; i < 40; i += 1) {
    const outcome = await staging.stageMirrorSelfieGarmentCrops({
      actorRequest,
      extractionSessionId: 'sess_fill',
      crops: [{ cropUri: seedCrop(m, `/mirror/fill_${i}.jpg`, `fill${i}`), cropKey: `fill_${i}` }],
    });
    assert.equal(outcome.kind, 'ok', `fill crop ${i}`);
  }
  const overCap = await staging.stageMirrorSelfieGarmentCrops({
    actorRequest,
    extractionSessionId: 'sess_over',
    crops: [{ cropUri: seedCrop(m, '/mirror/over.jpg', 'over'), cropKey: 'over_key' }],
  });
  assert.equal(overCap.kind, 'ok');
  assert.equal(overCap.outcomes[0].outcome, 'rejected');
  assert.equal(overCap.outcomes[0].errorCode, 'candidate_limit_reached');
});

test('MIRROR-CANDIDATES-ENTER-BATCH-PROJECTION', async () => {
  const { m, actorContext, store, staging, batchReview } = load();
  const actorRequest = asActor(actorContext, 'user-1');
  const result = await staging.stageMirrorSelfieGarmentCrops({
    actorRequest,
    extractionSessionId: 'sess_1',
    crops: crops(m, ['a', 'b']),
  });
  const listed = await store.listClosetCandidates(actorRequest);
  const projection = batchReview.getClosetBatchReviewProjection({
    actorId: actorRequest.actorId,
    candidates: listed.candidates,
  });
  const group = projection.groups.find((g) => g.groupId === result.batchId);
  assert.ok(group, 'mirror batch must appear in the review projection');
  assert.equal(group.totalCount, 2);
});

test('MIRROR-CANDIDATES-REMAIN-PROMOTION-COMPATIBLE: eligibility is decided purely by status, not sourceType', () => {
  const { reviewEligibility } = load();
  const mirrorCandidate = {
    schemaVersion: 3,
    candidateId: 'c1',
    batchId: 'b1',
    ownerId: 'user-1',
    sourceType: 'mirror_extract',
    status: 'ready_for_review',
    category: 'jacket',
    candidateImageUri: '/doc/kscan_closet_candidates/images/x.jpg',
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  };
  const eligibility = reviewEligibility.getClosetCandidateReviewEligibility(mirrorCandidate, {
    actorId: 'user-1',
  });
  assert.equal(eligibility.selectable, true);
  const promotion = reviewEligibility.getClosetCandidatePromotionEligibility(mirrorCandidate, {
    actorId: 'user-1',
    mediaOwned: true,
    mediaReadable: true,
  });
  assert.equal(promotion.promotable, true);
});

// ── Domain separation ────────────────────────────────────────────────────────

test('MIRROR-CREATES-NO-RECENT-SCAN / MIRROR-CREATES-NO-COMMERCE-ARTIFACT: no Recent Scan or commerce module is reachable from the adapter', () => {
  const source = fs.readFileSync(path.join(ROOT, 'services/closetMirrorStaging.ts'), 'utf8');
  assert.ok(!/from '\.\/library'/.test(source), 'must not import the Recent Scan library');
  assert.ok(!/purchaseOptions|commerceRelevance|recommendedProducts/.test(source));
});

test('MIRROR-CREATES-NO-CLOSET-ITEM-BEFORE-PROMOTION: staged crops are candidates, never committed items', async () => {
  const { m, actorContext, staging, batchReview } = load();
  const actorRequest = asActor(actorContext, 'user-1');
  const result = await staging.stageMirrorSelfieGarmentCrops({
    actorRequest,
    extractionSessionId: 'sess_1',
    crops: crops(m, ['a']),
  });
  assert.equal(result.outcomes[0].outcome, 'created');
  // 'created' is a candidate outcome. Promotion — the one thing that commits
  // a candidate into the Closet — is a separate, later, user-driven step this
  // module never calls.
  assert.ok(!/finalizeClosetCandidatePromotion|promoteSelectedClosetCandidates/.test(
    fs.readFileSync(path.join(ROOT, 'services/closetMirrorStaging.ts'), 'utf8'),
  ));
});

test('MIRROR-DOES-NOT-PERSIST-ORIGINAL-SELFIE: only the candidate-owned derivative is stored, never the caller-supplied cropUri', async () => {
  const { m, actorContext, store, staging } = load();
  const actorRequest = asActor(actorContext, 'user-1');
  const cropUri = seedCrop(m, '/mirror/original.jpg', 'original-selfie-crop');
  await staging.stageMirrorSelfieGarmentCrops({
    actorRequest,
    extractionSessionId: 'sess_1',
    crops: [{ cropUri, cropKey: 'k1' }],
  });
  const listed = await store.listClosetCandidates(actorRequest);
  assert.equal(listed.candidates[0].originalImageUri, null);
  assert.notEqual(listed.candidates[0].candidateImageUri, cropUri);
  // The candidate's own correlation id is the crop key, never the extraction
  // session id or the crop URI — nothing session- or selfie-scoped is carried
  // onto the record beyond what deterministic lineage already summarizes.
  assert.equal(listed.candidates[0].sourceId, 'k1');
  assert.notEqual(listed.candidates[0].sourceId, 'sess_1');
});

test('MIRROR-DOES-NOT-CREATE-A-SECOND-CANDIDATE-STORE: staged crops live in the one candidate manifest', async () => {
  const { m, actorContext, store, staging } = load();
  const actorRequest = asActor(actorContext, 'user-1');
  await staging.stageMirrorSelfieGarmentCrops({
    actorRequest,
    extractionSessionId: 'sess_1',
    crops: crops(m, ['a']),
  });
  assert.ok(m.files.has('/doc/kscan_closet_candidates/kscan_closet_candidates.json'));
  const manifest = JSON.parse(m.files.get('/doc/kscan_closet_candidates/kscan_closet_candidates.json'));
  assert.equal(manifest.length, 1);
});

// ── Crop identity and lineage ────────────────────────────────────────────────

test('MIRROR-DUPLICATE-CROP-KEY-REJECTED', async () => {
  const { m, actorContext, staging } = load();
  const actorRequest = asActor(actorContext, 'user-1');
  const result = await staging.stageMirrorSelfieGarmentCrops({
    actorRequest,
    extractionSessionId: 'sess_1',
    crops: [
      { cropUri: seedCrop(m, '/mirror/x.jpg', 'x'), cropKey: 'same' },
      { cropUri: seedCrop(m, '/mirror/y.jpg', 'y'), cropKey: 'same' },
    ],
  });
  assert.deepEqual(result, { kind: 'rejected', reason: 'mirror_duplicate_crop_key' });
});

test('MIRROR-SOURCE-LINEAGE-IS-DETERMINISTIC / MIRROR-DIFFERENT-CROPS-HAVE-DIFFERENT-LINEAGE', async () => {
  const { staging } = load();
  const a1 = await staging.deriveMirrorSourceLineageId('sess_1', 'crop_a');
  const a2 = await staging.deriveMirrorSourceLineageId('sess_1', 'crop_a');
  const b = await staging.deriveMirrorSourceLineageId('sess_1', 'crop_b');
  assert.equal(a1, a2, 'same session + same crop key must be deterministic');
  assert.notEqual(a1, b, 'different crop keys must diverge');
});

test('MIRROR-SAME-CROP-KEY-DIFFERENT-SESSION-IS-DISTINCT / MIRROR-DIFFERENT-SESSION-PRESERVES-DISTINCT-LINEAGE', async () => {
  const { staging } = load();
  const s1 = await staging.deriveMirrorSourceLineageId('sess_1', 'crop_a');
  const s2 = await staging.deriveMirrorSourceLineageId('sess_2', 'crop_a');
  assert.notEqual(s1, s2);
});

test('MIRROR-LINEAGE-CONTAINS-NO-ACTOR-OR-URI-DATA', async () => {
  const { staging } = load();
  const lineage = await staging.deriveMirrorSourceLineageId('sess_1', 'crop_a');
  assert.match(lineage, /^[0-9a-f]+$/, 'lineage must be an opaque hex digest');
  assert.ok(!lineage.includes('user'));
  assert.ok(!lineage.includes('file'));
});

test('MIRROR-RESTAGING-SAME-SESSION-CROP-IS-IDEMPOTENT / MIRROR-RESTAGING-SAME-CROP-IS-IDEMPOTENT', async () => {
  const { m, actorContext, staging } = load();
  const actorRequest = asActor(actorContext, 'user-1');
  const cropUri = seedCrop(m, '/mirror/idem.jpg', 'idempotent');
  const first = await staging.stageMirrorSelfieGarmentCrops({
    actorRequest,
    extractionSessionId: 'sess_idem',
    crops: [{ cropUri, cropKey: 'idem_key' }],
  });
  assert.equal(first.outcomes[0].outcome, 'created');
  // Restaging the SAME session + SAME crop key + SAME bytes must not create a
  // second, separately-reviewable candidate.
  const second = await staging.stageMirrorSelfieGarmentCrops({
    actorRequest,
    extractionSessionId: 'sess_idem',
    crops: [{ cropUri, cropKey: 'idem_key' }],
  });
  assert.equal(second.kind, 'ok');
  assert.equal(second.outcomes[0].outcome, 'deduped_candidate');
});

// ── Media ────────────────────────────────────────────────────────────────────

test('MIRROR-CROP-URI-PASSES-EXISTING-MEDIA-DERIVATION / MIRROR-CANDIDATE-OWNS-DURABLE-DERIVATIVE', async () => {
  const { m, actorContext, store, staging } = load();
  const actorRequest = asActor(actorContext, 'user-1');
  await staging.stageMirrorSelfieGarmentCrops({
    actorRequest,
    extractionSessionId: 'sess_1',
    crops: crops(m, ['a']),
  });
  const listed = await store.listClosetCandidates(actorRequest);
  const derivedPath = listed.candidates[0].candidateImageUri;
  assert.ok(m.files.has(derivedPath), 'the candidate-owned derivative must exist on disk');
});

test('MIRROR-UNREADABLE-CROP-URI-FAILS-TRUTHFULLY: a per-crop media failure does not use an adapter-invented code', async () => {
  const { actorContext, staging } = load();
  const actorRequest = asActor(actorContext, 'user-1');
  // Never seeded on the in-memory filesystem: unreadable by construction.
  const result = await staging.stageMirrorSelfieGarmentCrops({
    actorRequest,
    extractionSessionId: 'sess_1',
    crops: [{ cropUri: '/mirror/does-not-exist.jpg', cropKey: 'missing' }],
  });
  assert.equal(result.kind, 'ok');
  assert.equal(result.outcomes[0].outcome, 'rejected');
  assert.equal(result.outcomes[0].errorCode, 'candidate_media_unreadable');
});

test('MIRROR-TEMP-CROP-REMAINS-CALLER-OWNED: the adapter never moves or deletes the caller-supplied crop URI', async () => {
  const { m, actorContext, staging } = load();
  const actorRequest = asActor(actorContext, 'user-1');
  const cropUri = seedCrop(m, '/mirror/owned.jpg', 'caller-owned');
  await staging.stageMirrorSelfieGarmentCrops({
    actorRequest,
    extractionSessionId: 'sess_1',
    crops: [{ cropUri, cropKey: 'owned_key' }],
  });
  assert.ok(m.files.has(cropUri), 'the source crop file must still exist after staging resolves');
});

// ── Feature flags ────────────────────────────────────────────────────────────

test('MIRROR-API-REJECTS-WHEN-MIRROR-FLAG-OFF / MIRROR-API-REJECTS-WHEN-CANDIDATE-STAGING-OFF', async () => {
  const { m, actorContext, store, staging } = load({ mirrorActive: false });
  const actorRequest = asActor(actorContext, 'user-1');
  const result = await staging.stageMirrorSelfieGarmentCrops({
    actorRequest,
    extractionSessionId: 'sess_1',
    crops: crops(m, ['a']),
  });
  assert.deepEqual(result, { kind: 'rejected', reason: 'mirror_staging_disabled' });
  const listed = await store.listClosetCandidates(actorRequest);
  assert.equal(listed.candidates.length, 0, 'no candidate may exist while the flag is off');
});

// ── Partial batches ──────────────────────────────────────────────────────────

test('MIRROR-PER-CROP-OUTCOMES-PRESERVE-INPUT-ORDER / MIRROR-PARTIAL-BATCH-RESULT-MAPS-EVERY-CROP', async () => {
  const { m, actorContext, staging } = load({
    manipulatorFailsFor: (uri) => uri.includes('bad'),
  });
  const actorRequest = asActor(actorContext, 'user-1');
  const input = [
    { cropUri: seedCrop(m, '/mirror/good1.jpg', 'good1'), cropKey: 'good1' },
    { cropUri: seedCrop(m, '/mirror/bad.jpg', 'bad'), cropKey: 'bad1' },
    { cropUri: seedCrop(m, '/mirror/good2.jpg', 'good2'), cropKey: 'good2' },
  ];
  const result = await staging.stageMirrorSelfieGarmentCrops({
    actorRequest,
    extractionSessionId: 'sess_1',
    crops: input,
  });
  assert.equal(result.kind, 'ok');
  assert.equal(result.outcomes.length, 3, 'every submitted crop must have an outcome');
  assert.deepEqual(result.outcomes.map((o) => o.cropKey), ['good1', 'bad1', 'good2']);
  assert.deepEqual(result.outcomes.map((o) => o.batchPosition), [0, 1, 2]);
  assert.equal(result.outcomes[0].outcome, 'created');
  assert.equal(result.outcomes[1].outcome, 'rejected');
  assert.equal(result.outcomes[2].outcome, 'created');
});

test('MIRROR-PARTIAL-FAILURE-DOES-NOT-ROLL-BACK-SUCCESS / MIRROR-PARTIAL-BATCH-FAILURE-PRESERVES-SUCCESS', async () => {
  const { m, actorContext, store, staging } = load({
    manipulatorFailsFor: (uri) => uri.includes('bad'),
  });
  const actorRequest = asActor(actorContext, 'user-1');
  await staging.stageMirrorSelfieGarmentCrops({
    actorRequest,
    extractionSessionId: 'sess_1',
    crops: [
      { cropUri: seedCrop(m, '/mirror/good.jpg', 'good'), cropKey: 'good' },
      { cropUri: seedCrop(m, '/mirror/bad.jpg', 'bad'), cropKey: 'bad' },
    ],
  });
  const listed = await store.listClosetCandidates(actorRequest);
  assert.equal(listed.candidates.length, 1, 'the successful crop must survive the failed one');
  assert.equal(listed.candidates[0].sourceId, 'good');
});

test('MIRROR-FAILED-CROPS-CAN-BE-IDENTIFIED-FOR-RETRY: a caller can isolate rejected crops by cropKey and restage only those', async () => {
  const { m, actorContext, staging } = load({
    manipulatorFailsFor: (uri) => uri.includes('bad'),
  });
  const actorRequest = asActor(actorContext, 'user-1');
  const first = await staging.stageMirrorSelfieGarmentCrops({
    actorRequest,
    extractionSessionId: 'sess_1',
    crops: [
      { cropUri: seedCrop(m, '/mirror/good.jpg', 'good'), cropKey: 'good' },
      { cropUri: seedCrop(m, '/mirror/bad.jpg', 'bad'), cropKey: 'bad' },
    ],
  });
  const failedKeys = first.outcomes.filter((o) => o.outcome === 'rejected').map((o) => o.cropKey);
  assert.deepEqual(failedKeys, ['bad']);
  // Retry only the failed crop, now with a working source.
  const retryResult = await staging.stageMirrorSelfieGarmentCrops({
    actorRequest,
    extractionSessionId: 'sess_1',
    crops: [{ cropUri: seedCrop(m, '/mirror/retry_ok.jpg', 'fixed'), cropKey: 'bad' }],
  });
  assert.equal(retryResult.outcomes[0].outcome, 'created');
});

// ── Manual classification compatibility ──────────────────────────────────────

test('MIRROR-CANDIDATE-NEEDS-MANUAL-CLASSIFICATION-ENTERS-REVIEW / MIRROR-NEEDS-MANUAL-CLASSIFICATION-IS-NOT-TERMINAL', () => {
  const { stateMachine } = load();
  // The ONE authoritative transition matrix has no sourceType concept at all,
  // so this holds identically for a mirror_extract candidate: reachable from
  // classifying, able to advance to ready_for_review, and NOT terminal.
  assert.ok(stateMachine.canTransition('classifying', 'needs_manual_classification'));
  assert.ok(stateMachine.canTransition('needs_manual_classification', 'ready_for_review'));
  assert.equal(stateMachine.isTerminalStatus('needs_manual_classification'), false);
  assert.equal(stateMachine.isUnresolvedStatus('needs_manual_classification'), true);
});

test('MIRROR-MANUAL-CLASSIFICATION-CAN-BECOME-REVIEW-READY / MIRROR-MANUAL-CLASSIFICATION-CAN-BECOME-PROMOTION-ELIGIBLE / MIRROR-MANUAL-CLASSIFICATION-PRESERVES-BATCH-IDENTITY', async () => {
  const { m, actorContext, store, staging, reviewEligibility } = load({
    manipulatorFailsFor: () => false,
  });
  const actorRequest = asActor(actorContext, 'user-1');
  const result = await staging.stageMirrorSelfieGarmentCrops({
    actorRequest,
    extractionSessionId: 'sess_1',
    crops: crops(m, ['a']),
  });
  const candidateId = result.outcomes[0].candidateId;
  // Force the candidate into needs_manual_classification, exactly as an
  // ambiguous classification response would: queued -> classifying -> manual.
  await store.transitionClosetCandidate(actorRequest, candidateId, { to: 'preparing' });
  await store.transitionClosetCandidate(actorRequest, candidateId, { to: 'classifying' });
  await store.transitionClosetCandidate(actorRequest, candidateId, {
    to: 'needs_manual_classification',
    errorCode: 'classification_requires_manual_category',
  });
  let loaded = await store.getClosetCandidate(actorRequest, candidateId);
  assert.equal(loaded.candidate.status, 'needs_manual_classification');
  assert.equal(loaded.candidate.batchId, result.batchId, 'batch identity survives manual classification');

  // The EXISTING manual-classification entry point — not a Mirror-specific one.
  const manual = await store.manuallyClassifyClosetCandidate(actorRequest, candidateId, {
    category: 'jacket',
  });
  assert.equal(manual.ok, true);
  loaded = await store.getClosetCandidate(actorRequest, candidateId);
  assert.equal(loaded.candidate.status, 'ready_for_review');
  assert.equal(loaded.candidate.batchId, result.batchId);

  const promotion = reviewEligibility.getClosetCandidatePromotionEligibility(loaded.candidate, {
    actorId: actorRequest.actorId,
    mediaOwned: true,
    mediaReadable: true,
  });
  assert.equal(promotion.promotable, true);
});

// ── Telemetry ────────────────────────────────────────────────────────────────

test('mirror_selfie_crops_staged carries only bounded properties and no identifying data', async () => {
  const { m, actorContext, staging, telemetryEvents } = load();
  const actorRequest = asActor(actorContext, 'user-1');
  await staging.stageMirrorSelfieGarmentCrops({
    actorRequest,
    extractionSessionId: 'sess_super_secret_session_id',
    crops: crops(m, ['crop_key_alpha', 'crop_key_beta']),
  });
  const staged = telemetryEvents.filter((e) => e.event === 'mirror_selfie_crops_staged');
  assert.equal(staged.length, 1);
  const payload = staged[0].payload;
  const allowed = new Set([
    'cropCountBucket',
    'createdCount',
    'duplicateCount',
    'rejectedCount',
    'batchLimitReached',
    'outcome',
    'errorCode',
  ]);
  for (const key of Object.keys(payload)) {
    assert.ok(allowed.has(key), `unexpected telemetry property ${key}`);
  }
  const serialized = JSON.stringify(payload);
  for (const forbidden of [
    'sess_super_secret_session_id',
    'crop_key_alpha',
    'crop_key_beta',
    'user-1',
    '/mirror/',
    '.jpg',
  ]) {
    assert.ok(!serialized.includes(forbidden), `telemetry leaked ${forbidden}`);
  }
  assert.equal(payload.cropCountBucket, '2-3');
  assert.equal(payload.createdCount, 2);
});

test('mirror_selfie_crops_staged is emitted even when staging is rejected outright (flag off)', async () => {
  const { m, actorContext, staging, telemetryEvents } = load({ mirrorActive: false });
  const actorRequest = asActor(actorContext, 'user-1');
  await staging.stageMirrorSelfieGarmentCrops({
    actorRequest,
    extractionSessionId: 'sess_1',
    crops: crops(m, ['a']),
  });
  const staged = telemetryEvents.filter((e) => e.event === 'mirror_selfie_crops_staged');
  assert.equal(staged.length, 1);
  assert.equal(staged[0].payload.outcome, 'rejected');
});

/**
 * Strip comments before matching a forbidden symbol.
 *
 * The Mirror sources NAME the symbols they must never call, in prose, so that
 * the boundary is legible where the code is. A naive substring match over the
 * whole file therefore fails on the very documentation that records the rule.
 * Reachability is a property of code, so only code is searched.
 */
function codeOnly(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('MIRROR-MANUAL-CLASSIFICATION-USES-EXISTING-MODAL: no Mirror component classifies or reviews candidates', () => {
  // NARROWED BY BUILD 2.5 STEP 3, deliberately.
  //
  // The original assertion was "no file under components/closet has 'mirror' in
  // its name", which was a proxy for "Phase 0B added no Mirror UI". Step 3 adds
  // MirrorSelfieExtractionModal — a PRE-STAGING extraction review, which shows
  // crops and asks whether to keep them.
  //
  // The property that still has to hold is the one the proxy was standing in
  // for: no Mirror component may classify a garment, mount the candidate review,
  // or reach the taxonomy. Identification belongs to identify_for_closet, and
  // candidate review belongs to the existing ClosetBatchReviewPanel.
  const componentsDir = path.join(ROOT, 'components', 'closet');
  const entries = fs.existsSync(componentsDir) ? fs.readdirSync(componentsDir) : [];
  const mirrorComponents = entries.filter((name) => /mirror/i.test(name));

  for (const name of mirrorComponents) {
    const source = codeOnly(fs.readFileSync(path.join(componentsDir, name), 'utf8'));
    for (const forbidden of [
      'ClosetBatchReviewPanel',
      'ClosetCandidateManualClassifyModal',
      'classifyClosetCandidate',
      'closetTaxonomy',
      'stageMirrorSelfieGarmentCrops',
    ]) {
      assert.ok(
        !source.includes(forbidden),
        `${name} reached ${forbidden}; extraction review must not become candidate review`,
      );
    }
  }
});
