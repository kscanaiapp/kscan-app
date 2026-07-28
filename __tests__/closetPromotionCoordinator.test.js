// THE SERIALIZED PROMOTION COORDINATOR (Closet Upgrade Build 2, Phase 3).
//
// services/closetCandidatePromotion.js is executed for real, over the real
// candidate store, the real committed Closet store, the real eligibility
// predicate and the real actor context, against an in-memory filesystem. Nothing
// on the promotion path is doubled: an assertion here about idempotency, ordering
// or concurrency is an assertion about the code that ships.
//
// THE FOUR PROPERTIES THIS SUITE EXISTS FOR:
//   1. concurrency is ONE, and repeated submissions do not start a second queue
//   2. a retry can never produce a second committed item or a second media file
//   3. one item's failure never rolls back an earlier success or blocks a later
//      attempt — except where continuing is provably unsafe (a full disk)
//   4. nothing is finalized before the committed item has been read back

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
  const hooks = {
    beforeWrite: null,
    beforeMove: null,
    beforeGetInfo: null,
    beforeManipulate: null,
  };
  const api = {
    documentDirectory: '/doc/',
    EncodingType: { UTF8: 'utf8', Base64: 'base64' },
    async makeDirectoryAsync() {},
    async getInfoAsync(p) {
      if (typeof hooks.beforeGetInfo === 'function') await hooks.beforeGetInfo(p);
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
      // A hook may return 'skip' to model a write that reports success without
      // landing — the fault a read-back exists to catch.
      if (typeof hooks.beforeWrite === 'function') {
        const verdict = await hooks.beforeWrite(p, c);
        if (verdict === 'skip') return;
      }
      files.set(p, c);
      modified.set(p, Date.now());
    },
    async moveAsync({ from, to }) {
      if (typeof hooks.beforeMove === 'function') await hooks.beforeMove(from, to);
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
  return {
    files,
    api,
    hooks,
    setFreeBytes(next) {
      freeBytes = next;
    },
  };
}

function cryptoShim() {
  let seq = 0;
  return {
    getRandomBytes(n) {
      seq += 1;
      return Uint8Array.from({ length: n }, (_, i) => (seq * 31 + i * 7) % 256);
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
 * The whole promotion path, wired exactly as it is on device.
 *
 * The require shims are also the LOCKS: the pure modules are loaded with shims
 * that refuse anything outside their allowed set, so a persistence import
 * appearing in the eligibility predicate, the projection or the promotion
 * vocabulary fails to load here rather than being noticed later.
 */
function load(platformOS = 'android') {
  const m = memfs();
  const crypto = cryptoShim();
  const actorContext = runModule('services/actorContext.js', () => ({}));

  let cacheSeq = 0;
  const calls = { manipulate: 0, closetWrites: 0 };
  const imageManipulator = {
    SaveFormat: { JPEG: 'jpeg' },
    manipulateAsync: async (uri, ops) => {
      calls.manipulate += 1;
      // Media derivation is the one step the committed store does NOT serialize
      // internally, so overlap here is overlap of the promotion SEQUENCE itself —
      // which is what "concurrency one" actually means.
      if (typeof m.hooks.beforeManipulate === 'function') await m.hooks.beforeManipulate(uri);
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
      return {
        saveScanToCloud: async () => ({ ok: true }),
        softDeleteCloudSavedScan: async () => ({ ok: true }),
      };
    }
    if (spec === './identificationSnapshot') {
      return {
        hydrateScanHistory: (raw, hydrateOne) => {
          if (!Array.isArray(raw)) return { records: [], corruptedCount: 0 };
          const records = [];
          let corruptedCount = 0;
          for (const entry of raw) {
            try {
              const hydrated = hydrateOne(entry);
              if (hydrated) records.push(hydrated);
              else corruptedCount += 1;
            } catch {
              corruptedCount += 1;
            }
          }
          return { records, corruptedCount };
        },
      };
    }
    if (spec === './purchaseOptions' || spec === './dressingRoomCommerce') {
      return {
        isPurchaseOptionsSnapshot: (v) => Array.isArray(v),
        normalizePurchaseOptions: (v) => (Array.isArray(v) ? v.slice() : []),
      };
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
  const telemetry = runModule('services/closetTelemetry.ts', () => ({}));
  const media = runModule('services/closetCandidateMedia.js', (spec) => {
    if (spec === 'expo-file-system/legacy') return m.api;
    if (spec === 'expo-image-manipulator') return imageManipulator;
    if (spec === 'expo-crypto') return crypto;
    if (spec === './library') return library;
    if (spec === '../types/closetCandidate') return types;
    return {};
  });
  const store = runModule('services/closetCandidateLibrary.js', (spec) => {
    if (spec === 'react-native') return { Platform: { OS: platformOS } };
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

  const eligibility = runModule('services/closetCandidateReviewEligibility.ts', (spec) => {
    if (spec === '../types/closetCandidate') return types;
    if (spec === './closetCandidateStateMachine') return stateMachine;
    throw new Error(`the eligibility predicate must stay pure: ${spec}`);
  });
  const contract = runModule('services/closetCandidatePromotionContract.ts', (spec) => {
    throw new Error(`the promotion contract must import nothing: ${spec}`);
  });
  const batchReview = runModule('services/closetBatchReview.ts', (spec) => {
    if (spec === '../types/closetCandidate') return types;
    if (spec === './closetCandidateStateMachine') return stateMachine;
    if (spec === './closetCandidateErrors') return candidateErrors;
    if (spec === './closetCandidateReviewEligibility') return eligibility;
    if (spec === './closetCandidatePromotionContract') return contract;
    throw new Error(`the projection must not import ${spec}`);
  });

  const promotion = runModule('services/closetCandidatePromotion.js', (spec) => {
    if (spec === './actorContext') return actorContext;
    if (spec === './closetLibrary') return closetLibrary;
    if (spec === './closetCandidateLibrary') return store;
    if (spec === './closetCandidateMedia') return media;
    if (spec === './closetCandidateReviewEligibility') return eligibility;
    if (spec === './closetBatchReview') return batchReview;
    if (spec === './closetCandidatePromotionContract') return contract;
    // THE CROSS-DOMAIN LOCK. Recent Scan, Elise, StyleChat, commerce, retailer and
    // Supabase modules are all outside promotion's world; reaching for any of them
    // fails the whole suite at load time.
    throw new Error(`the promotion coordinator must not import ${spec}`);
  });

  return {
    m,
    calls,
    actorContext,
    closetLibrary,
    store,
    media,
    schema,
    types,
    eligibility,
    contract,
    batchReview,
    promotion,
  };
}

function asActor(actorContext, actorId) {
  actorContext.advanceActorEpoch(actorId);
  return actorContext.createActorRequest();
}

function seedSource(m, uri, marker = 'original') {
  m.files.set(uri, Buffer.from(`${marker}:${uri}`).toString('base64'));
  return uri;
}

/** Stage N ready candidates in one batch, in picker order. */
async function stageBatch(env, req, count, overrides = {}) {
  const batchId = env.schema.createClosetBatchId();
  const candidates = [];
  for (let index = 0; index < count; index += 1) {
    const uri = `/picker/item-${index}-${batchId}.jpg`;
    seedSource(env.m, uri, `photo-${index}`);
    const created = await env.store.createClosetCandidate(req, {
      sourceUri: uri,
      sourceType: 'gallery',
      ownerId: req?.actorId,
      batchId,
      batchPosition: index,
    });
    assert.equal(created.kind, 'created', `staging ${index} failed: ${created.code}`);
    const id = created.candidate.candidateId;
    if (overrides.leaveQueued) {
      candidates.push(created.candidate);
      continue;
    }
    await env.store.transitionClosetCandidate(req, id, { to: 'classifying' });
    const ready = await env.store.transitionClosetCandidate(req, id, {
      to: 'ready_for_review',
      patch: { category: 'Outerwear', clothingType: 'Jacket', primaryColor: 'Black' },
    });
    candidates.push(ready.candidate);
  }
  return { batchId, candidates, ids: candidates.map((entry) => entry.candidateId) };
}

/** The coordinator with test-friendly scheduling: no real timers. */
function promote(env, input) {
  return env.promotion.promoteSelectedClosetCandidates({
    yieldToUi: async () => {},
    ...input,
  });
}

function statuses(result) {
  return result.results.map((entry) => entry.status);
}

// ── Happy path ───────────────────────────────────────────────────────────────

test('one selected candidate becomes one committed Closet item', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const batch = await stageBatch(env, req, 1);

  const result = await promote(env, {
    actorId: 'user-a',
    actorEpoch: req.epoch,
    batchId: batch.batchId,
    candidateIds: batch.ids,
  });

  assert.equal(result.ok, true);
  assert.equal(result.promotedCount, 1);
  assert.equal(result.failedCount, 0);
  assert.deepEqual(statuses(result), ['promoted']);

  const items = await env.closetLibrary.loadCloset('user-a');
  assert.equal(items.length, 1);
  assert.equal(items[0].sourceCandidateId, batch.ids[0]);
  assert.equal(items[0].id, result.results[0].committedClosetItemId);
  assert.equal(items[0].category, 'Outerwear');
  assert.equal(items[0].title, 'Jacket');

  const candidate = await env.store.getClosetCandidate(req, batch.ids[0]);
  assert.equal(candidate.candidate.status, 'saved');
  assert.equal(candidate.candidate.promotedClosetItemId, items[0].id);
});

test('several selected candidates promote in batch order, leaving others untouched', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const batch = await stageBatch(env, req, 4);

  // Submitted deliberately out of order; the coordinator restores picker order.
  const submitted = [batch.ids[3], batch.ids[0], batch.ids[2]];
  const result = await promote(env, {
    actorId: 'user-a',
    actorEpoch: req.epoch,
    batchId: batch.batchId,
    candidateIds: submitted,
  });

  assert.equal(result.promotedCount, 3);
  assert.deepEqual(
    result.results.map((entry) => entry.candidateId),
    [batch.ids[0], batch.ids[2], batch.ids[3]],
  );
  assert.deepEqual(
    result.results.map((entry) => entry.batchPosition),
    [0, 2, 3],
  );

  // The unselected candidate is exactly as it was.
  const untouched = await env.store.getClosetCandidate(req, batch.ids[1]);
  assert.equal(untouched.candidate.status, 'ready_for_review');
  assert.equal(untouched.candidate.promotedClosetItemId, null);
  assert.equal((await env.closetLibrary.loadCloset('user-a')).length, 3);
});

test('a repeated id in the submitted selection is coalesced, not promoted twice', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const batch = await stageBatch(env, req, 1);

  const result = await promote(env, {
    actorId: 'user-a',
    actorEpoch: req.epoch,
    batchId: batch.batchId,
    candidateIds: [batch.ids[0], batch.ids[0], batch.ids[0]],
  });
  assert.equal(result.requestedCount, 1);
  assert.equal(result.promotedCount, 1);
  assert.equal((await env.closetLibrary.loadCloset('user-a')).length, 1);
});

test('promotion creates no Recent Scan, no Elise state, and nothing with a price on it', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const batch = await stageBatch(env, req, 2);
  await promote(env, {
    actorId: 'user-a',
    actorEpoch: req.epoch,
    batchId: batch.batchId,
    candidateIds: batch.ids,
  });

  // The Recent Scan manifest was never created at all.
  assert.equal(env.m.files.has('/doc/kscan_library/kscan_library.json'), false);
  assert.equal((await env.library_scans?.() ?? []).length ?? 0, 0);

  const committed = JSON.parse(env.m.files.get('/doc/kscan_closet/kscan_closet.json'));
  const forbidden = [
    'purchaseOptions',
    'recommendedProducts',
    'products',
    'retailerUrl',
    'affiliateUrl',
    'productUrl',
    'price',
    'currency',
    'sku',
    'availability',
    'providerPayload',
    'signedUrl',
    'contentHash',
    'attemptCount',
    'automaticRetryCount',
    'interruptionCount',
    'expiresAt',
    'errorCode',
    'status',
    'duplicateMatch',
    'confidence',
  ];
  for (const item of committed) {
    for (const key of forbidden) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(item, key),
        false,
        `a promoted item carried ${key}`,
      );
    }
  }
});

// ── Eligibility ──────────────────────────────────────────────────────────────

test('only a review-ready candidate is promotable; every other state is refused', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const batch = await stageBatch(env, req, 6);

  // Push five of the six into states that must never promote.
  await env.store.transitionClosetCandidate(req, batch.ids[1], { to: 'rejected' });
  await env.store.transitionClosetCandidate(req, batch.ids[2], { to: 'saving' });
  const queued = await stageBatch(env, req, 1, { leaveQueued: true });
  const needsDetails = await stageBatch(env, req, 1, { leaveQueued: true });
  await env.store.transitionClosetCandidate(req, needsDetails.ids[0], { to: 'classifying' });
  await env.store.transitionClosetCandidate(req, needsDetails.ids[0], {
    to: 'needs_manual_classification',
    errorCode: 'classification_requires_manual_category',
  });
  const failed = await stageBatch(env, req, 1, { leaveQueued: true });
  await env.store.transitionClosetCandidate(req, failed.ids[0], {
    to: 'failed',
    errorCode: 'classification_timeout',
  });
  const waiting = await stageBatch(env, req, 1, { leaveQueued: true });
  await env.store.transitionClosetCandidate(req, waiting.ids[0], {
    to: 'waiting_for_network',
    errorCode: 'candidate_offline',
  });

  const submitted = [
    batch.ids[0],
    batch.ids[2],
    queued.ids[0],
    needsDetails.ids[0],
    failed.ids[0],
    waiting.ids[0],
  ];
  const result = await promote(env, {
    actorId: 'user-a',
    actorEpoch: req.epoch,
    candidateIds: submitted,
  });

  const byId = new Map(result.results.map((entry) => [entry.candidateId, entry]));
  assert.equal(byId.get(batch.ids[0]).status, 'promoted');
  for (const id of [batch.ids[2], queued.ids[0], needsDetails.ids[0], failed.ids[0], waiting.ids[0]]) {
    assert.equal(byId.get(id).status, 'ineligible', `${id} was not refused`);
  }
  assert.equal((await env.closetLibrary.loadCloset('user-a')).length, 1);
});

test('a duplicate, an expired record and a missing category are each refused by name', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const batch = await stageBatch(env, req, 4);

  // `duplicate` is an ENTRY status — intake stages a committed-Closet content
  // collision directly in it, and it is never reached by transition. The fixture
  // therefore sets it on disk, which is exactly the record intake would write.
  const manifestPath = '/doc/kscan_closet_candidates/kscan_closet_candidates.json';
  const raw = JSON.parse(env.m.files.get(manifestPath));
  for (const entry of raw) {
    if (entry.candidateId === batch.ids[1]) {
      entry.status = 'duplicate';
      entry.duplicateMatch = {
        closetItemId: 'closet_existing',
        confidence: 1,
        reasons: ['exact_normalized_bytes'],
        algorithmVersion: 'sha256-normalized-v1',
      };
    }
    if (entry.candidateId === batch.ids[2]) entry.category = null;
  }
  env.m.files.set(manifestPath, JSON.stringify(raw));

  // Item 3 is evaluated past its own lifetime.
  const afterExpiry = Date.parse(batch.candidates[3].expiresAt) + 1000;

  const expiredOnly = await promote(env, {
    actorId: 'user-a',
    actorEpoch: req.epoch,
    batchId: batch.batchId,
    candidateIds: [batch.ids[3]],
    nowMs: afterExpiry,
  });
  assert.equal(expiredOnly.results[0].status, 'ineligible');
  assert.equal(expiredOnly.results[0].errorCode, 'candidate_expired');

  const result = await promote(env, {
    actorId: 'user-a',
    actorEpoch: req.epoch,
    batchId: batch.batchId,
    candidateIds: [batch.ids[0], batch.ids[1], batch.ids[2]],
  });
  const byId = new Map(result.results.map((entry) => [entry.candidateId, entry]));
  assert.equal(byId.get(batch.ids[0]).status, 'promoted');
  assert.equal(byId.get(batch.ids[1]).status, 'duplicate');
  assert.equal(byId.get(batch.ids[1]).errorCode, 'already_in_closet');
  assert.equal(byId.get(batch.ids[2]).status, 'ineligible');

  // Exactly one promotion happened, and no duplicate item was created for the
  // colliding candidate.
  const items = await env.closetLibrary.loadCloset('user-a');
  assert.equal(items.length, 1);
  assert.equal(items[0].sourceCandidateId, batch.ids[0]);
});

test('provenance is checked before content, and the two outcomes never merge', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const batch = await stageBatch(env, req, 1);

  // The candidate is BOTH already promoted (provenance) and marked as a content
  // duplicate on disk. Provenance must win: it is the stronger claim, and calling
  // this a duplicate would hide the item the user already owns.
  const committed = await env.closetLibrary.createClosetItem({
    sourceUri: batch.candidates[0].candidateImageUri,
    draft: {
      title: 'Jacket',
      category: 'Outerwear',
      origin: 'direct_intake',
      sourceCandidateId: batch.ids[0],
    },
    actorRequest: req,
    ownerId: 'user-a',
  });
  const manifestPath = '/doc/kscan_closet_candidates/kscan_closet_candidates.json';
  const raw = JSON.parse(env.m.files.get(manifestPath));
  raw[0].duplicateMatch = {
    closetItemId: 'closet_other',
    confidence: 1,
    reasons: ['exact_normalized_bytes'],
    algorithmVersion: 'sha256-normalized-v1',
  };
  env.m.files.set(manifestPath, JSON.stringify(raw));

  const result = await promote(env, {
    actorId: 'user-a',
    actorEpoch: req.epoch,
    candidateIds: batch.ids,
  });
  assert.equal(result.results[0].status, 'already_promoted');
  assert.equal(result.results[0].committedClosetItemId, committed.item.id);
  assert.notEqual(result.results[0].status, 'duplicate');
  assert.equal((await env.closetLibrary.loadCloset('user-a')).length, 1);
});

test('a candidate from another actor or another batch is refused, never promoted', async () => {
  const env = load();
  const reqA = asActor(env.actorContext, 'user-a');
  const batchA = await stageBatch(env, reqA, 1);
  const otherBatchA = await stageBatch(env, reqA, 1);

  const reqB = asActor(env.actorContext, 'user-b');
  const batchB = await stageBatch(env, reqB, 1);

  const reqA2 = asActor(env.actorContext, 'user-a');
  const result = await promote(env, {
    actorId: 'user-a',
    actorEpoch: reqA2.epoch,
    batchId: batchA.batchId,
    candidateIds: [batchA.ids[0], otherBatchA.ids[0], batchB.ids[0]],
  });

  const byId = new Map(result.results.map((entry) => [entry.candidateId, entry]));
  assert.equal(byId.get(batchA.ids[0]).status, 'promoted');
  assert.equal(byId.get(otherBatchA.ids[0]).status, 'ineligible', 'a foreign batch promoted');
  // B's candidate is not even visible to A's store read.
  assert.equal(byId.get(batchB.ids[0]).status, 'ineligible');

  assert.equal((await env.closetLibrary.loadCloset('user-a')).length, 1);
  assert.equal((await env.closetLibrary.loadCloset('user-b')).length, 0);
  const bStill = await env.store.getClosetCandidate(reqB, batchB.ids[0]);
  assert.equal(bStill.ok, false, 'B’s candidate was read under A’s actor');
});

test('a candidate whose media is gone is refused with missing media, and stays reviewable', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const batch = await stageBatch(env, req, 1);
  env.m.files.delete(batch.candidates[0].candidateImageUri);

  const result = await promote(env, {
    actorId: 'user-a',
    actorEpoch: req.epoch,
    candidateIds: batch.ids,
  });
  assert.equal(result.results[0].status, 'missing_media');
  assert.equal(result.promotedCount, 0);
  assert.equal((await env.closetLibrary.loadCloset('user-a')).length, 0);
  const still = await env.store.getClosetCandidate(req, batch.ids[0]);
  assert.equal(still.candidate.status, 'ready_for_review');
});

test('a candidate pointing outside the candidate media domain is refused', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const batch = await stageBatch(env, req, 1);

  // A record whose media reference is a Recent Scan path rather than its own.
  const foreign = '/doc/kscan_library/images/scan.jpg';
  seedSource(env.m, foreign, 'scan');
  const raw = JSON.parse(
    env.m.files.get('/doc/kscan_closet_candidates/kscan_closet_candidates.json'),
  );
  for (const entry of raw) {
    if (entry.candidateId === batch.ids[0]) entry.candidateImageUri = foreign;
  }
  env.m.files.set(
    '/doc/kscan_closet_candidates/kscan_closet_candidates.json',
    JSON.stringify(raw),
  );

  const result = await promote(env, {
    actorId: 'user-a',
    actorEpoch: req.epoch,
    candidateIds: batch.ids,
  });
  assert.equal(result.results[0].status, 'missing_media');
  assert.equal(result.results[0].errorCode, 'candidate_media_unreadable');
  assert.equal((await env.closetLibrary.loadCloset('user-a')).length, 0);
  // The Recent Scan image is untouched.
  assert.equal(env.m.files.has(foreign), true);
});

test('a future-schema record is refused rather than reinterpreted', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const batch = await stageBatch(env, req, 1);
  const raw = JSON.parse(
    env.m.files.get('/doc/kscan_closet_candidates/kscan_closet_candidates.json'),
  );
  raw[0].schemaVersion = 99;
  env.m.files.set(
    '/doc/kscan_closet_candidates/kscan_closet_candidates.json',
    JSON.stringify(raw),
  );

  const result = await promote(env, {
    actorId: 'user-a',
    actorEpoch: req.epoch,
    candidateIds: batch.ids,
  });
  assert.equal(result.results[0].status, 'ineligible');
  assert.equal((await env.closetLibrary.loadCloset('user-a')).length, 0);
});

// ── Serialization ────────────────────────────────────────────────────────────

test('promotion concurrency is one: eight candidates never overlap', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const batch = await stageBatch(env, req, 8);

  // TWO OVERLAP MEASUREMENTS, because they prove different things.
  //
  // The committed manifest write must never race — but the committed store
  // serializes that on its own, so it would stay at one even if promotion ran in
  // parallel. Media derivation is NOT serialized by anything else, so overlap
  // there is overlap of the promotion sequence itself. Both are measured.
  let inWrite = 0;
  let maxWriteOverlap = 0;
  env.m.hooks.beforeWrite = async (p) => {
    if (!p.startsWith('/doc/kscan_closet/kscan_closet.json')) return;
    inWrite += 1;
    maxWriteOverlap = Math.max(maxWriteOverlap, inWrite);
    await new Promise((resolve) => setTimeout(resolve, 1));
    inWrite -= 1;
  };

  let inSequence = 0;
  let maxSequenceOverlap = 0;
  env.m.hooks.beforeManipulate = async () => {
    inSequence += 1;
    maxSequenceOverlap = Math.max(maxSequenceOverlap, inSequence);
    await new Promise((resolve) => setTimeout(resolve, 1));
    inSequence -= 1;
  };

  const active = [];
  const result = await promote(env, {
    actorId: 'user-a',
    actorEpoch: req.epoch,
    batchId: batch.batchId,
    candidateIds: batch.ids,
    onProgress: () => {
      const running = env.promotion.getActiveClosetPromotion();
      active.push(running ? running.activeCandidateId : null);
    },
  });

  assert.equal(env.promotion.CLOSET_PROMOTION_MAX_CONCURRENCY, 1);
  assert.equal(maxWriteOverlap, 1, 'two committed manifest writes overlapped');
  assert.equal(maxSequenceOverlap, 1, 'two candidate promotions ran at the same time');
  assert.equal(result.promotedCount, 8);
  assert.equal((await env.closetLibrary.loadCloset('user-a')).length, 8);
  // Never more than one candidate is the active one, and the operation clears.
  assert.ok(active.every((id) => id === null || typeof id === 'string'));
  assert.equal(env.promotion.getActiveClosetPromotion(), null);
});

test('a second submission while one is running is refused, not queued', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const batch = await stageBatch(env, req, 3);

  let second = null;
  const first = await promote(env, {
    actorId: 'user-a',
    actorEpoch: req.epoch,
    batchId: batch.batchId,
    candidateIds: batch.ids,
    onProgress: async () => {
      if (second) return;
      // The double tap, landing mid-operation.
      second = await promote(env, {
        actorId: 'user-a',
        actorEpoch: req.epoch,
        batchId: batch.batchId,
        candidateIds: batch.ids,
      });
    },
  });

  assert.equal(first.promotedCount, 3);
  assert.ok(second);
  assert.equal(second.ok, false);
  assert.equal(second.alreadyRunning, true);
  assert.equal(second.results.length, 0);
  assert.equal((await env.closetLibrary.loadCloset('user-a')).length, 3);
});

test('the submitted snapshot is immutable: a later selection change cannot alter it', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const batch = await stageBatch(env, req, 3);

  const submitted = [batch.ids[0], batch.ids[1]];
  const result = await promote(env, {
    actorId: 'user-a',
    actorEpoch: req.epoch,
    batchId: batch.batchId,
    candidateIds: submitted,
    onProgress: () => {
      // The surface mutating the very array it handed over.
      submitted.push(batch.ids[2]);
      submitted.length = 3;
    },
  });

  assert.equal(result.requestedCount, 2);
  assert.equal(result.results.length, 2);
  assert.ok(!result.results.some((entry) => entry.candidateId === batch.ids[2]));
  const untouched = await env.store.getClosetCandidate(req, batch.ids[2]);
  assert.equal(untouched.candidate.status, 'ready_for_review');
});

// ── Actor safety ─────────────────────────────────────────────────────────────

test('a submission against a stale actor context never starts', async () => {
  const env = load();
  const stale = asActor(env.actorContext, 'user-a');
  const batch = await stageBatch(env, stale, 2);
  env.actorContext.advanceActorEpoch(null);
  env.actorContext.advanceActorEpoch('user-a');

  const result = await promote(env, {
    actorId: 'user-a',
    actorEpoch: stale.epoch,
    batchId: batch.batchId,
    candidateIds: batch.ids,
  });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'candidate_actor_stale');
  assert.equal(result.results.length, 0);
  assert.equal((await env.closetLibrary.loadCloset('user-a')).length, 0);
});

test('an actor change mid-operation stops the queue and preserves earlier successes', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const batch = await stageBatch(env, req, 4);

  const result = await promote(env, {
    actorId: 'user-a',
    actorEpoch: req.epoch,
    batchId: batch.batchId,
    candidateIds: batch.ids,
    onProgress: (event) => {
      // Same user signs out and back in after the first item lands.
      if (event.completedCount !== 1) return;
      env.actorContext.advanceActorEpoch(null);
      env.actorContext.advanceActorEpoch('user-a');
    },
  });

  assert.equal(result.promotedCount, 1);
  assert.deepEqual(statuses(result), ['promoted', 'actor_changed', 'actor_changed', 'actor_changed']);
  // The remaining items were NEVER ATTEMPTED. Reporting them as failures would
  // describe work that did not happen, and would be the operation's own record of
  // a fault the candidates do not have.
  assert.equal(result.notAttemptedCount, 3);
  assert.equal(result.failedCount, 0, 'unattempted candidates were counted as failures');

  // The earlier success is kept — never rolled back — and nothing else was written.
  const items = await env.closetLibrary.loadCloset('user-a');
  assert.equal(items.length, 1);
  assert.equal(items[0].sourceCandidateId, batch.ids[0]);

  const now = asActor(env.actorContext, 'user-a');
  const first = await env.store.getClosetCandidate(now, batch.ids[0]);
  assert.equal(first.candidate.status, 'saved');
  for (const id of batch.ids.slice(1)) {
    const untouched = await env.store.getClosetCandidate(now, id);
    assert.equal(untouched.candidate.status, 'ready_for_review');
    assert.equal(untouched.candidate.errorCode, null, 'an unattempted candidate was failed');
  }
});

// ── Idempotency and interruption ─────────────────────────────────────────────

test('a committed write that landed without finalization is repaired, never duplicated', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const batch = await stageBatch(env, req, 1);

  // Simulate the crash window directly: the committed item exists, the candidate
  // was never finalized.
  const committed = await env.closetLibrary.createClosetItem({
    sourceUri: batch.candidates[0].candidateImageUri,
    draft: {
      title: 'Jacket',
      category: 'Outerwear',
      origin: 'direct_intake',
      sourceCandidateId: batch.ids[0],
    },
    actorRequest: req,
    ownerId: 'user-a',
  });
  assert.equal(committed.ok, true);
  const before = await env.store.getClosetCandidate(req, batch.ids[0]);
  assert.equal(before.candidate.status, 'ready_for_review');

  const result = await promote(env, {
    actorId: 'user-a',
    actorEpoch: req.epoch,
    candidateIds: batch.ids,
  });
  assert.equal(result.results[0].status, 'already_promoted');
  assert.equal(result.results[0].committedClosetItemId, committed.item.id);
  assert.equal(result.alreadyPromotedCount, 1);

  // Exactly one item, one image, and the candidate is now finalized.
  assert.equal((await env.closetLibrary.loadCloset('user-a')).length, 1);
  const after = await env.store.getClosetCandidate(req, batch.ids[0]);
  assert.equal(after.candidate.status, 'saved');
  assert.equal(after.candidate.promotedClosetItemId, committed.item.id);
});

test('a media copy that landed without a committed record reuses its destination', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const batch = await stageBatch(env, req, 1);

  // The other half of the same crash window: media on disk, no manifest entry.
  const assetId = env.closetLibrary.closetPromotionMediaAssetId('user-a', batch.ids[0]);
  const destPath = `/doc/kscan_closet/images/${assetId}.jpg`;
  env.m.files.set(destPath, Buffer.from('partial').toString('base64'));

  const result = await promote(env, {
    actorId: 'user-a',
    actorEpoch: req.epoch,
    candidateIds: batch.ids,
  });
  assert.equal(result.results[0].status, 'promoted');

  const items = await env.closetLibrary.loadCloset('user-a');
  assert.equal(items[0].imageUri, destPath, 'the retry minted a new random destination');
  const closetImages = [...env.m.files.keys()].filter((key) =>
    key.startsWith('/doc/kscan_closet/images/'),
  );
  assert.equal(closetImages.length, 1, 'a second committed image was left behind');
});

test('promoting the same selection twice produces no second item and no second file', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const batch = await stageBatch(env, req, 3);

  const first = await promote(env, {
    actorId: 'user-a',
    actorEpoch: req.epoch,
    batchId: batch.batchId,
    candidateIds: batch.ids,
  });
  assert.equal(first.promotedCount, 3);

  const second = await promote(env, {
    actorId: 'user-a',
    actorEpoch: req.epoch,
    batchId: batch.batchId,
    candidateIds: batch.ids,
  });
  // The candidates are terminal now, so the second pass is refused by eligibility
  // — and crucially it writes nothing.
  assert.equal(second.promotedCount, 0);
  assert.equal((await env.closetLibrary.loadCloset('user-a')).length, 3);
  const closetImages = [...env.m.files.keys()].filter((key) =>
    key.startsWith('/doc/kscan_closet/images/'),
  );
  assert.equal(closetImages.length, 3);
});

test('an actor change detected before the write costs no media work at all', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const batch = await stageBatch(env, req, 1);

  // The actor changes while the candidate's own media is being stat'ed — after
  // eligibility, before anything is committed.
  env.m.hooks.beforeGetInfo = async (p) => {
    if (p !== batch.candidates[0].candidateImageUri) return;
    env.m.hooks.beforeGetInfo = null;
    env.actorContext.advanceActorEpoch(null);
    env.actorContext.advanceActorEpoch('user-a');
  };

  const before = env.calls.manipulate;
  const result = await promote(env, {
    actorId: 'user-a',
    actorEpoch: req.epoch,
    candidateIds: batch.ids,
  });

  assert.equal(result.results[0].status, 'actor_changed');
  assert.equal(
    env.calls.manipulate,
    before,
    'media was derived for a write the actor check had already ruled out',
  );
  assert.equal((await env.closetLibrary.loadCloset('user-a')).length, 0);
});

test('an actor change during committed media derivation aborts before the write', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const batch = await stageBatch(env, req, 1);

  // The epoch flips while the committed store is deriving its copy — after every
  // coordinator checkpoint, inside the store's own critical approach. This is the
  // window the store's post-media re-validation and serialized-section check own.
  env.m.hooks.beforeManipulate = async () => {
    if (env.actorContext.getActorContext().epoch !== req.epoch) return;
    env.actorContext.advanceActorEpoch(null);
    env.actorContext.advanceActorEpoch('user-a');
  };

  const result = await promote(env, {
    actorId: 'user-a',
    actorEpoch: req.epoch,
    candidateIds: batch.ids,
  });

  assert.equal(result.results[0].status, 'actor_changed');
  assert.equal(result.promotedCount, 0);
  assert.equal(
    (await env.closetLibrary.loadCloset('user-a')).length,
    0,
    'a stale actor request committed an item',
  );
  const now = asActor(env.actorContext, 'user-a');
  const candidate = await env.store.getClosetCandidate(now, batch.ids[0]);
  assert.equal(candidate.candidate.status, 'ready_for_review');
  assert.equal(candidate.candidate.promotedClosetItemId, null);
});

test('a committed write that did not land is never reported as a promotion', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const batch = await stageBatch(env, req, 1);

  // The committed manifest write reports success without landing — the exact
  // fault the read-back exists to catch.
  env.m.hooks.beforeWrite = async (p) => {
    if (!p.startsWith('/doc/kscan_closet/kscan_closet.json')) return undefined;
    return 'skip';
  };

  const result = await promote(env, {
    actorId: 'user-a',
    actorEpoch: req.epoch,
    candidateIds: batch.ids,
  });

  assert.equal(result.results[0].status, 'failed');
  assert.equal(result.results[0].committedClosetItemId, null);
  assert.equal(result.promotedCount, 0);
  assert.equal((await env.closetLibrary.loadCloset('user-a')).length, 0);
  // And crucially the candidate was NOT finalized against an item that is not there.
  const candidate = await env.store.getClosetCandidate(req, batch.ids[0]);
  assert.equal(candidate.candidate.status, 'ready_for_review');
  assert.equal(candidate.candidate.promotedClosetItemId, null);
});

test('nothing is finalized before the committed item has been read back', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const batch = await stageBatch(env, req, 1);

  // Order of writes: the committed manifest MUST be written before the candidate
  // manifest records the promotion.
  const order = [];
  env.m.hooks.beforeWrite = async (p, contents) => {
    if (p.startsWith('/doc/kscan_closet/kscan_closet.json')) order.push('committed');
    if (p.startsWith('/doc/kscan_closet_candidates/') && String(contents).includes('"saved"')) {
      order.push('finalized');
    }
  };

  const result = await promote(env, {
    actorId: 'user-a',
    actorEpoch: req.epoch,
    candidateIds: batch.ids,
  });
  assert.equal(result.results[0].status, 'promoted');
  assert.ok(order.includes('committed'));
  assert.ok(order.includes('finalized'));
  assert.ok(
    order.indexOf('committed') < order.indexOf('finalized'),
    'the candidate was finalized before the committed item existed',
  );
});

// ── Partial batch ────────────────────────────────────────────────────────────

test('one item failing never rolls back an earlier one or blocks a later one', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const batch = await stageBatch(env, req, 4);
  // Item 2 loses its media between selection and promotion.
  env.m.files.delete(batch.candidates[1].candidateImageUri);

  const result = await promote(env, {
    actorId: 'user-a',
    actorEpoch: req.epoch,
    batchId: batch.batchId,
    candidateIds: batch.ids,
  });

  assert.deepEqual(statuses(result), ['promoted', 'missing_media', 'promoted', 'promoted']);
  assert.equal(result.promotedCount, 3);
  assert.equal(result.failedCount, 1);

  const items = await env.closetLibrary.loadCloset('user-a');
  assert.equal(items.length, 3);
  // The failed candidate is still a candidate, and still retryable.
  const failed = await env.store.getClosetCandidate(req, batch.ids[1]);
  assert.equal(failed.candidate.status, 'ready_for_review');
  assert.equal(failed.candidate.promotedClosetItemId, null);
});

test('retrying a partial batch does not duplicate the items that already succeeded', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const batch = await stageBatch(env, req, 4);
  env.m.files.delete(batch.candidates[1].candidateImageUri);

  await promote(env, {
    actorId: 'user-a',
    actorEpoch: req.epoch,
    batchId: batch.batchId,
    candidateIds: batch.ids,
  });
  // The user restores the photo and taps again with the whole selection.
  seedSource(env.m, batch.candidates[1].candidateImageUri, 'restored');

  const retry = await promote(env, {
    actorId: 'user-a',
    actorEpoch: req.epoch,
    batchId: batch.batchId,
    candidateIds: batch.ids,
  });

  assert.equal(retry.promotedCount, 1, 'only the previously failed item should promote');
  const items = await env.closetLibrary.loadCloset('user-a');
  assert.equal(items.length, 4);
  const provenance = items.map((item) => item.sourceCandidateId).sort();
  assert.deepEqual(provenance, [...batch.ids].sort());
});

// ── Storage exhaustion ───────────────────────────────────────────────────────

test('insufficient storage stops the dequeue and leaves the rest untouched', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const batch = await stageBatch(env, req, 8);

  let completed = 0;
  const result = await promote(env, {
    actorId: 'user-a',
    actorEpoch: req.epoch,
    batchId: batch.batchId,
    candidateIds: batch.ids,
    onProgress: () => {
      completed += 1;
      // The disk fills after the first item is committed.
      if (completed === 1) env.m.setFreeBytes(1024);
    },
  });

  assert.deepEqual(statuses(result), [
    'promoted',
    'storage_failed',
    'not_attempted_storage_blocked',
    'not_attempted_storage_blocked',
    'not_attempted_storage_blocked',
    'not_attempted_storage_blocked',
    'not_attempted_storage_blocked',
    'not_attempted_storage_blocked',
  ]);
  assert.equal(result.promotedCount, 1);
  assert.equal(result.notAttemptedCount, 6);

  // Item 1 stays promoted; everything else stays exactly reviewable, with no
  // failure persisted on the records that were never attempted.
  assert.equal((await env.closetLibrary.loadCloset('user-a')).length, 1);
  const first = await env.store.getClosetCandidate(req, batch.ids[0]);
  assert.equal(first.candidate.status, 'saved');
  for (const id of batch.ids.slice(1)) {
    const untouched = await env.store.getClosetCandidate(req, id);
    assert.equal(untouched.candidate.status, 'ready_for_review');
    assert.equal(untouched.candidate.errorCode, null);
  }

  // With space free again, a fresh attempt completes the batch.
  env.m.setFreeBytes(10 * 1024 * 1024 * 1024);
  const resumed = await promote(env, {
    actorId: 'user-a',
    actorEpoch: req.epoch,
    batchId: batch.batchId,
    candidateIds: batch.ids,
  });
  assert.equal(resumed.promotedCount, 7);
  assert.equal((await env.closetLibrary.loadCloset('user-a')).length, 8);
});

// ── Lifecycle ────────────────────────────────────────────────────────────────

test('backgrounding before the first item stops all work and fails nothing', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const batch = await stageBatch(env, req, 3);

  const result = await promote(env, {
    actorId: 'user-a',
    actorEpoch: req.epoch,
    batchId: batch.batchId,
    candidateIds: batch.ids,
    shouldContinue: () => false,
  });

  assert.deepEqual(statuses(result), [
    'not_attempted_backgrounded',
    'not_attempted_backgrounded',
    'not_attempted_backgrounded',
  ]);
  assert.equal(result.promotedCount, 0);
  assert.equal((await env.closetLibrary.loadCloset('user-a')).length, 0);
  for (const id of batch.ids) {
    const untouched = await env.store.getClosetCandidate(req, id);
    assert.equal(untouched.candidate.status, 'ready_for_review');
    assert.equal(untouched.candidate.errorCode, null);
  }
});

test('backgrounding between items keeps what landed and never starts the next one', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const batch = await stageBatch(env, req, 4);

  let live = true;
  const result = await promote(env, {
    actorId: 'user-a',
    actorEpoch: req.epoch,
    batchId: batch.batchId,
    candidateIds: batch.ids,
    shouldContinue: () => live,
    onProgress: (event) => {
      if (event.completedCount === 2) live = false;
    },
  });

  assert.deepEqual(statuses(result), [
    'promoted',
    'promoted',
    'not_attempted_backgrounded',
    'not_attempted_backgrounded',
  ]);
  assert.equal((await env.closetLibrary.loadCloset('user-a')).length, 2);
  for (const id of batch.ids.slice(2)) {
    const untouched = await env.store.getClosetCandidate(req, id);
    assert.equal(untouched.candidate.status, 'ready_for_review');
    assert.equal(untouched.candidate.errorCode, null);
  }

  // Foreground does not resume: the user asks again, and it completes.
  live = true;
  const resumed = await promote(env, {
    actorId: 'user-a',
    actorEpoch: req.epoch,
    batchId: batch.batchId,
    candidateIds: batch.ids,
    shouldContinue: () => live,
  });
  assert.equal(resumed.promotedCount, 2);
  assert.equal((await env.closetLibrary.loadCloset('user-a')).length, 4);
});

test('a cancellation predicate that throws cannot abandon a promotion', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const batch = await stageBatch(env, req, 2);

  const result = await promote(env, {
    actorId: 'user-a',
    actorEpoch: req.epoch,
    batchId: batch.batchId,
    candidateIds: batch.ids,
    shouldContinue: () => {
      throw new Error('consumer exploded');
    },
  });
  assert.equal(result.promotedCount, 2);
  assert.equal((await env.closetLibrary.loadCloset('user-a')).length, 2);
});

// ── Progress ─────────────────────────────────────────────────────────────────

test('progress fires after every per-item outcome, in order, before the batch ends', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const batch = await stageBatch(env, req, 8);

  const events = [];
  const committedCountsAtEvent = [];
  await promote(env, {
    actorId: 'user-a',
    actorEpoch: req.epoch,
    batchId: batch.batchId,
    candidateIds: batch.ids,
    onProgress: async (event) => {
      events.push(event);
      committedCountsAtEvent.push((await env.closetLibrary.loadCloset('user-a')).length);
    },
  });

  assert.equal(events.length, 8, 'progress did not fire per item');
  assert.deepEqual(
    events.map((event) => event.completedCount),
    [1, 2, 3, 4, 5, 6, 7, 8],
  );
  assert.deepEqual(
    events.map((event) => event.promotedCount),
    [1, 2, 3, 4, 5, 6, 7, 8],
  );
  // Each event is emitted when that item is genuinely durable, not at the end.
  assert.deepEqual(committedCountsAtEvent, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(
    events.map((event) => event.currentCandidateId),
    batch.ids,
  );
  assert.deepEqual(
    events.map((event) => event.currentBatchPosition),
    [0, 1, 2, 3, 4, 5, 6, 7],
  );
  assert.equal(events.at(-1).done, true);
  assert.equal(events[0].done, false);
  // The next candidate is named so the surface never has to guess.
  assert.equal(events[0].activeCandidateId, batch.ids[1]);
  assert.equal(events.at(-1).activeCandidateId, null);
  assert.equal(events.at(-1).resultsSoFar.length, 8);
});

test('a progress callback that throws does not abort or corrupt the operation', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const batch = await stageBatch(env, req, 3);

  const result = await promote(env, {
    actorId: 'user-a',
    actorEpoch: req.epoch,
    batchId: batch.batchId,
    candidateIds: batch.ids,
    onProgress: () => {
      throw new Error('UI exploded');
    },
  });
  assert.equal(result.promotedCount, 3);
  assert.equal((await env.closetLibrary.loadCloset('user-a')).length, 3);
  assert.equal(env.promotion.getActiveClosetPromotion(), null);
});

// ── Timeout ──────────────────────────────────────────────────────────────────

test('an injected per-candidate deadline stops pre-commit items and frees the queue', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const batch = await stageBatch(env, req, 2);

  // A deadline that has already elapsed by the time each item starts. Injected
  // per candidate — item 2 gets its own, which is the point: one batch-wide
  // budget would make the last item's allowance depend on the first item's speed.
  const result = await promote(env, {
    actorId: 'user-a',
    actorEpoch: req.epoch,
    batchId: batch.batchId,
    candidateIds: batch.ids,
    itemTimeoutMs: -1,
  });

  assert.deepEqual(statuses(result), ['failed', 'failed']);
  for (const entry of result.results) {
    assert.equal(entry.errorCode, 'candidate_request_aborted');
  }
  assert.equal((await env.closetLibrary.loadCloset('user-a')).length, 0);
  // Nothing was committed, nothing was finalized, and both candidates are still
  // exactly where they were.
  for (const id of batch.ids) {
    const still = await env.store.getClosetCandidate(req, id);
    assert.equal(still.candidate.status, 'ready_for_review');
  }
  // The queue is not left holding the mutex.
  assert.equal(env.promotion.getActiveClosetPromotion(), null);

  const retry = await promote(env, {
    actorId: 'user-a',
    actorEpoch: req.epoch,
    batchId: batch.batchId,
    candidateIds: batch.ids,
  });
  assert.equal(retry.promotedCount, 2);
  assert.equal((await env.closetLibrary.loadCloset('user-a')).length, 2);
});

test('a deadline that elapses DURING the committed write still recovers as success', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const batch = await stageBatch(env, req, 1);

  // The committed manifest replacement takes longer than the whole allowance.
  env.m.hooks.beforeWrite = async (p) => {
    if (!p.startsWith('/doc/kscan_closet/kscan_closet.json')) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  };

  const result = await promote(env, {
    actorId: 'user-a',
    actorEpoch: req.epoch,
    batchId: batch.batchId,
    candidateIds: batch.ids,
    itemTimeoutMs: 5,
  });

  // The deadline is a bound on the SEQUENCE, checked at safe boundaries — it can
  // never settle mid-write and turn a durable item into a reported failure.
  assert.equal(result.results[0].status, 'promoted');
  const items = await env.closetLibrary.loadCloset('user-a');
  assert.equal(items.length, 1);
  const candidate = await env.store.getClosetCandidate(req, batch.ids[0]);
  assert.equal(candidate.candidate.status, 'saved');
  assert.equal(candidate.candidate.promotedClosetItemId, items[0].id);
});

test('the per-candidate deadline is a constant, not a hard-coded batch budget', () => {
  const env = load();
  assert.equal(typeof env.contract.CLOSET_PROMOTION_ITEM_TIMEOUT_MS, 'number');
  assert.ok(env.contract.CLOSET_PROMOTION_ITEM_TIMEOUT_MS > 0);
  const source = fs.readFileSync(
    path.join(ROOT, 'services/closetCandidatePromotion.js'),
    'utf8',
  );
  assert.ok(
    !/30\s*\*\s*1000|30000/.test(source),
    'a fixed 30-second timeout was embedded in the coordinator',
  );
  assert.ok(
    source.includes('CLOSET_PROMOTION_ITEM_TIMEOUT_MS'),
    'the coordinator must take its deadline from the injectable constant',
  );
});

// ── Vocabulary ───────────────────────────────────────────────────────────────

test('every reported status belongs to the declared vocabulary', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const batch = await stageBatch(env, req, 2);
  env.m.files.delete(batch.candidates[1].candidateImageUri);

  const result = await promote(env, {
    actorId: 'user-a',
    actorEpoch: req.epoch,
    batchId: batch.batchId,
    candidateIds: batch.ids,
  });
  for (const entry of result.results) {
    assert.ok(
      env.contract.CLOSET_PROMOTION_ITEM_STATUSES.includes(entry.status),
      `unknown status ${entry.status}`,
    );
    if (entry.errorCode) {
      assert.ok(
        env.types.CLOSET_CANDIDATE_ERROR_CODES.includes(entry.errorCode),
        `unregistered error code ${entry.errorCode}`,
      );
    }
  }
});

test('the promotion payload is an allowlist, and drops everything a candidate carries', () => {
  const env = load();
  const draft = env.promotion.buildClosetPromotionDraft(
    {
      candidateId: 'candidate_1',
      category: 'Outerwear',
      clothingType: 'Jacket',
      subtype: 'Bomber',
      brand: 'Acme',
      notes: 'a note',
      status: 'ready_for_review',
      errorCode: 'classification_timeout',
      attemptCount: 3,
      automaticRetryCount: 2,
      interruptionCount: 1,
      expiresAt: '2026-08-01T00:00:00.000Z',
      contentHash: 'abc',
      duplicateMatch: { closetItemId: 'x' },
      confidence: { category: 0.9 },
      purchaseOptions: [{ url: 'https://retailer.example' }],
      price: 100,
      sku: 'SKU-1',
    },
    { clientRequestId: 'req-1' },
  );

  assert.deepEqual(Object.keys(draft).sort(), [
    'category',
    'clientRequestId',
    'notes',
    'origin',
    'sourceCandidateId',
    'title',
  ]);
  assert.equal(draft.sourceCandidateId, 'candidate_1');
  assert.equal(draft.title, 'Acme Bomber');
  assert.equal(draft.origin, 'direct_intake');
  // A candidate with no category is not a promotable payload at all.
  assert.equal(env.promotion.buildClosetPromotionDraft({ candidateId: 'c' }), null);
  assert.equal(env.promotion.buildClosetPromotionDraft(null), null);
});

test('an empty selection is refused without starting an operation', async () => {
  const env = load();
  asActor(env.actorContext, 'user-a');
  for (const ids of [[], null, undefined, ['', '   ']]) {
    const result = await promote(env, { actorId: 'user-a', candidateIds: ids });
    assert.equal(result.ok, false);
    assert.equal(result.results.length, 0);
    assert.equal(env.promotion.getActiveClosetPromotion(), null);
  }
});
