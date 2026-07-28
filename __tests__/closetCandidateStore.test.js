// Closet candidate STORE suite — persistence, actor isolation, media lifecycle,
// exact duplicate collisions, caps, expiration, cleanup and crash recovery.
//
// services/closetCandidateLibrary.js, closetCandidateMedia.js, closetLibrary.js,
// library.js and actorContext.js are transpiled in-process and run against an
// in-memory filesystem, so these exercise the REAL persistence logic with the
// REAL actor context — never a permissive double. The committed Closet store and
// the candidate store share one actorContext instance here, exactly as they do on
// device, so epoch transitions are observed by both.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const DAY_MS = 24 * 60 * 60 * 1000;

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

/**
 * In-memory filesystem.
 *
 * File CONTENT is real base64 so `readAsStringAsync(uri, {encoding: base64})`
 * returns something `base64ByteLength` can measure — which is what lets the exact
 * content-hash tests be about bytes rather than about a mock's return value.
 */
function memfs() {
  const files = new Map();
  const modified = new Map();
  let freeBytes = 10 * 1024 * 1024 * 1024;
  /** Injected faults, keyed by operation, for crash-window tests. */
  const faults = { write: null, move: null };
  const api = {
    documentDirectory: '/doc/',
    EncodingType: { UTF8: 'utf8', Base64: 'base64' },
    async makeDirectoryAsync() {},
    async getInfoAsync(p) {
      if (!files.has(p)) return { exists: false };
      return {
        exists: true,
        size: Buffer.from(files.get(p), 'utf8').length,
        // Seconds, matching expo-file-system.
        modificationTime: (modified.get(p) ?? 0) / 1000,
      };
    },
    async readAsStringAsync(p) {
      if (!files.has(p)) throw new Error('ENOENT');
      return files.get(p);
    },
    async writeAsStringAsync(p, c) {
      if (faults.write) {
        const fault = faults.write;
        faults.write = null;
        // Simulate a torn write: the bytes that landed are NOT the bytes asked
        // for, which is exactly what a force-kill mid-stream leaves behind.
        if (fault.mode === 'truncate') {
          files.set(p, String(c).slice(0, Math.max(1, Math.floor(String(c).length / 2))));
          modified.set(p, Date.now());
          return;
        }
        throw new Error('ENOSPC');
      }
      files.set(p, c);
      modified.set(p, Date.now());
    },
    async moveAsync({ from, to }) {
      if (faults.move) {
        const fault = faults.move;
        // `after` lets a test survive the manifest→backup move and fail only the
        // temp→manifest move, which is the one real crash window in the swap.
        if (fault.after > 0) {
          fault.after -= 1;
        } else {
          faults.move = null;
          throw new Error('EIO');
        }
      }
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
      if (typeof dir !== 'string') throw new Error('EINVAL');
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
    setFreeBytes(next) {
      freeBytes = next;
    },
    removeFreeDiskApi() {
      delete api.getFreeDiskStorageAsync;
    },
    removeReadDirectoryApi() {
      delete api.readDirectoryAsync;
    },
    setModified(p, ms) {
      modified.set(p, ms);
    },
    failNextWrite(mode = 'throw') {
      faults.write = { mode };
    },
    failMoveAfter(n) {
      faults.move = { after: n };
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

function load(platformOS = 'android', options = {}) {
  const m = memfs();
  const crypto = cryptoShim();
  const actorContext = runModule('services/actorContext.js', () => ({}));

  let cacheSeq = 0;
  /**
   * Every manipulate() writes a NEW cache file whose CONTENT is a deterministic
   * function of the source URI and the requested width. Same source + same width
   * therefore produces identical bytes (so the exact-hash duplicate path is
   * genuinely exercised) while a different source produces different bytes.
   */
  const imageManipulator = {
    SaveFormat: { JPEG: 'jpeg' },
    manipulateAsync: async (uri, ops) => {
      if (options.manipulatorFails) throw new Error('manipulate failed');
      if (options.manipulatorReturnsNothing) return { uri: null };
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

  return { m, actorContext, library, closetLibrary, store, media, schema, types, telemetry };
}

function asActor(actorContext, actorId) {
  actorContext.advanceActorEpoch(actorId);
  return actorContext.createActorRequest();
}

/** Seed a picker-owned source file the way a real picker would. */
function seedSource(m, uri, marker = 'original') {
  m.files.set(uri, Buffer.from(`${marker}:${uri}`).toString('base64'));
  return uri;
}

async function stage(env, actorRequest, sourceUri, overrides = {}) {
  return env.store.createClosetCandidate(actorRequest, {
    sourceUri,
    sourceType: 'gallery',
    ownerId: actorRequest?.actorId,
    ...overrides,
  });
}

// ── Create / read ────────────────────────────────────────────────────────────

test('a candidate is created with owned media, a hash, and a 7-day lifetime', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');

  const result = await stage(env, req, '/picker/a.jpg');
  assert.equal(result.kind, 'created');
  const candidate = result.candidate;

  assert.equal(candidate.ownerId, 'user-a');
  assert.equal(candidate.status, 'queued');
  assert.equal(candidate.schemaVersion, 2);
  assert.ok(candidate.candidateId.startsWith('candidate_'));
  assert.ok(candidate.batchId.startsWith('batch_'));
  assert.equal(candidate.contentHashVersion, 'sha256-normalized-v1');
  assert.ok(candidate.contentHash && candidate.contentHash.length > 0);
  assert.ok(candidate.normalizedByteLength > 0);
  assert.equal(
    Date.parse(candidate.expiresAt) - Date.parse(candidate.createdAt),
    7 * DAY_MS,
  );

  // Candidate media lives under the CANDIDATE root, disjoint from both the
  // committed Closet and Recent Scans.
  assert.ok(candidate.candidateImageUri.startsWith('/doc/kscan_closet_candidates/images/'));
  assert.ok(candidate.candidateThumbnailUri.startsWith('/doc/kscan_closet_candidates/thumbnails/'));
  assert.ok(!candidate.candidateImageUri.startsWith('/doc/kscan_closet/images/'));
  assert.ok(!candidate.candidateImageUri.startsWith('/doc/kscan_library/'));

  // The picker-owned original is preserved, never moved or consumed.
  assert.equal(env.m.files.has('/picker/a.jpg'), true);
  assert.equal(candidate.originalImageUri, null);

  // The candidate manifest is its own file.
  assert.equal(env.m.files.has('/doc/kscan_closet_candidates/kscan_closet_candidates.json'), true);
});

test('a single-photo intake still receives a batch id, shared across the batch', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');
  seedSource(env.m, '/picker/b.jpg');

  const batchId = env.schema.createClosetBatchId();
  const a = await stage(env, req, '/picker/a.jpg', { batchId });
  const b = await stage(env, req, '/picker/b.jpg', { batchId });
  assert.equal(a.candidate.batchId, batchId);
  assert.equal(b.candidate.batchId, batchId);

  const listed = await env.store.listClosetCandidatesByBatch(req, batchId);
  assert.equal(listed.candidates.length, 2);
});

test('list and get never expose another actor’s candidates or media', async () => {
  const env = load();
  const reqA = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');
  const a = await stage(env, reqA, '/picker/a.jpg');

  const reqB = asActor(env.actorContext, 'user-b');
  seedSource(env.m, '/picker/b.jpg');
  const b = await stage(env, reqB, '/picker/b.jpg');

  const listedB = await env.store.listClosetCandidates(reqB);
  assert.equal(listedB.candidates.length, 1);
  assert.equal(listedB.candidates[0].candidateId, b.candidate.candidateId);

  // B cannot read, mutate or delete A's record.
  assert.equal((await env.store.getClosetCandidate(reqB, a.candidate.candidateId)).ok, false);
  assert.equal(
    (await env.store.transitionClosetCandidate(reqB, a.candidate.candidateId, { to: 'rejected' })).ok,
    false,
  );
  assert.equal((await env.store.deleteClosetCandidate(reqB, a.candidate.candidateId)).ok, false);

  // A's media is still on disk after B's attempts.
  assert.equal(env.m.files.has(a.candidate.candidateImageUri), true);

  const reqA2 = asActor(env.actorContext, 'user-a');
  const listedA = await env.store.listClosetCandidates(reqA2);
  assert.equal(listedA.candidates.length, 1);
  assert.equal(listedA.candidates[0].candidateId, a.candidate.candidateId);
});

// ── Actor safety ─────────────────────────────────────────────────────────────

test('a stale actor request cannot create, mutate or delete', async () => {
  const env = load();
  const stale = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');
  const created = await stage(env, stale, '/picker/a.jpg');
  assert.equal(created.kind, 'created');

  // Same user signs out and back in: the id is identical, the epoch is not.
  env.actorContext.advanceActorEpoch(null);
  env.actorContext.advanceActorEpoch('user-a');

  seedSource(env.m, '/picker/b.jpg');
  const blocked = await stage(env, stale, '/picker/b.jpg');
  assert.equal(blocked.kind, 'rejected');
  assert.equal(blocked.code, 'candidate_actor_stale');

  const patch = await env.store.updateClosetCandidate(stale, created.candidate.candidateId, {
    notes: 'x',
  });
  assert.equal(patch.ok, false);
  assert.equal(patch.errorCode, 'candidate_actor_stale');
});

test('a missing actor request is rejected as candidate_actor_required', async () => {
  const env = load();
  seedSource(env.m, '/picker/a.jpg');
  const result = await stage(env, undefined, '/picker/a.jpg');
  assert.equal(result.kind, 'rejected');
  assert.equal(result.code, 'candidate_actor_required');
});

test('Android rejects a signed-out durable candidate write', async () => {
  const env = load('android');
  const req = asActor(env.actorContext, null);
  seedSource(env.m, '/picker/a.jpg');
  const result = await stage(env, req, '/picker/a.jpg', { ownerId: null });
  assert.equal(result.kind, 'rejected');
  assert.equal(result.code, 'candidate_actor_required');
});

test('iOS keeps its durable ownerless partition', async () => {
  const env = load('ios');
  const req = asActor(env.actorContext, null);
  seedSource(env.m, '/picker/a.jpg');
  const result = await stage(env, req, '/picker/a.jpg', { ownerId: null });
  assert.equal(result.kind, 'created');
  assert.equal(result.candidate.ownerId, null);

  // The ownerless partition is still a partition: an authenticated actor must
  // not see it.
  const authed = asActor(env.actorContext, 'user-a');
  const listed = await env.store.listClosetCandidates(authed);
  assert.equal(listed.candidates.length, 0);
});

test('an actor switch DURING media work rejects the write and cleans its media', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');

  const before = env.m.files.size;
  // Flip the epoch after the request was captured but before it commits by
  // driving the transition between the capture and the call.
  const promise = env.store.createClosetCandidate(req, {
    sourceUri: '/picker/a.jpg',
    sourceType: 'gallery',
    ownerId: 'user-a',
  });
  env.actorContext.advanceActorEpoch('user-b');
  const result = await promise;

  assert.equal(result.kind, 'rejected');
  assert.equal(result.code, 'candidate_actor_stale');
  // No orphan candidate media survives the rejection.
  const orphans = [...env.m.files.keys()].filter((p) =>
    p.startsWith('/doc/kscan_closet_candidates/images/'),
  );
  assert.deepEqual(orphans, []);
  assert.ok(env.m.files.size <= before + 1);
  assert.equal(env.m.files.has('/picker/a.jpg'), true);
});

// ── Protected fields ─────────────────────────────────────────────────────────

test('a patch naming any protected field is rejected outright, not silently dropped', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');
  const created = await stage(env, req, '/picker/a.jpg');
  const id = created.candidate.candidateId;

  for (const field of env.store.CLOSET_CANDIDATE_PROTECTED_FIELDS) {
    const result = await env.store.updateClosetCandidate(req, id, { [field]: 'hostile' });
    assert.equal(result.ok, false, field);
    assert.equal(result.errorCode, 'candidate_invalid_transition', field);
  }

  const after = await env.store.getClosetCandidate(req, id);
  assert.equal(after.candidate.ownerId, 'user-a');
  assert.equal(after.candidate.expiresAt, created.candidate.expiresAt);
  assert.equal(after.candidate.candidateImageUri, created.candidate.candidateImageUri);
});

test('an approved patch updates metadata and preserves ownership and lifetime', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');
  const created = await stage(env, req, '/picker/a.jpg');

  const patched = await env.store.updateClosetCandidate(req, created.candidate.candidateId, {
    category: 'Outerwear',
    subtype: 'Trench coat',
    notes: 'winter',
  });
  assert.equal(patched.ok, true);
  assert.equal(patched.candidate.category, 'Outerwear');
  assert.equal(patched.candidate.subtype, 'Trench coat');
  assert.equal(patched.candidate.ownerId, 'user-a');
  assert.equal(patched.candidate.expiresAt, created.candidate.expiresAt);
  assert.equal(patched.candidate.createdAt, created.candidate.createdAt);
});

// ── Transitions ──────────────────────────────────────────────────────────────

test('the store refuses an illegal transition', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');
  const created = await stage(env, req, '/picker/a.jpg');
  const id = created.candidate.candidateId;

  const illegal = await env.store.transitionClosetCandidate(req, id, { to: 'saved' });
  assert.equal(illegal.ok, false);
  assert.equal(illegal.errorCode, 'candidate_invalid_transition');

  const legal = await env.store.transitionClosetCandidate(req, id, { to: 'classifying' });
  assert.equal(legal.ok, true);
  assert.equal(legal.candidate.status, 'classifying');
});

test('attempt bookkeeping increments only when an attempt is declared', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');
  const id = (await stage(env, req, '/picker/a.jpg')).candidate.candidateId;

  const classifying = await env.store.transitionClosetCandidate(req, id, {
    to: 'classifying',
    attempt: 'automatic',
  });
  assert.equal(classifying.candidate.attemptCount, 1);
  // The first automatic attempt is not a RETRY.
  assert.equal(classifying.candidate.automaticRetryCount, 0);

  const failed = await env.store.transitionClosetCandidate(req, id, {
    to: 'failed',
    errorCode: 'classification_timeout',
  });
  assert.equal(failed.candidate.attemptCount, 1);
  assert.equal(failed.candidate.errorCode, 'classification_timeout');
});

test('manual retry does not reset createdAt, expiresAt or interruptionCount', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');
  const created = await stage(env, req, '/picker/a.jpg');
  const id = created.candidate.candidateId;

  await env.store.transitionClosetCandidate(req, id, { to: 'classifying', attempt: 'automatic' });
  await env.store.transitionClosetCandidate(req, id, {
    to: 'failed',
    errorCode: 'classification_timeout',
  });

  const retried = await env.store.retryClosetCandidate(req, id);
  assert.equal(retried.ok, true);
  assert.equal(retried.candidate.status, 'queued');
  assert.equal(retried.candidate.createdAt, created.candidate.createdAt);
  assert.equal(retried.candidate.expiresAt, created.candidate.expiresAt);
  assert.equal(retried.candidate.interruptionCount, created.candidate.interruptionCount);
  // The full retry history is preserved, not rewound.
  assert.equal(retried.candidate.attemptCount, 2);
  assert.equal(retried.candidate.automaticRetryCount, 0);
});

test('the automatic retry ledger counts retries, not the first attempt', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');
  const id = (await stage(env, req, '/picker/a.jpg')).candidate.candidateId;

  const expected = [
    // [attemptCount after start, automaticRetryCount after start]
    [1, 0],
    [2, 1],
    [3, 2],
  ];
  for (const [attemptCount, automaticRetryCount] of expected) {
    const started = await env.store.transitionClosetCandidate(req, id, {
      to: 'classifying',
      attempt: 'automatic',
    });
    assert.equal(started.candidate.attemptCount, attemptCount);
    assert.equal(started.candidate.automaticRetryCount, automaticRetryCount);
    await env.store.transitionClosetCandidate(req, id, {
      to: 'failed',
      errorCode: 'classification_timeout',
    });
    await env.store.transitionClosetCandidate(req, id, { to: 'queued' });
  }
});

// ── Exact duplicate collisions ───────────────────────────────────────────────

test('the same photo twice returns the EXISTING candidate and no second media copy', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');

  const first = await stage(env, req, '/picker/a.jpg');
  assert.equal(first.kind, 'created');
  const mediaAfterFirst = [...env.m.files.keys()].filter((p) =>
    p.startsWith('/doc/kscan_closet_candidates/'),
  ).length;

  const second = await stage(env, req, '/picker/a.jpg');
  assert.equal(second.kind, 'deduped_candidate');
  assert.equal(second.code, 'duplicate_active_candidate');
  assert.equal(second.candidate.candidateId, first.candidate.candidateId);

  const listed = await env.store.listClosetCandidates(req);
  assert.equal(listed.candidates.length, 1);

  // The redundant media the second attempt created was cleaned up.
  const mediaAfterSecond = [...env.m.files.keys()].filter((p) =>
    p.startsWith('/doc/kscan_closet_candidates/'),
  ).length;
  assert.equal(mediaAfterSecond, mediaAfterFirst);
  // The survivor's own media is untouched.
  assert.equal(env.m.files.has(first.candidate.candidateImageUri), true);
  assert.equal(env.m.files.has(first.candidate.candidateThumbnailUri), true);
});

test('different bytes are never deduplicated', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');
  seedSource(env.m, '/picker/b.jpg');

  const a = await stage(env, req, '/picker/a.jpg');
  const b = await stage(env, req, '/picker/b.jpg');
  assert.equal(a.kind, 'created');
  assert.equal(b.kind, 'created');
  assert.notEqual(a.candidate.contentHash, b.candidate.contentHash);
  assert.equal((await env.store.listClosetCandidates(req)).candidates.length, 2);
});

test('a RESOLVED candidate does not suppress a new intake of the same photo', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');
  const first = await stage(env, req, '/picker/a.jpg');
  await env.store.rejectClosetCandidate(req, first.candidate.candidateId);

  const second = await stage(env, req, '/picker/a.jpg');
  assert.equal(second.kind, 'created');
  assert.notEqual(second.candidate.candidateId, first.candidate.candidateId);
});

test('the same photo staged by two different actors creates two candidates', async () => {
  const env = load();
  seedSource(env.m, '/picker/a.jpg');
  const reqA = asActor(env.actorContext, 'user-a');
  const a = await stage(env, reqA, '/picker/a.jpg');
  const reqB = asActor(env.actorContext, 'user-b');
  const b = await stage(env, reqB, '/picker/a.jpg');

  assert.equal(a.kind, 'created');
  assert.equal(b.kind, 'created');
  // Identical bytes, different owners — dedupe is per actor, never global.
  assert.equal(a.candidate.contentHash, b.candidate.contentHash);
  assert.notEqual(a.candidate.candidateId, b.candidate.candidateId);
});

test('a source lineage already committed to the Closet returns the Closet item', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/scan.jpg');

  const committed = await env.closetLibrary.createClosetItem({
    sourceUri: '/picker/scan.jpg',
    draft: { title: 'Coat', origin: 'recent_scan', sourceLineageId: 'local:scan-1' },
    actorRequest: req,
    ownerId: 'user-a',
  });
  assert.equal(committed.ok, true);

  const result = await stage(env, req, '/picker/scan.jpg', { sourceLineageId: 'local:scan-1' });
  assert.equal(result.kind, 'already_in_closet');
  assert.equal(result.code, 'already_in_closet');
  assert.equal(result.closetItemId, committed.item.id);

  // No candidate was created and no candidate media was written.
  assert.equal((await env.store.listClosetCandidates(req)).candidates.length, 0);
  assert.deepEqual(
    [...env.m.files.keys()].filter((p) => p.startsWith('/doc/kscan_closet_candidates/images/')),
    [],
  );
});

test('an exact hash match with a committed Closet item stages in duplicate, never classifies', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');

  // Stage once to learn the exact signature this source produces, then seed a
  // committed Closet item carrying it. (Committed items carry no hash today;
  // Build 1 does not migrate the committed schema, so this is the forward path.)
  const probe = await stage(env, req, '/picker/a.jpg');
  const signature = {
    contentHash: probe.candidate.contentHash,
    contentHashVersion: probe.candidate.contentHashVersion,
    normalizedByteLength: probe.candidate.normalizedByteLength,
  };
  await env.store.deleteClosetCandidate(req, probe.candidate.candidateId);

  const committed = await env.closetLibrary.createClosetItem({
    sourceUri: '/picker/a.jpg',
    draft: { title: 'Coat' },
    actorRequest: req,
    ownerId: 'user-a',
  });
  const raw = JSON.parse(env.m.files.get('/doc/kscan_closet/kscan_closet.json'));
  raw[0] = { ...raw[0], ...signature };
  env.m.files.set('/doc/kscan_closet/kscan_closet.json', JSON.stringify(raw));

  const result = await stage(env, req, '/picker/a.jpg');
  assert.equal(result.kind, 'duplicate_of_closet');
  assert.equal(result.candidate.status, 'duplicate');
  assert.equal(result.candidate.duplicateMatch.closetItemId, committed.item.id);
  assert.equal(result.candidate.duplicateMatch.algorithmVersion, 'sha256-normalized-v1');
  assert.deepEqual(result.candidate.duplicateMatch.reasons, ['exact_normalized_bytes']);

  // `duplicate` cannot advance to classification.
  const blocked = await env.store.transitionClosetCandidate(
    req,
    result.candidate.candidateId,
    { to: 'classifying' },
  );
  assert.equal(blocked.ok, false);
  assert.equal(blocked.errorCode, 'candidate_invalid_transition');
});

test('a hash match with a disagreeing byte length fails closed and deletes nothing', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');

  const first = await stage(env, req, '/picker/a.jpg');
  // Corrupt the stored byte length so the digest agrees but the metadata does not.
  const raw = JSON.parse(
    env.m.files.get('/doc/kscan_closet_candidates/kscan_closet_candidates.json'),
  );
  raw[0] = { ...raw[0], normalizedByteLength: (raw[0].normalizedByteLength ?? 0) + 17 };
  env.m.files.set(
    '/doc/kscan_closet_candidates/kscan_closet_candidates.json',
    JSON.stringify(raw),
  );

  const second = await stage(env, req, '/picker/a.jpg');
  // NOT deduplicated: a suspicious signature must never suppress the user's item.
  assert.equal(second.kind, 'created');
  assert.notEqual(second.candidate.candidateId, first.candidate.candidateId);
  // Neither the source nor the first candidate's media was destroyed.
  assert.equal(env.m.files.has('/picker/a.jpg'), true);
  assert.equal(env.m.files.has(first.candidate.candidateImageUri), true);
});

// ── Caps and storage ─────────────────────────────────────────────────────────

test('the 40 unresolved cap refuses intake and evicts nothing', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  for (let i = 0; i < 40; i += 1) seedSource(env.m, `/picker/${i}.jpg`);
  for (let i = 0; i < 40; i += 1) {
    const result = await stage(env, req, `/picker/${i}.jpg`);
    assert.equal(result.kind, 'created', `intake ${i}`);
  }
  seedSource(env.m, '/picker/over.jpg');
  const over = await stage(env, req, '/picker/over.jpg');
  assert.equal(over.kind, 'rejected');
  assert.equal(over.code, 'candidate_limit_reached');

  const listed = await env.store.listClosetCandidates(req);
  assert.equal(listed.candidates.length, 40, 'nothing was evicted');
  // No orphan media from the refused intake.
  assert.equal(env.m.files.has('/picker/over.jpg'), true);
});

test('resolving a candidate frees a cap slot', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  for (let i = 0; i < 40; i += 1) seedSource(env.m, `/picker/${i}.jpg`);
  const created = [];
  for (let i = 0; i < 40; i += 1) created.push(await stage(env, req, `/picker/${i}.jpg`));

  await env.store.rejectClosetCandidate(req, created[0].candidate.candidateId);
  seedSource(env.m, '/picker/next.jpg');
  const next = await stage(env, req, '/picker/next.jpg');
  assert.equal(next.kind, 'created');
});

test('insufficient free storage refuses intake before any media is written', async () => {
  const env = load();
  env.m.setFreeBytes(5 * 1024 * 1024); // below the 100 MB floor
  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');

  const result = await stage(env, req, '/picker/a.jpg');
  assert.equal(result.kind, 'rejected');
  assert.equal(result.code, 'candidate_storage_insufficient');
  assert.deepEqual(
    [...env.m.files.keys()].filter((p) => p.startsWith('/doc/kscan_closet_candidates/images/')),
    [],
  );
});

test('when free space cannot be inspected, intake proceeds under the caps instead', async () => {
  const env = load();
  env.m.removeFreeDiskApi();
  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');
  const result = await stage(env, req, '/picker/a.jpg');
  assert.equal(result.kind, 'created');
});

test('a missing or oversized source is refused with the right code', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');

  const missing = await stage(env, req, '/picker/nope.jpg');
  assert.equal(missing.kind, 'rejected');
  assert.equal(missing.code, 'candidate_media_unreadable');

  // > 20 MB source.
  env.m.files.set('/picker/huge.jpg', 'A'.repeat(21 * 1024 * 1024));
  const huge = await stage(env, req, '/picker/huge.jpg');
  assert.equal(huge.kind, 'rejected');
  assert.equal(huge.code, 'candidate_media_unsupported');

  const blank = await stage(env, req, '   ');
  assert.equal(blank.kind, 'rejected');
  assert.equal(blank.code, 'candidate_media_unreadable');
});

test('a failing manipulator and a null manipulator output both fail safely', async () => {
  for (const options of [{ manipulatorFails: true }, { manipulatorReturnsNothing: true }]) {
    const env = load('android', options);
    const req = asActor(env.actorContext, 'user-a');
    seedSource(env.m, '/picker/a.jpg');
    const result = await stage(env, req, '/picker/a.jpg');
    assert.equal(result.kind, 'rejected', JSON.stringify(options));
    assert.equal(result.code, 'candidate_media_normalization_failed');
    // No partial candidate media is left behind.
    assert.deepEqual(
      [...env.m.files.keys()].filter((p) => p.startsWith('/doc/kscan_closet_candidates/images/')),
      [],
    );
    assert.equal(env.m.files.has('/picker/a.jpg'), true);
  }
});

test('platform URI forms are accepted as sources', async () => {
  for (const uri of [
    'file:///var/mobile/Containers/Data/Application/ABC/tmp/IMG_0001.HEIC.jpg',
    'ph://ABCDEF-1234-5678',
    'content://media/external/images/media/1234',
  ]) {
    const env = load();
    const req = asActor(env.actorContext, 'user-a');
    seedSource(env.m, uri);
    const result = await stage(env, req, uri);
    assert.equal(result.kind, 'created', uri);
    assert.equal(result.candidate.originalImageUri, null);
    assert.equal(env.m.files.has(uri), true, `${uri} must not be consumed`);
  }
});

// ── Expiration and cleanup ───────────────────────────────────────────────────

test('an expired candidate is invisible, unmutable and swept', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');
  const created = await stage(env, req, '/picker/a.jpg');
  const id = created.candidate.candidateId;
  const future = Date.parse(created.candidate.expiresAt) + 1000;

  assert.equal((await env.store.listClosetCandidates(req, { nowMs: future })).candidates.length, 0);
  const retried = await env.store.retryClosetCandidate(req, id, { nowMs: future });
  assert.equal(retried.ok, false);
  assert.equal(retried.errorCode, 'candidate_expired');

  const swept = await env.store.cleanupExpiredClosetCandidates(req, { nowMs: future });
  assert.equal(swept.ok, true);
  assert.equal(swept.removed, 1);
  assert.equal(env.m.files.has(created.candidate.candidateImageUri), false);
  assert.equal(env.m.files.has(created.candidate.candidateThumbnailUri), false);
  // The picker-owned original is never a cleanup target.
  assert.equal(env.m.files.has('/picker/a.jpg'), true);

  // Idempotent.
  const again = await env.store.cleanupExpiredClosetCandidates(req, { nowMs: future });
  assert.equal(again.ok, true);
  assert.equal(again.removed, 0);
});

test('a metadata edit does not extend expiration', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');
  const created = await stage(env, req, '/picker/a.jpg');
  const later = Date.parse(created.candidate.createdAt) + 3 * DAY_MS;

  const patched = await env.store.updateClosetCandidate(
    req,
    created.candidate.candidateId,
    { notes: 'still deciding' },
    { nowMs: later },
  );
  assert.equal(patched.candidate.expiresAt, created.candidate.expiresAt);
});

test('cleanup never touches committed Closet or Recent Scan media', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');
  seedSource(env.m, '/picker/scan.jpg');

  const closetItem = await env.closetLibrary.createClosetItem({
    sourceUri: '/picker/scan.jpg',
    draft: { title: 'Coat' },
    actorRequest: req,
    ownerId: 'user-a',
  });
  const saved = await env.library.saveScan({
    photoUri: '/picker/scan.jpg',
    analysis: { result: 'Coat', metadata: { category: 'Outerwear' } },
    source: 'camera',
    actorRequest: req,
  });

  const created = await stage(env, req, '/picker/a.jpg');
  const future = Date.parse(created.candidate.expiresAt) + 1000;
  await env.store.cleanupExpiredClosetCandidates(req, { nowMs: future });

  assert.equal(env.m.files.has(closetItem.item.imageUri), true);
  assert.equal(env.m.files.has(closetItem.item.thumbnailUri), true);
  const savedScan = saved.scan ?? saved.item ?? saved;
  if (savedScan?.imageUri) assert.equal(env.m.files.has(savedScan.imageUri), true);
});

test('candidate cleanup structurally refuses a non-candidate path', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/scan.jpg');
  const closetItem = await env.closetLibrary.createClosetItem({
    sourceUri: '/picker/scan.jpg',
    draft: { title: 'Coat' },
    actorRequest: req,
    ownerId: 'user-a',
  });

  // Hand the candidate unlinker a committed-Closet path and a picker path
  // directly. Both must be dropped, not deleted.
  const failures = await env.media.unlinkUnreferencedCandidateMedia(
    [closetItem.item.imageUri, '/picker/scan.jpg', '/doc/kscan_library/images/x.jpg'],
    [],
  );
  assert.deepEqual(failures, []);
  assert.equal(env.m.files.has(closetItem.item.imageUri), true);
  assert.equal(env.m.files.has('/picker/scan.jpg'), true);
  assert.equal(env.media.isCandidateOwnedPath(closetItem.item.imageUri), false);
  assert.equal(env.media.isCandidateOwnedPath('/doc/kscan_closet_candidates/images/x.jpg'), true);
});

test('a shared media reference is not unlinked from under a surviving candidate', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');
  const created = await stage(env, req, '/picker/a.jpg');

  const failures = await env.media.unlinkUnreferencedCandidateMedia(
    [created.candidate.candidateImageUri, created.candidate.candidateThumbnailUri],
    [created.candidate],
  );
  assert.deepEqual(failures, []);
  assert.equal(env.m.files.has(created.candidate.candidateImageUri), true);
  assert.equal(env.m.files.has(created.candidate.candidateThumbnailUri), true);
});

test('rejection releases candidate media but preserves the original', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');
  const created = await stage(env, req, '/picker/a.jpg');

  const rejected = await env.store.rejectClosetCandidate(req, created.candidate.candidateId);
  assert.equal(rejected.ok, true);
  assert.equal(rejected.candidate.status, 'rejected');
  assert.equal(env.m.files.has(created.candidate.candidateImageUri), false);
  assert.equal(env.m.files.has(created.candidate.candidateThumbnailUri), false);
  assert.equal(env.m.files.has('/picker/a.jpg'), true);
  // The surviving record must not point at files that no longer exist.
  assert.equal(rejected.candidate.candidateImageUri, null);
  assert.equal(rejected.candidate.candidateThumbnailUri, null);
});

test('batch deletion removes only the captured actor’s records in that batch', async () => {
  const env = load();
  const reqA = asActor(env.actorContext, 'user-a');
  const batchId = env.schema.createClosetBatchId();
  seedSource(env.m, '/picker/a1.jpg');
  seedSource(env.m, '/picker/a2.jpg');
  await stage(env, reqA, '/picker/a1.jpg', { batchId });
  await stage(env, reqA, '/picker/a2.jpg', { batchId });

  const reqB = asActor(env.actorContext, 'user-b');
  seedSource(env.m, '/picker/b1.jpg');
  const b = await stage(env, reqB, '/picker/b1.jpg', { batchId });

  const deleted = await env.store.deleteClosetCandidateBatch(reqB, batchId);
  assert.equal(deleted.removed, 1);

  const reqA2 = asActor(env.actorContext, 'user-a');
  assert.equal((await env.store.listClosetCandidates(reqA2)).candidates.length, 2);
  assert.equal(env.m.files.has(b.candidate.candidateImageUri), false);
});

// ── Corruption and recovery ──────────────────────────────────────────────────

test('a corrupt manifest is reported empty and is never truncated on disk', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  env.m.files.set('/doc/kscan_closet_candidates/kscan_closet_candidates.json', '{not json');

  const listed = await env.store.listClosetCandidates(req);
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.candidates, []);
  assert.equal(
    env.m.files.get('/doc/kscan_closet_candidates/kscan_closet_candidates.json'),
    '{not json',
  );
});

test('one unreadable record is skipped without blocking the rest of the store', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');
  const good = await stage(env, req, '/picker/a.jpg');

  const raw = JSON.parse(
    env.m.files.get('/doc/kscan_closet_candidates/kscan_closet_candidates.json'),
  );
  raw.push({ schemaVersion: 99, candidateId: 'candidate_future' });
  raw.push(null);
  raw.push({ nonsense: true });
  env.m.files.set(
    '/doc/kscan_closet_candidates/kscan_closet_candidates.json',
    JSON.stringify(raw),
  );

  const listed = await env.store.listClosetCandidates(req);
  assert.equal(listed.ok, true);
  assert.equal(listed.candidates.length, 1);
  assert.equal(listed.candidates[0].candidateId, good.candidate.candidateId);
});

test('a corrupt candidate manifest never prevents the committed Closet from loading', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/scan.jpg');
  await env.closetLibrary.createClosetItem({
    sourceUri: '/picker/scan.jpg',
    draft: { title: 'Coat' },
    actorRequest: req,
    ownerId: 'user-a',
  });
  env.m.files.set('/doc/kscan_closet_candidates/kscan_closet_candidates.json', 'garbage');

  const closet = await env.closetLibrary.loadCloset('user-a');
  assert.equal(closet.length, 1);

  // The sweep now FAILS CLOSED on an unreadable manifest instead of proceeding.
  // Proceeding would have rewritten the manifest from the empty record set the
  // read was able to produce, destroying whatever the corrupt bytes still held.
  const swept = await env.store.cleanupExpiredClosetCandidates(req);
  assert.equal(swept.ok, false);
  assert.equal(swept.errorCode, 'candidate_store_recovery_required');

  // The corrupt bytes are still on disk, untouched — recovery is still possible.
  assert.equal(
    env.m.files.get('/doc/kscan_closet_candidates/kscan_closet_candidates.json'),
    'garbage',
  );
  // And the invariant this test is named for holds regardless.
  assert.equal((await env.closetLibrary.loadCloset('user-a')).length, 1);
});

test('the first interruption requeues; the second fails permanently', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');
  const created = await stage(env, req, '/picker/a.jpg');
  const id = created.candidate.candidateId;

  // Simulate a process death mid-classification.
  await env.store.transitionClosetCandidate(req, id, { to: 'classifying', attempt: 'automatic' });
  const first = await env.store.recoverInterruptedClosetCandidates(req);
  assert.equal(first.requeued, 1);
  assert.equal(first.failed, 0);
  let now = (await env.store.getClosetCandidate(req, id)).candidate;
  assert.equal(now.status, 'queued');
  assert.equal(now.interruptionCount, 1);
  assert.equal(now.errorCode, 'classification_interrupted');

  // Second death.
  await env.store.transitionClosetCandidate(req, id, { to: 'classifying', attempt: 'automatic' });
  const second = await env.store.recoverInterruptedClosetCandidates(req);
  assert.equal(second.requeued, 0);
  assert.equal(second.failed, 1);
  now = (await env.store.getClosetCandidate(req, id)).candidate;
  assert.equal(now.status, 'failed');
  assert.equal(now.interruptionCount, 2);
  assert.equal(now.errorCode, 'classification_interrupted_repeatedly');

  // No infinite startup loop: a further recovery pass does nothing.
  const third = await env.store.recoverInterruptedClosetCandidates(req);
  assert.equal(third.requeued, 0);
  assert.equal(third.failed, 0);

  // Manual retry remains available until expiration.
  const retried = await env.store.retryClosetCandidate(req, id);
  assert.equal(retried.ok, true);
  assert.equal(retried.candidate.status, 'queued');
  assert.equal(retried.candidate.interruptionCount, 2, 'interruption history is preserved');
});

test('recovery leaves non-classifying and expired candidates alone', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');
  seedSource(env.m, '/picker/b.jpg');
  const ready = await stage(env, req, '/picker/a.jpg');
  const stuck = await stage(env, req, '/picker/b.jpg');

  await env.store.transitionClosetCandidate(req, ready.candidate.candidateId, {
    to: 'classifying',
  });
  await env.store.transitionClosetCandidate(req, ready.candidate.candidateId, {
    to: 'ready_for_review',
  });
  await env.store.transitionClosetCandidate(req, stuck.candidate.candidateId, {
    to: 'classifying',
  });

  const expiredAt = Date.parse(stuck.candidate.expiresAt) + 1000;
  const recovered = await env.store.recoverInterruptedClosetCandidates(req, { nowMs: expiredAt });
  assert.equal(recovered.requeued, 0);
  assert.equal(recovered.failed, 0);

  const stillReady = await env.store.getClosetCandidate(req, ready.candidate.candidateId);
  assert.equal(stillReady.candidate.status, 'ready_for_review');
});

test('records survive a simulated process restart with state intact', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');
  seedSource(env.m, '/picker/b.jpg');
  seedSource(env.m, '/picker/c.jpg');

  const ready = await stage(env, req, '/picker/a.jpg');
  const manual = await stage(env, req, '/picker/b.jpg');
  const failed = await stage(env, req, '/picker/c.jpg');

  await env.store.transitionClosetCandidate(req, ready.candidate.candidateId, { to: 'classifying' });
  await env.store.transitionClosetCandidate(req, ready.candidate.candidateId, {
    to: 'ready_for_review',
  });
  await env.store.transitionClosetCandidate(req, manual.candidate.candidateId, { to: 'classifying' });
  await env.store.transitionClosetCandidate(req, manual.candidate.candidateId, {
    to: 'needs_manual_classification',
    errorCode: 'classification_requires_manual_category',
  });
  await env.store.transitionClosetCandidate(req, failed.candidate.candidateId, { to: 'classifying' });
  await env.store.transitionClosetCandidate(req, failed.candidate.candidateId, {
    to: 'failed',
    errorCode: 'classification_timeout',
  });

  // "Restart": rebuild the whole module graph over the SAME filesystem contents.
  const restarted = load();
  for (const [key, value] of env.m.files) restarted.m.files.set(key, value);
  const req2 = asActor(restarted.actorContext, 'user-a');
  const listed = await restarted.store.listClosetCandidates(req2);
  const byId = new Map(listed.candidates.map((c) => [c.candidateId, c]));

  assert.equal(byId.get(ready.candidate.candidateId).status, 'ready_for_review');
  assert.equal(byId.get(manual.candidate.candidateId).status, 'needs_manual_classification');
  assert.equal(byId.get(manual.candidate.candidateId).errorCode, 'classification_requires_manual_category');
  assert.equal(byId.get(failed.candidate.candidateId).status, 'failed');
  assert.equal(byId.get(failed.candidate.candidateId).errorCode, 'classification_timeout');
});

// ── Serialization ────────────────────────────────────────────────────────────

test('concurrent intakes of distinct photos all commit without losing a record', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  for (let i = 0; i < 12; i += 1) seedSource(env.m, `/picker/c${i}.jpg`);

  const results = await Promise.all(
    Array.from({ length: 12 }, (_, i) => stage(env, req, `/picker/c${i}.jpg`)),
  );
  assert.equal(results.filter((r) => r.kind === 'created').length, 12);
  const listed = await env.store.listClosetCandidates(req);
  assert.equal(listed.candidates.length, 12);
  assert.equal(new Set(listed.candidates.map((c) => c.candidateId)).size, 12);
});

test('concurrent mutations on one candidate serialize rather than interleave', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');
  const id = (await stage(env, req, '/picker/a.jpg')).candidate.candidateId;

  const results = await Promise.all([
    env.store.updateClosetCandidate(req, id, { notes: 'one' }),
    env.store.updateClosetCandidate(req, id, { notes: 'two' }),
    env.store.updateClosetCandidate(req, id, { notes: 'three' }),
  ]);
  assert.equal(results.filter((r) => r.ok).length, 3);
  const final = await env.store.getClosetCandidate(req, id);
  assert.ok(['one', 'two', 'three'].includes(final.candidate.notes));
  // Exactly one record, never a duplicated or lost entry.
  assert.equal((await env.store.listClosetCandidates(req)).candidates.length, 1);
});

test('the same photo staged concurrently produces exactly one candidate', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');

  const results = await Promise.all([
    stage(env, req, '/picker/a.jpg'),
    stage(env, req, '/picker/a.jpg'),
    stage(env, req, '/picker/a.jpg'),
  ]);
  const created = results.filter((r) => r.kind === 'created');
  const deduped = results.filter((r) => r.kind === 'deduped_candidate');
  assert.equal(created.length, 1);
  assert.equal(deduped.length, 2);
  for (const entry of deduped) {
    assert.equal(entry.candidate.candidateId, created[0].candidate.candidateId);
    assert.equal(entry.code, 'duplicate_active_candidate');
  }
  assert.equal((await env.store.listClosetCandidates(req)).candidates.length, 1);
});

// ── Owner purge ──────────────────────────────────────────────────────────────

test('the owner purge primitive removes only that owner’s candidates', async () => {
  const env = load();
  const reqA = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');
  const a = await stage(env, reqA, '/picker/a.jpg');
  const reqB = asActor(env.actorContext, 'user-b');
  seedSource(env.m, '/picker/b.jpg');
  const b = await stage(env, reqB, '/picker/b.jpg');

  const purged = await env.store.purgeLocalClosetCandidatesForOwner('user-a');
  assert.equal(purged.ok, true);
  assert.equal(purged.removed, 1);
  assert.equal(env.m.files.has(a.candidate.candidateImageUri), false);
  assert.equal(env.m.files.has(b.candidate.candidateImageUri), true);

  const reqB2 = asActor(env.actorContext, 'user-b');
  assert.equal((await env.store.listClosetCandidates(reqB2)).candidates.length, 1);
});

// ── Durable manifest replacement (audit repair A) ────────────────────────────
//
// The manifest is swapped in atomically: write beside, verify, retain the old
// copy, move into place. These cover the windows a force-kill can land in.

const MANIFEST = '/doc/kscan_closet_candidates/kscan_closet_candidates.json';
const MANIFEST_TMP = MANIFEST + '.tmp';
const MANIFEST_BAK = MANIFEST + '.bak';

test('a torn manifest write never replaces the last valid manifest', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');
  const first = await stage(env, req, '/picker/a.jpg');
  assert.equal(first.kind, 'created');
  const good = env.m.files.get(MANIFEST);
  assert.ok(good.includes(first.candidate.candidateId));

  // The NEXT manifest write lands truncated, as a force-kill mid-stream would.
  env.m.failNextWrite('truncate');
  seedSource(env.m, '/picker/b.jpg');
  const second = await stage(env, req, '/picker/b.jpg');

  // The write is refused, not swapped in.
  assert.equal(second.kind, 'rejected');
  assert.equal(env.m.files.get(MANIFEST), good);
  // No debris is left behind for the next read to trip over.
  assert.equal(env.m.files.has(MANIFEST_TMP), false);

  // And the store still reads exactly the candidate that was durably committed.
  const listed = await env.store.listClosetCandidates(req);
  assert.equal(listed.ok, true);
  assert.equal(listed.candidates.length, 1);
  assert.equal(listed.candidates[0].candidateId, first.candidate.candidateId);
});

test('a crash between retiring the manifest and installing its replacement is recovered', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');
  const first = await stage(env, req, '/picker/a.jpg');
  assert.equal(first.kind, 'created');
  const good = env.m.files.get(MANIFEST);

  // The process died after the manifest was moved aside but before the
  // replacement landed. Only the backup survives; the next read repairs it.
  env.m.files.delete(MANIFEST);
  env.m.files.set(MANIFEST_BAK, good);

  const listed = await env.store.listClosetCandidates(req);
  assert.equal(listed.ok, true);
  assert.equal(listed.candidates.length, 1);
  assert.equal(listed.candidates[0].candidateId, first.candidate.candidateId);
  assert.equal(env.m.files.get(MANIFEST), good);
  assert.equal(env.m.files.has(MANIFEST_BAK), false);
});

// ── No clobbering of records a read could not interpret (audit repair B) ─────

test('a mutation after a corrupt read fails closed and leaves the bytes on disk', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  env.m.files.set(MANIFEST, 'not json at all');

  seedSource(env.m, '/picker/a.jpg');
  const created = await stage(env, req, '/picker/a.jpg');
  assert.equal(created.kind, 'rejected');
  assert.equal(created.code, 'candidate_store_recovery_required');

  // The unreadable bytes are still there to be recovered by hand or by a newer
  // build. This is the whole point: a write must not be a silent delete.
  assert.equal(env.m.files.get(MANIFEST), 'not json at all');
});

test('a future-schema record is never dropped by an unrelated write', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const future = {
    schemaVersion: 99,
    candidateId: 'candidate_from_a_newer_build',
    batchId: 'batch_future',
    ownerId: 'user-a',
    status: 'queued',
    createdAt: '2026-07-01T00:00:00.000Z',
    expiresAt: '2999-01-01T00:00:00.000Z',
  };
  env.m.files.set(MANIFEST, JSON.stringify([future]));

  // Every mutating entry point refuses, and names the reason precisely.
  seedSource(env.m, '/picker/a.jpg');
  const created = await stage(env, req, '/picker/a.jpg');
  assert.equal(created.kind, 'rejected');
  assert.equal(created.code, 'candidate_store_future_schema');

  const swept = await env.store.cleanupExpiredClosetCandidates(req);
  assert.equal(swept.ok, false);
  assert.equal(swept.errorCode, 'candidate_store_future_schema');

  const recovered = await env.store.recoverInterruptedClosetCandidates(req);
  assert.equal(recovered.ok, false);
  assert.equal(recovered.errorCode, 'candidate_store_future_schema');

  // The newer build's record is byte-for-byte intact.
  assert.deepEqual(JSON.parse(env.m.files.get(MANIFEST)), [future]);
});

test('a partial read never lets cleanup unlink media it cannot account for', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');
  const created = await stage(env, req, '/picker/a.jpg');
  assert.equal(created.kind, 'created');
  const imageUri = created.candidate.candidateImageUri;

  // Corrupt the manifest, then ask the store to delete the candidate. It cannot
  // know what else references that media, so it must not delete anything.
  env.m.files.set(MANIFEST, '{ truncated');
  const removed = await env.store.deleteClosetCandidate(req, created.candidate.candidateId);
  assert.equal(removed.ok, false);
  assert.equal(removed.errorCode, 'candidate_store_recovery_required');
  assert.equal(env.m.files.has(imageUri), true);
});

// ── Orphan media sweep (audit repair C) ──────────────────────────────────────

test('the sweep collects unreferenced candidate media and nothing else', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');
  const kept = await stage(env, req, '/picker/a.jpg');
  assert.equal(kept.kind, 'created');

  // An orphan: media with no record, older than the in-flight grace period.
  const orphan = '/doc/kscan_closet_candidates/images/orphan_asset.jpg';
  env.m.files.set(orphan, 'orphaned-bytes');
  env.m.setModified(orphan, Date.now() - 60 * 60 * 1000);

  // A committed-Closet file, which the sweep must never even consider.
  const committed = '/doc/kscan_closet/images/committed.jpg';
  env.m.files.set(committed, 'committed-bytes');
  env.m.setModified(committed, 0);

  const result = await env.store.sweepOrphanedClosetCandidateMedia(req);
  assert.equal(result.ok, true);
  assert.equal(result.deleted, 1);
  assert.equal(env.m.files.has(orphan), false);
  assert.equal(env.m.files.has(committed), true);
  assert.equal(env.m.files.has(kept.candidate.candidateImageUri), true);
  assert.equal(env.m.files.has(kept.candidate.candidateThumbnailUri), true);
});

test('the sweep spares in-flight media and refuses to run on a partial read', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');
  await stage(env, req, '/picker/a.jpg');

  // Written just now: an intake that has not reached the manifest yet.
  const inFlight = '/doc/kscan_closet_candidates/images/in_flight.jpg';
  env.m.files.set(inFlight, 'fresh-bytes');
  env.m.setModified(inFlight, Date.now());

  const spared = await env.store.sweepOrphanedClosetCandidateMedia(req);
  assert.equal(spared.ok, true);
  assert.equal(spared.deleted, 0);
  assert.equal(env.m.files.has(inFlight), true);

  // With an unreadable manifest the sweep must not delete anything at all: it
  // cannot tell an orphan from a record it merely failed to parse.
  const stale = '/doc/kscan_closet_candidates/images/stale.jpg';
  env.m.files.set(stale, 'stale-bytes');
  env.m.setModified(stale, 0);
  env.m.files.set(MANIFEST, 'garbage');

  const refused = await env.store.sweepOrphanedClosetCandidateMedia(req);
  assert.equal(refused.ok, false);
  assert.equal(refused.errorCode, 'candidate_store_recovery_required');
  assert.equal(env.m.files.has(stale), true);
});
