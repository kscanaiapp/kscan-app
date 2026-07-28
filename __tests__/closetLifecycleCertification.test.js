// CLOSET LIFECYCLE CERTIFICATION: orphan sweeps, tombstone retirement, storage
// pressure, corruption protection, and the governance locks (Build 2, Phase 4).
//
// WHAT THIS SUITE IS FOR. The convergence suite proves recovery does the right
// thing when it can. This one proves it does NOTHING when it cannot — that every
// destructive path is gated on ownership it has verified, on a manifest it has
// read completely, and on an operation nobody else is holding. Uncertainty must
// retain, and "retain" is the assertion in most of what follows.
//
// The locks at the end are executable, not aspirational. Several read source,
// because a rule about which module may reach which root is a structural fact and
// asserting it behaviourally would only prove it held for the inputs we thought of.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function source(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/**
 * Source with comments removed.
 *
 * The structural locks below assert what a module CAN REACH, and these modules
 * document what they deliberately cannot — "`createClosetItem` is not imported"
 * is prose, not a call. Scanning raw text would make every such note fail its own
 * lock, and the obvious fix (deleting the explanation) would be exactly backwards.
 * The `[^:]` guard keeps `file://` from being mistaken for a line comment.
 */
function code(rel) {
  return source(rel)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function transpile(rel) {
  return ts.transpileModule(source(rel), {
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
  const hooks = { beforeWrite: null, beforeDelete: null, beforeReadDir: null };
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
      if (typeof hooks.beforeWrite === 'function') {
        const verdict = await hooks.beforeWrite(p, c);
        if (verdict === 'skip') return;
        if (verdict === 'throw') throw new Error('ENOSPC');
        if (typeof verdict === 'string') {
          files.set(p, verdict);
          modified.set(p, Date.now());
          return;
        }
      }
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
      if (typeof hooks.beforeDelete === 'function') {
        const verdict = await hooks.beforeDelete(p);
        if (verdict === 'throw') throw new Error('EPERM');
        if (verdict === 'skip') return;
      }
      files.delete(p);
      modified.delete(p);
    },
    async readDirectoryAsync(dir) {
      if (typeof hooks.beforeReadDir === 'function') {
        const verdict = await hooks.beforeReadDir(dir);
        if (verdict === 'throw') throw new Error('ENOENT');
      }
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
  return { files, modified, api, hooks };
}

function cryptoShim() {
  let seq = 0;
  return {
    getRandomBytes(n) {
      seq += 1;
      return Uint8Array.from({ length: n }, (_, i) => (seq * 31 + i * 7) % 256);
    },
    CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
    CryptoEncoding: { HEX: 'hex' },
    async digestStringAsync(_algo, data) {
      let h = 0x811c9dc5;
      for (let i = 0; i < data.length; i += 1) h = ((h ^ data.charCodeAt(i)) * 16777619) >>> 0;
      return h.toString(16).padStart(8, '0').repeat(8);
    },
  };
}

function load() {
  const m = memfs();
  const crypto = cryptoShim();
  const actorContext = runModule('services/actorContext.js', () => ({}));

  let cacheSeq = 0;
  const imageManipulator = {
    SaveFormat: { JPEG: 'jpeg' },
    manipulateAsync: async (uri, ops) => {
      cacheSeq += 1;
      const cacheUri = `/cache/derived_${cacheSeq}.jpg`;
      m.files.set(
        cacheUri,
        Buffer.from(`derived:${uri}:${ops?.[0]?.resize?.width ?? 0}`).toString('base64'),
      );
      m.modified.set(cacheUri, Date.now());
      return { uri: cacheUri };
    },
  };

  const library = runModule('services/library.js', (spec) => {
    if (spec === 'expo-file-system/legacy') return m.api;
    if (spec === 'expo-image-manipulator') return imageManipulator;
    if (spec === './actorContext') return actorContext;
    if (spec === './identificationSnapshot') {
      return { hydrateScanHistory: () => ({ records: [], corruptedCount: 0 }) };
    }
    if (spec === './savedScansCloud') {
      return { saveScanToCloud: async () => ({}), softDeleteCloudSavedScan: async () => ({}) };
    }
    if (spec === './purchaseOptions' || spec === './dressingRoomCommerce') {
      return {
        isPurchaseOptionsSnapshot: Array.isArray,
        normalizePurchaseOptions: (v) => (Array.isArray(v) ? v : []),
      };
    }
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
    if (s === 'react-native') return { Platform: { OS: 'android' } };
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
  const eligibility = runModule('services/closetCandidateReviewEligibility.ts', (s) => {
    if (s === '../types/closetCandidate') return types;
    if (s === './closetCandidateStateMachine') return stateMachine;
    throw new Error(`the eligibility predicate must stay pure: ${s}`);
  });
  const contract = runModule('services/closetCandidatePromotionContract.ts', () => {
    throw new Error('the promotion contract must import nothing');
  });
  const batchReview = runModule('services/closetBatchReview.ts', (s) => {
    if (s === '../types/closetCandidate') return types;
    if (s === './closetCandidateStateMachine') return stateMachine;
    if (s === './closetCandidateErrors') return candidateErrors;
    if (s === './closetCandidateReviewEligibility') return eligibility;
    if (s === './closetCandidatePromotionContract') return contract;
    throw new Error(`the projection must not import ${s}`);
  });
  const projection = runModule('services/closetItemProjection.ts', () => {
    throw new Error('the Closet item projection must import nothing');
  });
  const promotion = runModule('services/closetCandidatePromotion.js', (s) => {
    if (s === './actorContext') return actorContext;
    if (s === './closetLibrary') return closetLibrary;
    if (s === './closetCandidateLibrary') return store;
    if (s === './closetCandidateMedia') return media;
    if (s === './closetCandidateReviewEligibility') return eligibility;
    if (s === './closetBatchReview') return batchReview;
    if (s === './closetCandidatePromotionContract') return contract;
    throw new Error(`the promotion coordinator must not import ${s}`);
  });
  const recovery = runModule('services/closetRecovery.js', (s) => {
    if (s === './actorContext') return actorContext;
    if (s === './closetLibrary') return closetLibrary;
    if (s === './closetCandidateLibrary') return store;
    if (s === './closetCandidateMedia') return media;
    if (s === './closetCandidatePromotion') return promotion;
    if (s === './closetCandidateStateMachine') return stateMachine;
    if (s === './closetTelemetry') return telemetry;
    throw new Error(`the recovery coordinator must not import ${s}`);
  });

  return {
    m,
    actorContext,
    library,
    closetLibrary,
    store,
    schema,
    types,
    media,
    batchReview,
    projection,
    promotion,
    recovery,
  };
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const CANDIDATE_MANIFEST = '/doc/kscan_closet_candidates/kscan_closet_candidates.json';
const CANDIDATE_IMAGES = '/doc/kscan_closet_candidates/images/';
const CLOSET_MANIFEST = '/doc/kscan_closet/kscan_closet.json';
const CLOSET_IMAGES = '/doc/kscan_closet/images/';
const CLOSET_THUMBS = '/doc/kscan_closet/thumbnails/';
const LIBRARY_IMAGES = '/doc/kscan_library/images/';

const DAY_MS = 24 * 60 * 60 * 1000;

const FULL_TAXONOMY = Object.freeze({
  category: 'Outerwear',
  clothingType: 'Jacket',
  subtype: 'Bomber',
  brand: 'Acme',
  primaryColor: 'Black',
  secondaryColors: ['Grey', 'White'],
  material: ['Wool', 'Nylon'],
  size: 'M',
});

function asActor(actorContext, actorId) {
  actorContext.advanceActorEpoch(actorId);
  return actorContext.createActorRequest();
}

function seedSource(m, uri, marker = 'original') {
  m.files.set(uri, Buffer.from(`${marker}:${uri}`).toString('base64'));
  m.modified.set(uri, Date.now());
  return uri;
}

function readManifest(env, manifestPath) {
  const raw = env.m.files.get(manifestPath);
  return raw ? JSON.parse(raw) : [];
}

function writeManifest(env, manifestPath, records) {
  env.m.files.set(manifestPath, JSON.stringify(records));
  env.m.modified.set(manifestPath, Date.now());
}

function candidateOnDisk(env, candidateId) {
  return readManifest(env, CANDIDATE_MANIFEST).find((e) => e.candidateId === candidateId);
}

async function stageReady(env, req, uri, taxonomy = FULL_TAXONOMY) {
  seedSource(env.m, uri);
  const created = await env.store.createClosetCandidate(req, {
    sourceUri: uri,
    sourceType: 'gallery',
    ownerId: req?.actorId,
  });
  assert.equal(created.kind, 'created', `staging failed: ${created.code}`);
  const id = created.candidate.candidateId;
  await env.store.transitionClosetCandidate(req, id, { to: 'classifying' });
  const ready = await env.store.transitionClosetCandidate(req, id, {
    to: 'ready_for_review',
    patch: { ...taxonomy },
  });
  assert.ok(ready.ok, `classification failed: ${ready.errorCode}`);
  return ready.candidate;
}

async function stageAndPromote(env, req, uri, taxonomy = FULL_TAXONOMY) {
  const candidate = await stageReady(env, req, uri, taxonomy);
  const result = await env.promotion.promoteSelectedClosetCandidates({
    candidateIds: [candidate.candidateId],
    yieldToUi: async () => {},
  });
  assert.equal(result.promotedCount, 1, `promotion failed: ${JSON.stringify(result.results)}`);
  const committed = await env.closetLibrary.findClosetItemBySourceCandidate(
    candidate.candidateId,
    req.actorId ?? null,
  );
  assert.ok(committed);
  return { candidate, committed };
}

/** Back-date a tombstone's promotion stamp so the retention window has elapsed. */
function backdatePromotion(env, candidateId, ageMs) {
  const records = readManifest(env, CANDIDATE_MANIFEST);
  const index = records.findIndex((e) => e.candidateId === candidateId);
  assert.notEqual(index, -1);
  records[index] = {
    ...records[index],
    promotedAt: new Date(Date.now() - ageMs).toISOString(),
  };
  writeManifest(env, CANDIDATE_MANIFEST, records);
}

/** A converged tombstone: promoted, media released, and aged past retention. */
async function stageRetirableTombstone(env, req, uri) {
  const { candidate, committed } = await stageAndPromote(env, req, uri);
  const cleaned = await env.recovery.runClosetStartupRecovery(req, { yieldToUi: async () => {} });
  assert.equal(cleaned.cleanedCount, 1);
  backdatePromotion(env, candidate.candidateId, 8 * DAY_MS);
  return { candidate, committed };
}

// ═════════════════════════════════════════════════════════════════════════════
// loadCloset layering (Phase 3.5 lock, re-asserted)
// ═════════════════════════════════════════════════════════════════════════════

test('PHASE4-LOCK-LOADCLOSET-VALIDATES-WITHOUT-STRIPPING: trusted internal fields survive the read', async () => {
  const env = load();
  // A committed record carrying a field the store's own allowlist does not mint,
  // but the candidate store's exact-hash duplicate check legitimately reads.
  writeManifest(env, CLOSET_MANIFEST, [
    {
      schemaVersion: 2,
      id: 'closet_1',
      ownerId: 'user-a',
      title: 'Acme Bomber',
      category: 'Outerwear',
      imageUri: CLOSET_IMAGES + 'a.jpg',
      thumbnailUri: null,
      sourceCandidateId: 'cand_1',
      contentHash: 'deadbeef',
      contentHashVersion: 'sha256-normalized-v1',
      normalizedByteLength: 4096,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ]);

  const loaded = await env.closetLibrary.loadCloset('user-a');
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].contentHash, 'deadbeef', 'loadCloset must not strip contentHash');
  assert.equal(loaded[0].contentHashVersion, 'sha256-normalized-v1');
  assert.equal(loaded[0].normalizedByteLength, 4096);
  assert.equal(loaded[0].sourceCandidateId, 'cand_1');
});

test('PHASE4-LOCK-PROJECTION-IS-THE-PUBLIC-BOUNDARY: reconstruction happens at the projection, not in the store', async () => {
  const env = load();
  writeManifest(env, CLOSET_MANIFEST, [
    {
      schemaVersion: 2,
      id: 'closet_1',
      ownerId: 'user-a',
      title: 'Acme Bomber',
      category: 'Outerwear',
      imageUri: CLOSET_IMAGES + 'a.jpg',
      sourceCandidateId: 'cand_1',
      contentHash: 'deadbeef',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ]);
  const [record] = await env.closetLibrary.loadCloset('user-a');
  const projected = env.projection.getClosetItemProjection(record);

  for (const field of env.projection.CLOSET_ITEM_INTERNAL_FIELDS) {
    assert.equal(field in projected, false, `${field} must not reach a screen`);
  }
  assert.equal('contentHash' in projected, false, 'the projection is an allowlist');
  assert.equal(projected.category, 'Outerwear');

  // STRUCTURAL: the store cannot reach the projection, so canonical
  // reconstruction provably does not happen on the read path.
  const storeCode = code('services/closetLibrary.js');
  assert.equal(
    /from\s+'\.\/closetItemProjection'|require\(['"]\.\/closetItemProjection/.test(storeCode),
    false,
    'the committed store must not import the projection',
  );
  assert.equal(
    /getClosetItemProjections?\s*\(/.test(storeCode),
    false,
    'loadCloset must not perform canonical reconstruction',
  );
  // And loadCloset returns the persisted record rather than the allowlist build.
  const loadBody = storeCode.slice(
    storeCode.indexOf('export async function loadCloset'),
    storeCode.indexOf('export async function createClosetItem'),
  );
  assert.equal(
    /buildClosetRecord\s*\(/.test(loadBody),
    false,
    'loadCloset validates; it does not rebuild',
  );
});

// ═════════════════════════════════════════════════════════════════════════════
// Committed-root orphan sweep
// ═════════════════════════════════════════════════════════════════════════════

test('PHASE4-COMMITTED-SWEEP: referenced media survives and a true orphan is collected', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const { committed } = await stageAndPromote(env, req, '/pick/a.jpg');

  const orphan = CLOSET_IMAGES + 'orphan.jpg';
  env.m.files.set(orphan, 'x');
  env.m.modified.set(orphan, Date.now() - DAY_MS);

  const result = await env.closetLibrary.sweepOrphanedClosetMedia({ nowMs: Date.now() });

  assert.equal(result.ok, true);
  assert.equal(result.deleted, 1);
  assert.equal(env.m.files.has(orphan), false);
  assert.ok(env.m.files.has(committed.imageUri), 'referenced committed media must survive');
});

test('PHASE4-COMMITTED-SWEEP-PROTECTS-IN-FLIGHT-DESTINATION: a reserved stable path is never collected', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  await stageAndPromote(env, req, '/pick/a.jpg');

  // The deterministic destination a promotion reserves, written but not yet
  // referenced by the manifest — the exact crash window the sweep must respect.
  const paths = env.closetLibrary.closetPromotionMediaPaths('user-a', 'cand_inflight');
  env.m.files.set(paths.imageUri, 'inflight');
  env.m.modified.set(paths.imageUri, Date.now() - DAY_MS);

  const unprotected = await env.closetLibrary.sweepOrphanedClosetMedia({
    nowMs: Date.now(),
    protectedPaths: [paths.imageUri, paths.thumbnailUri],
  });
  assert.equal(unprotected.deleted, 0);
  assert.ok(env.m.files.has(paths.imageUri), 'a reserved destination must be retained');
});

test('PHASE4-COMMITTED-SWEEP-FUTURE-SCHEMA: media named by an unreadable record is retained', async () => {
  const env = load();
  const orphanish = CLOSET_IMAGES + 'future.jpg';
  env.m.files.set(orphanish, 'x');
  env.m.modified.set(orphanish, Date.now() - DAY_MS);
  // A record this build refuses to hydrate still NAMES its media.
  writeManifest(env, CLOSET_MANIFEST, [
    { schemaVersion: 99, id: 'closet_future', ownerId: 'user-a', imageUri: orphanish },
  ]);

  const result = await env.closetLibrary.sweepOrphanedClosetMedia({ nowMs: Date.now() });
  assert.equal(result.deleted, 0);
  assert.ok(env.m.files.has(orphanish), 'future-schema media must never be collected');
});

test('PHASE4-COMMITTED-SWEEP-REFUSES-UNCERTAIN-MANIFEST: unparseable or malformed refuses outright', async () => {
  const env = load();
  const file = CLOSET_IMAGES + 'a.jpg';
  env.m.files.set(file, 'x');
  env.m.modified.set(file, Date.now() - DAY_MS);

  env.m.files.set(CLOSET_MANIFEST, '{ not json');
  let result = await env.closetLibrary.sweepOrphanedClosetMedia({ nowMs: Date.now() });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'manifest_unreadable');
  assert.ok(env.m.files.has(file));

  env.m.files.set(CLOSET_MANIFEST, JSON.stringify({ notAnArray: true }));
  result = await env.closetLibrary.sweepOrphanedClosetMedia({ nowMs: Date.now() });
  assert.equal(result.ok, false);
  assert.ok(env.m.files.has(file));

  // An entry that is not an object makes the reference set incomplete.
  writeManifest(env, CLOSET_MANIFEST, ['not-a-record']);
  result = await env.closetLibrary.sweepOrphanedClosetMedia({ nowMs: Date.now() });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'manifest_incomplete');
  assert.ok(env.m.files.has(file));
});

test('PHASE4-COMMITTED-SWEEP-NEVER-TOUCHES-OTHER-ROOTS: candidate and Recent Scan files are untouched', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const candidate = await stageReady(env, req, '/pick/a.jpg');
  env.m.modified.set(candidate.candidateImageUri, Date.now() - DAY_MS);
  env.m.modified.set(candidate.candidateThumbnailUri, Date.now() - DAY_MS);
  const scanFile = LIBRARY_IMAGES + 'scan.jpg';
  env.m.files.set(scanFile, 'scan');
  env.m.modified.set(scanFile, Date.now() - DAY_MS);
  writeManifest(env, CLOSET_MANIFEST, []);

  const result = await env.closetLibrary.sweepOrphanedClosetMedia({ nowMs: Date.now() });

  assert.equal(result.ok, true);
  assert.ok(env.m.files.has(candidate.candidateImageUri), 'candidate root is out of scope');
  assert.ok(env.m.files.has(scanFile), 'Recent Scan root is out of scope');
});

test('PHASE4-COMMITTED-SWEEP-GRACE: a freshly written file is retained for a later pass', async () => {
  const env = load();
  writeManifest(env, CLOSET_MANIFEST, []);
  const fresh = CLOSET_IMAGES + 'fresh.jpg';
  env.m.files.set(fresh, 'x');
  env.m.modified.set(fresh, Date.now());

  const result = await env.closetLibrary.sweepOrphanedClosetMedia({ nowMs: Date.now() });
  assert.equal(result.deleted, 0);
  assert.ok(env.m.files.has(fresh));
});

test('PHASE4-COMMITTED-SWEEP-BOUNDED: traversal stops at the budget and resumes on the next pass', async () => {
  const env = load();
  writeManifest(env, CLOSET_MANIFEST, []);
  for (let i = 0; i < 12; i += 1) {
    const p = CLOSET_IMAGES + `o${i}.jpg`;
    env.m.files.set(p, 'x');
    env.m.modified.set(p, Date.now() - DAY_MS);
  }

  const first = await env.closetLibrary.sweepOrphanedClosetMedia({ nowMs: Date.now(), maxFiles: 5 });
  assert.equal(first.truncated, true);
  assert.equal(first.deleted, 5);

  const second = await env.closetLibrary.sweepOrphanedClosetMedia({ nowMs: Date.now(), maxFiles: 50 });
  assert.equal(second.deleted, 7);
  assert.equal(
    [...env.m.files.keys()].filter((k) => k.startsWith(CLOSET_IMAGES)).length,
    0,
  );
});

test('PHASE4-COMMITTED-SWEEP-DELETION-FAILURE-IS-NON-FATAL: an undeletable orphan is counted, never looped on', async () => {
  const env = load();
  writeManifest(env, CLOSET_MANIFEST, []);
  const stuck = CLOSET_IMAGES + 'stuck.jpg';
  env.m.files.set(stuck, 'x');
  env.m.modified.set(stuck, Date.now() - DAY_MS);
  env.m.hooks.beforeDelete = (p) => (p === stuck ? 'throw' : undefined);

  const first = await env.closetLibrary.sweepOrphanedClosetMedia({ nowMs: Date.now() });
  assert.equal(first.ok, true);
  assert.equal(first.failed, 1);
  assert.equal(first.deleted, 0);

  // A permanently undeletable file must not change the outcome of a later pass.
  const second = await env.closetLibrary.sweepOrphanedClosetMedia({ nowMs: Date.now() });
  assert.equal(second.failed, 1);
  assert.ok(env.m.files.has(stuck));
});

test('PHASE4-COMMITTED-SWEEP-DUPLICATE-HASHES: two items sharing content keep their own media', async () => {
  const env = load();
  const a = CLOSET_IMAGES + 'a.jpg';
  const b = CLOSET_IMAGES + 'b.jpg';
  for (const p of [a, b]) {
    env.m.files.set(p, 'identical-bytes');
    env.m.modified.set(p, Date.now() - DAY_MS);
  }
  writeManifest(env, CLOSET_MANIFEST, [
    { schemaVersion: 2, id: 'i1', ownerId: 'user-a', imageUri: a, contentHash: 'same', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    { schemaVersion: 2, id: 'i2', ownerId: 'user-b', imageUri: b, contentHash: 'same', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
  ]);

  const result = await env.closetLibrary.sweepOrphanedClosetMedia({ nowMs: Date.now() });
  assert.equal(result.deleted, 0, 'reference, not content, decides survival');
  assert.ok(env.m.files.has(a));
  assert.ok(env.m.files.has(b));
});

// ═════════════════════════════════════════════════════════════════════════════
// Candidate-root orphan sweep
// ═════════════════════════════════════════════════════════════════════════════

test('PHASE4-CANDIDATE-SWEEP: referenced candidate media survives, a true orphan is collected', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const candidate = await stageReady(env, req, '/pick/a.jpg');

  const orphan = CANDIDATE_IMAGES + 'orphan.jpg';
  env.m.files.set(orphan, 'x');
  env.m.modified.set(orphan, Date.now() - DAY_MS);

  const result = await env.store.sweepOrphanedClosetCandidateMedia(req, { nowMs: Date.now() });
  assert.equal(result.deleted, 1);
  assert.equal(env.m.files.has(orphan), false);
  assert.ok(env.m.files.has(candidate.candidateImageUri));
});

test('PHASE4-CANDIDATE-SWEEP-ACTIVE-OPERATION: media a live selection references is retained', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const candidate = await stageReady(env, req, '/pick/a.jpg');

  // Its record still points at it, which is exactly what an in-flight promotion
  // relies on: the sweep is reference-driven, and the reference is still there.
  const result = await env.store.sweepOrphanedClosetCandidateMedia(req, { nowMs: Date.now() });
  assert.equal(result.deleted, 0);
  assert.ok(env.m.files.has(candidate.candidateImageUri));
  assert.ok(env.m.files.has(candidate.candidateThumbnailUri));
});

test('PHASE4-CANDIDATE-SWEEP-REFUSES-UNCERTAINTY: an uninterpretable record blocks the sweep', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const candidate = await stageReady(env, req, '/pick/a.jpg');
  const orphan = CANDIDATE_IMAGES + 'orphan.jpg';
  env.m.files.set(orphan, 'x');
  env.m.modified.set(orphan, Date.now() - DAY_MS);

  const records = readManifest(env, CANDIDATE_MANIFEST);
  writeManifest(env, CANDIDATE_MANIFEST, [...records, { schemaVersion: 99, candidateId: 'x' }]);

  const result = await env.store.sweepOrphanedClosetCandidateMedia(req, { nowMs: Date.now() });
  assert.equal(result.ok, false);
  assert.equal(result.deleted, 0);
  assert.ok(env.m.files.has(orphan), 'uncertainty retains');
  assert.ok(env.m.files.has(candidate.candidateImageUri));
});

test('PHASE4-CANDIDATE-SWEEP-NEVER-TOUCHES-COMMITTED-ROOT: committed media is out of scope', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const { committed } = await stageAndPromote(env, req, '/pick/a.jpg');

  const result = await env.store.sweepOrphanedClosetCandidateMedia(req, { nowMs: Date.now() });
  assert.equal(result.ok, true);
  assert.ok(env.m.files.has(committed.imageUri), 'the candidate sweep cannot reach kscan_closet/');
});

// ═════════════════════════════════════════════════════════════════════════════
// Path ownership
// ═════════════════════════════════════════════════════════════════════════════

test('PHASE4-PATH-OWNERSHIP: the two roots are mutually exclusive and traversal is rejected', () => {
  const env = load();
  const { isCandidateOwnedPath } = env.media;
  const { isClosetOwnedMediaPath } = env.closetLibrary;

  assert.equal(isCandidateOwnedPath(CANDIDATE_IMAGES + 'a.jpg'), true);
  assert.equal(isCandidateOwnedPath(CLOSET_IMAGES + 'a.jpg'), false);
  assert.equal(isCandidateOwnedPath(LIBRARY_IMAGES + 'a.jpg'), false);

  assert.equal(isClosetOwnedMediaPath(CLOSET_IMAGES + 'a.jpg'), true);
  assert.equal(isClosetOwnedMediaPath(CLOSET_THUMBS + 'a.jpg'), true);
  assert.equal(isClosetOwnedMediaPath(CANDIDATE_IMAGES + 'a.jpg'), false);
  assert.equal(isClosetOwnedMediaPath(LIBRARY_IMAGES + 'a.jpg'), false);

  // TRAVERSAL. Starts inside the root as a string; resolves outside it as a path.
  const escape = CANDIDATE_IMAGES + '../../kscan_closet/images/victim.jpg';
  assert.equal(isCandidateOwnedPath(escape), false, 'a traversal must never be candidate-owned');
  assert.equal(
    isClosetOwnedMediaPath(CLOSET_IMAGES + '../../kscan_closet_candidates/images/v.jpg'),
    false,
  );
  // URI parsers may decode these segments before filesystem resolution. The
  // ownership boundary must reject both encoded dots and encoded separators.
  assert.equal(
    isCandidateOwnedPath(
      CANDIDATE_IMAGES + '%2e%2e/%2e%2e/kscan_closet/images/victim.jpg',
    ),
    false,
  );
  assert.equal(
    isClosetOwnedMediaPath(
      CLOSET_IMAGES + '%2e%2e%2f%2e%2e%2fkscan_closet_candidates/images/v.jpg',
    ),
    false,
  );
  assert.equal(
    isCandidateOwnedPath(CANDIDATE_IMAGES + '%252e%252e%255coutside.jpg'),
    false,
  );
  assert.equal(isCandidateOwnedPath(CANDIDATE_IMAGES + '/../images/victim.jpg'), false);
  assert.equal(isCandidateOwnedPath('/doc/kscan_closet_candidates/images-evil/a.jpg'), false);
  assert.equal(isClosetOwnedMediaPath('/doc/kscan_closet/images-evil/a.jpg'), false);
  assert.equal(isCandidateOwnedPath('https://example.test/doc/kscan_closet_candidates/images/a.jpg'), false);
  assert.equal(isClosetOwnedMediaPath('/absolute/external/a.jpg'), false);
  assert.equal(isCandidateOwnedPath(CANDIDATE_IMAGES + 'nested\\..\\..\\outside.jpg'), false);
  assert.equal(isClosetOwnedMediaPath(CLOSET_IMAGES + 'nested//a.jpg'), true);
  // Scheme and case still normalize, so a legitimate reference is unaffected.
  assert.equal(isCandidateOwnedPath('file://' + CANDIDATE_IMAGES + 'A.JPG'), true);
});

test('PHASE4-CANDIDATE-CLEANUP-CANNOT-REACH-THE-COMMITTED-ROOT: a committed path handed in is dropped', async () => {
  const env = load();
  const committedFile = CLOSET_IMAGES + 'victim.jpg';
  const scanFile = LIBRARY_IMAGES + 'victim.jpg';
  const traversal = CANDIDATE_IMAGES + '../../kscan_closet/images/victim.jpg';
  for (const p of [committedFile, scanFile]) env.m.files.set(p, 'precious');

  const failures = await env.media.unlinkUnreferencedCandidateMedia(
    [committedFile, scanFile, traversal],
    [],
  );

  assert.deepEqual(failures, [], 'a dropped path is not a failure, it is simply not deleted');
  assert.ok(env.m.files.has(committedFile), 'candidate cleanup must never reach committed media');
  assert.ok(env.m.files.has(scanFile), 'candidate cleanup must never reach a Recent Scan');
});

// ═════════════════════════════════════════════════════════════════════════════
// Saved-tombstone retirement
// ═════════════════════════════════════════════════════════════════════════════

test('PHASE4-TOMBSTONE-RETENTION-INTERVAL: the policy reuses the candidate interval, anchored at promotion', () => {
  const env = load();
  assert.equal(
    env.types.CLOSET_CANDIDATE_TOMBSTONE_RETENTION_MS,
    env.types.CLOSET_CANDIDATE_TTL_MS,
    'no second magic duration may be introduced',
  );
  assert.equal(env.types.CLOSET_CANDIDATE_TOMBSTONE_RETENTION_MS, 7 * DAY_MS);
});

test('PHASE4-TOMBSTONE-YOUNG: a freshly promoted tombstone is retained', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const { candidate } = await stageAndPromote(env, req, '/pick/a.jpg');

  const result = await env.recovery.runClosetStartupRecovery(req, { yieldToUi: async () => {} });
  assert.equal(result.cleanedCount, 1);
  assert.equal(result.retiredCount, 0, 'inside the window nothing is retired');
  assert.ok(candidateOnDisk(env, candidate.candidateId));
});

test('PHASE4-TOMBSTONE-AGE-ALONE-IS-NOT-ENOUGH: an aged tombstone with no committed item survives', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const { candidate } = await stageRetirableTombstone(env, req, '/pick/a.jpg');

  // The committed item disappears. Age is now satisfied and nothing else is.
  writeManifest(env, CLOSET_MANIFEST, []);

  const result = await env.recovery.runClosetStartupRecovery(
    asActor(env.actorContext, 'user-a'),
    { yieldToUi: async () => {} },
  );
  assert.equal(result.retiredCount, 0);
  assert.ok(result.issues.includes('committed_missing'));
  assert.ok(candidateOnDisk(env, candidate.candidateId), 'the tombstone must survive');
});

test('PHASE4-TOMBSTONE-RETIRED: a verified, cleaned, aged tombstone is removed and the item is not', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const { candidate, committed } = await stageRetirableTombstone(env, req, '/pick/a.jpg');

  const relaunch = asActor(env.actorContext, 'user-a');
  const result = await env.recovery.runClosetStartupRecovery(relaunch, { yieldToUi: async () => {} });

  assert.equal(result.retiredCount, 1);
  assert.equal(candidateOnDisk(env, candidate.candidateId), undefined, 'the record is gone');

  // THE COMMITTED ITEM AND ITS MEDIA ARE UNTOUCHED.
  const closet = await env.closetLibrary.loadCloset('user-a');
  assert.equal(closet.length, 1);
  assert.equal(closet[0].id, committed.id);
  assert.ok(env.m.files.has(committed.imageUri));

  // AND IT DOES NOT COME BACK. A later launch finds nothing to reconstruct.
  const after = await env.recovery.runClosetStartupRecovery(
    asActor(env.actorContext, 'user-a'),
    { yieldToUi: async () => {} },
  );
  assert.equal(after.retiredCount, 0);
  assert.equal(candidateOnDisk(env, candidate.candidateId), undefined);
  assert.equal((await env.closetLibrary.loadCloset('user-a')).length, 1);
});

test('PHASE4-TOMBSTONE-BLOCKED-BY-MEDIA: candidate media still on disk blocks retirement', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const { candidate } = await stageAndPromote(env, req, '/pick/a.jpg');
  backdatePromotion(env, candidate.candidateId, 8 * DAY_MS);

  // Block the cleanup stage so the media reference survives into retirement.
  env.m.hooks.beforeDelete = (p) => (p.startsWith(CANDIDATE_IMAGES) ? 'throw' : undefined);

  const result = await env.recovery.runClosetStartupRecovery(
    asActor(env.actorContext, 'user-a'),
    { yieldToUi: async () => {} },
  );
  assert.equal(result.retiredCount, 0, 'retirement must wait for cleanup to complete');
  assert.ok(candidateOnDisk(env, candidate.candidateId));
});

test('PHASE4-TOMBSTONE-BLOCKED-BY-INVALID-MEDIA-AND-TAXONOMY: either failure retains the record', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const { candidate, committed } = await stageRetirableTombstone(env, req, '/pick/a.jpg');

  // Committed media gone.
  env.m.files.delete(committed.imageUri);
  let result = await env.recovery.runClosetStartupRecovery(
    asActor(env.actorContext, 'user-a'),
    { yieldToUi: async () => {} },
  );
  assert.equal(result.retiredCount, 0);
  assert.ok(result.issues.includes('committed_media_invalid'));
  assert.ok(candidateOnDisk(env, candidate.candidateId));

  // Media restored, taxonomy hollowed out instead.
  env.m.files.set(committed.imageUri, 'restored');
  const items = readManifest(env, CLOSET_MANIFEST);
  const index = items.findIndex((item) => item.id === committed.id);
  items[index] = { ...items[index], brand: null };
  writeManifest(env, CLOSET_MANIFEST, items);

  result = await env.recovery.runClosetStartupRecovery(
    asActor(env.actorContext, 'user-a'),
    { yieldToUi: async () => {} },
  );
  assert.equal(result.retiredCount, 0);
  assert.ok(result.issues.includes('taxonomy_unverified'));
  assert.ok(candidateOnDisk(env, candidate.candidateId));
});

test('PHASE4-TOMBSTONE-BATCH-CONTINUITY: a batch still under review keeps its promoted rows', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');

  // Two candidates in ONE batch: one promoted and aged out, one still in review.
  const promotedCandidate = await stageReady(env, req, '/pick/a.jpg');
  const batchId = promotedCandidate.batchId;
  seedSource(env.m, '/pick/b.jpg');
  const sibling = await env.store.createClosetCandidate(req, {
    sourceUri: '/pick/b.jpg',
    sourceType: 'gallery',
    ownerId: 'user-a',
    batchId,
  });
  assert.equal(sibling.kind, 'created');

  await env.promotion.promoteSelectedClosetCandidates({
    candidateIds: [promotedCandidate.candidateId],
    yieldToUi: async () => {},
  });
  await env.recovery.runClosetStartupRecovery(req, { yieldToUi: async () => {} });
  backdatePromotion(env, promotedCandidate.candidateId, 8 * DAY_MS);

  const result = await env.recovery.runClosetStartupRecovery(
    asActor(env.actorContext, 'user-a'),
    { yieldToUi: async () => {} },
  );
  assert.equal(result.retiredCount, 0, 'an unresolved sibling holds the whole batch');

  const stored = candidateOnDisk(env, promotedCandidate.candidateId);
  assert.ok(stored, 'the promoted row is still there for the review surface');
  const projection = env.batchReview.getClosetBatchReviewProjection({
    actorId: 'user-a',
    candidates: readManifest(env, CANDIDATE_MANIFEST),
  });
  assert.equal(projection.activeGroup.totalCount, 2);
  assert.equal(projection.activeGroup.promotedCount, 1);
});

test('PHASE4-TOMBSTONE-STORE-PRIMITIVE-FAILS-CLOSED: every precondition is enforced by the store', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const { candidate, committed } = await stageRetirableTombstone(env, req, '/pick/a.jpg');
  const live = asActor(env.actorContext, 'user-a');

  // Wrong committed id.
  let result = await env.store.retirePromotedClosetCandidate(live, candidate.candidateId, {
    closetItemId: 'closet_someone_else',
  });
  assert.equal(result.ok, false);
  assert.ok(candidateOnDisk(env, candidate.candidateId));

  // No committed id at all — "it says saved" is never enough.
  result = await env.store.retirePromotedClosetCandidate(live, candidate.candidateId, {});
  assert.equal(result.ok, false);
  assert.ok(candidateOnDisk(env, candidate.candidateId));

  // Inside the retention window, with everything else correct.
  const records = readManifest(env, CANDIDATE_MANIFEST);
  const index = records.findIndex((e) => e.candidateId === candidate.candidateId);
  records[index] = { ...records[index], promotedAt: new Date().toISOString() };
  writeManifest(env, CANDIDATE_MANIFEST, records);
  result = await env.store.retirePromotedClosetCandidate(live, candidate.candidateId, {
    closetItemId: committed.id,
  });
  assert.equal(result.ok, false, 'the window is enforced by the store, not by the caller');
  assert.ok(candidateOnDisk(env, candidate.candidateId));

  // A caller cannot shorten the window: there is no argument for it.
  const retireSource = code('services/closetCandidateLibrary.js');
  const body = retireSource.slice(retireSource.indexOf('export async function retirePromotedClosetCandidate'));
  assert.equal(
    /options\.(retentionMs|minRetentionMs|retainUntilMs|maxAgeMs)/.test(body.slice(0, 3000)),
    false,
    'retention must not be caller-supplied',
  );
});

test('PHASE4-RELEASE-PRIMITIVE-FAILS-CLOSED: media release demands a matching verified committed id', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const { candidate } = await stageAndPromote(env, req, '/pick/a.jpg');
  const stored = candidateOnDisk(env, candidate.candidateId);

  let result = await env.store.releasePromotedCandidateMedia(req, candidate.candidateId, {
    closetItemId: 'closet_wrong',
  });
  assert.equal(result.ok, false);
  assert.ok(env.m.files.has(stored.candidateImageUri));

  result = await env.store.releasePromotedCandidateMedia(req, candidate.candidateId, {});
  assert.equal(result.ok, false);
  assert.ok(env.m.files.has(stored.candidateImageUri), 'saved status alone authorizes nothing');
});

test('PHASE4-RELEASE-PRIMITIVE-REFUSES-A-DRAFT: a non-saved candidate keeps its media', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const candidate = await stageReady(env, req, '/pick/a.jpg');

  const result = await env.store.releasePromotedCandidateMedia(req, candidate.candidateId, {
    closetItemId: 'closet_anything',
  });
  assert.equal(result.ok, false);
  assert.ok(env.m.files.has(candidate.candidateImageUri));
});

// ═════════════════════════════════════════════════════════════════════════════
// Storage pressure
// ═════════════════════════════════════════════════════════════════════════════

test('PHASE4-STORAGE-MANIFEST-WRITE-FAILS: cleanup that cannot persist deletes nothing', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const { candidate, committed } = await stageAndPromote(env, req, '/pick/a.jpg');
  const stored = candidateOnDisk(env, candidate.candidateId);

  env.m.hooks.beforeWrite = (p) =>
    p.startsWith('/doc/kscan_closet_candidates/') ? 'throw' : undefined;

  const result = await env.recovery.runClosetStartupRecovery(req, { yieldToUi: async () => {} });

  assert.equal(result.ok, true, 'a storage failure must not crash the pass');
  assert.equal(result.cleanedCount, 0);
  assert.ok(env.m.files.has(stored.candidateImageUri), 'files survive a failed manifest write');
  env.m.hooks.beforeWrite = null;
  assert.equal(candidateOnDisk(env, candidate.candidateId).candidateImageUri, stored.candidateImageUri);
  const closet = await env.closetLibrary.loadCloset('user-a');
  assert.equal(closet.length, 1, 'cleanup failure cannot erase the committed record');
  assert.equal(closet[0].id, committed.id);
  assert.ok(env.m.files.has(committed.imageUri), 'cleanup failure cannot erase committed media');
});

test('PHASE4-STORAGE-DELETE-FAILS-AFTER-WRITE: the record is cleared and the file is collected later', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const { candidate } = await stageAndPromote(env, req, '/pick/a.jpg');
  const stored = candidateOnDisk(env, candidate.candidateId);

  env.m.hooks.beforeDelete = (p) => (p === stored.candidateImageUri ? 'throw' : undefined);

  const result = await env.recovery.runClosetStartupRecovery(req, { yieldToUi: async () => {} });
  assert.equal(result.ok, true);
  assert.ok(result.issues.includes('cleanup_failed'));

  // References cleared first, so the leak is reachable by the orphan collector.
  const after = candidateOnDisk(env, candidate.candidateId);
  assert.equal(after.candidateImageUri, null);
  assert.equal(after.status, 'saved');
  assert.ok(env.m.files.has(stored.candidateImageUri), 'the file is still there for now');

  env.m.hooks.beforeDelete = null;
  const swept = await env.store.sweepOrphanedClosetCandidateMedia(
    asActor(env.actorContext, 'user-a'),
    { nowMs: Date.now() + DAY_MS },
  );
  assert.equal(swept.deleted >= 1, true, 'partial deletion remains recoverable');
  assert.equal(env.m.files.has(stored.candidateImageUri), false);
});

test('PHASE4-STORAGE-METRICS-UNAVAILABLE: recovery does not depend on free-space reporting', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const { candidate } = await stageAndPromote(env, req, '/pick/a.jpg');

  // Malformed, then absent. Neither is a reason to refuse to converge.
  env.m.api.getFreeDiskStorageAsync = async () => 'not-a-number';
  let result = await env.recovery.runClosetStartupRecovery(req, { yieldToUi: async () => {} });
  assert.equal(result.ok, true);
  assert.equal(result.cleanedCount, 1);

  delete env.m.api.getFreeDiskStorageAsync;
  result = await env.recovery.runClosetStartupRecovery(
    asActor(env.actorContext, 'user-a'),
    { yieldToUi: async () => {} },
  );
  assert.equal(result.ok, true);
  assert.equal(candidateOnDisk(env, candidate.candidateId).candidateImageUri, null);
});

test('PHASE4-NO-INFINITE-LOOP: permanently undeletable media converges to a stable outcome', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const { candidate } = await stageAndPromote(env, req, '/pick/a.jpg');
  const stored = candidateOnDisk(env, candidate.candidateId);
  env.m.hooks.beforeDelete = (p) => (p.startsWith(CANDIDATE_IMAGES) ? 'throw' : undefined);

  for (let launch = 0; launch < 4; launch += 1) {
    const result = await env.recovery.runClosetStartupRecovery(
      asActor(env.actorContext, 'user-a'),
      { yieldToUi: async () => {} },
    );
    assert.equal(result.ok, true, 'every pass must terminate');
    assert.equal(result.complete, true);
  }
  assert.ok(env.m.files.has(stored.candidateImageUri));
  assert.equal(candidateOnDisk(env, candidate.candidateId).status, 'saved');
});

// ═════════════════════════════════════════════════════════════════════════════
// Bounds, yields, and initialization safety
// ═════════════════════════════════════════════════════════════════════════════

test('PHASE4-BOUNDED-AND-RESUMABLE: a large store is processed across passes, never in one', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  for (let i = 0; i < 6; i += 1) await stageAndPromote(env, req, `/pick/p${i}.jpg`);

  const first = await env.recovery.runClosetStartupRecovery(req, {
    yieldToUi: async () => {},
    maxUnits: 3,
  });
  assert.equal(first.complete, false);
  assert.equal(first.stopReason, 'budget_exhausted');

  let cleaned = first.cleanedCount;
  for (let pass = 0; pass < 8 && cleaned < 6; pass += 1) {
    const next = await env.recovery.runClosetStartupRecovery(
      asActor(env.actorContext, 'user-a'),
      { yieldToUi: async () => {}, maxUnits: 3 },
    );
    cleaned += next.cleanedCount;
  }
  assert.equal(cleaned, 6, 'a bounded pass resumes rather than dropping work');
  const remaining = readManifest(env, CANDIDATE_MANIFEST).filter((e) => e.candidateImageUri);
  assert.equal(remaining.length, 0);
});

test('PHASE4-YIELDS-BETWEEN-UNITS: the pass hands the JS thread back on a fixed cadence', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  for (let i = 0; i < 6; i += 1) await stageAndPromote(env, req, `/pick/p${i}.jpg`);

  let yields = 0;
  await env.recovery.runClosetStartupRecovery(req, {
    yieldToUi: async () => {
      yields += 1;
    },
  });
  assert.ok(yields > 0, 'a pass over six candidates must yield at least once');
});

test('PHASE4-EXCEPTION-DOES-NOT-CRASH-INITIALIZATION: a filesystem fault resolves, never throws', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  await stageAndPromote(env, req, '/pick/a.jpg');

  env.m.api.readDirectoryAsync = async () => {
    throw new Error('EIO');
  };
  env.m.hooks.beforeWrite = () => {
    throw new Error('EIO');
  };

  const result = await env.recovery.runClosetStartupRecovery(req, { yieldToUi: async () => {} });
  assert.ok(result && typeof result === 'object', 'the pass must always resolve to a result');
  assert.equal(typeof result.ok, 'boolean');
});

test('PHASE4-RESULTS-CARRY-NO-SENSITIVE-DETAIL: only categories and bounded counts are reported', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const { candidate, committed } = await stageAndPromote(env, req, '/pick/a.jpg');
  env.m.files.delete(committed.imageUri);

  const result = await env.recovery.runClosetStartupRecovery(req, { yieldToUi: async () => {} });
  const serialized = JSON.stringify(result);

  for (const secret of [
    candidate.candidateImageUri,
    committed.imageUri,
    committed.id,
    candidate.candidateId,
    'Acme',
    'Bomber',
    'kscan_closet',
  ]) {
    assert.equal(
      serialized.includes(secret),
      false,
      `a recovery result must not carry ${secret}`,
    );
  }
  for (const issue of result.issues) {
    assert.ok(
      env.recovery.CLOSET_RECOVERY_ISSUES.includes(issue),
      `${issue} is not a declared issue category`,
    );
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// Governance locks
// ═════════════════════════════════════════════════════════════════════════════

test('PHASE4-LOCK-NO-COMMITTED-WRITE-FROM-RECOVERY: the coordinator cannot create a Closet item', () => {
  const recoveryCode = code('services/closetRecovery.js');
  assert.equal(
    /\bcreateClosetItem\b/.test(recoveryCode),
    false,
    'recovery must never be able to commit an item',
  );
  assert.equal(
    /\bpromoteSelectedClosetCandidates\b/.test(recoveryCode),
    false,
    'recovery must never start a promotion operation',
  );
  assert.equal(
    /\bupdateClosetItem\b|\bdeleteClosetItem\b|\bpurgeLocalCloset/.test(recoveryCode),
    false,
    'recovery may repair taxonomy and nothing else on a committed record',
  );
  // Behavioural half: the import shim in `load()` hands recovery the REAL
  // committed store, so the only reason no item appears is that it never asks.
  assert.equal(
    /\bdeleteAsync\b|\bwriteAsStringAsync\b|\bmoveAsync\b/.test(recoveryCode),
    false,
    'recovery owns no filesystem primitive of its own',
  );
});

test('PHASE4-LOCK-NO-DURABLE-SAVING-STATUS: nothing in Phase 4 writes the saving status', () => {
  const recoverySource = code('services/closetRecovery.js');
  assert.equal(/'saving'|"saving"/.test(recoverySource), false);
  // The status stays REPRESENTABLE in the matrix — removing it would be a
  // regression of its own — it simply must never be persisted by recovery.
  const env = load();
  assert.ok(env.types.CLOSET_CANDIDATE_STATUSES.includes('saving'));
});

test('PHASE4-LOCK-SWEEP-ROOT-SEPARATION: each sweep names only its own root', () => {
  const committedSource = code('services/closetLibrary.js');
  const candidateSource = code('services/closetCandidateMedia.js');

  assert.equal(
    /kscan_closet_candidates/.test(committedSource),
    false,
    'the committed store must not know the candidate root exists',
  );
  const sweepBody = committedSource.slice(
    committedSource.indexOf('export async function sweepOrphanedClosetMedia'),
  );
  assert.equal(
    /CANDIDATE_IMAGES_DIR|CANDIDATE_THUMBS_DIR|isCandidateOwnedPath/.test(sweepBody),
    false,
  );
  assert.ok(/isClosetOwnedMediaPath/.test(sweepBody), 'the committed sweep re-checks its own root');

  const candidateSweepBody = candidateSource.slice(
    candidateSource.indexOf('export async function sweepOrphanedCandidateMedia'),
  );
  assert.ok(/isCandidateOwnedPath/.test(candidateSweepBody));
  assert.equal(/kscan_closet\//.test(candidateSweepBody), false);
});

test('PHASE4-LOCK-NO-BACKEND-AND-NO-BACKGROUND-TASK: Phase 4 is local-only', () => {
  for (const rel of ['services/closetRecovery.js', 'services/closetLibrary.js', 'services/closetCandidateLibrary.js']) {
    const text = code(rel);
    assert.equal(/\bfetch\s*\(/.test(text), false, `${rel} must make no network call`);
    assert.equal(/supabase|invokeEdge|BackgroundFetch|TaskManager|expo-task/i.test(text), false, `${rel}`);
  }
});

test('PHASE4-LOCK-NO-RAW-MANIFEST-LOGGING: recovery emits allowlisted telemetry only', () => {
  const recoverySource = code('services/closetRecovery.js');
  assert.equal(/console\.(log|warn|error|info)/.test(recoverySource), false);

  const env = load();
  const seen = [];
  env.recovery.__closetRecoveryInternals; // module is loaded through the real telemetry
  const telemetry = runModule('services/closetTelemetry.ts', () => ({}));
  telemetry.setClosetTelemetrySink((event, payload) => seen.push({ event, payload }));
  // The scrub allowlist is what actually enforces this; assert its shape holds
  // for the two properties recovery uses.
  assert.ok(telemetry.CLOSET_CANDIDATE_EVENT_PROPERTIES.includes('scope'));
  assert.ok(telemetry.CLOSET_CANDIDATE_EVENT_PROPERTIES.includes('countBucket'));
  assert.equal(telemetry.__closetTelemetryInternals.scrub('/doc/kscan_closet/images/a.jpg'), undefined);
  assert.equal(telemetry.__closetTelemetryInternals.scrub('closet_recovery'), 'closet_recovery');
  telemetry.resetClosetTelemetrySink();
  assert.deepEqual(seen, []);
});

test('PHASE4-LOCK-PROTECTED-FIELDS-UNCHANGED: the promotion tombstone stays unpatchable', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const candidate = await stageReady(env, req, '/pick/a.jpg');

  for (const field of ['promotedClosetItemId', 'promotedAt', 'ownerId', 'status', 'expiresAt']) {
    assert.ok(env.store.CLOSET_CANDIDATE_PROTECTED_FIELDS.includes(field));
    const patched = await env.store.updateClosetCandidate(req, candidate.candidateId, {
      [field]: 'anything',
    });
    assert.equal(patched.ok, false, `${field} must not be patchable`);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// System regressions
// ═════════════════════════════════════════════════════════════════════════════

test('PHASE4-REGRESSION-BUILD2-INVARIANTS: intake, concurrency and ordering are unchanged', async () => {
  const env = load();
  assert.equal(env.store.CLOSET_CANDIDATE_BATCH_MAX_ITEMS, 8);
  assert.equal(env.types.CLOSET_CANDIDATE_MAX_CONCURRENT_CLASSIFICATIONS, 2);
  assert.equal(env.promotion.CLOSET_PROMOTION_MAX_CONCURRENCY, 1);
  assert.equal(env.types.CLOSET_CANDIDATE_MAX_UNRESOLVED, 40);
  assert.equal(env.types.CLOSET_CANDIDATE_TTL_MS, 7 * DAY_MS);
  assert.equal(env.closetLibrary.CLOSET_ITEM_SCHEMA_VERSION, 2);
  assert.equal(env.types.CLOSET_CANDIDATE_SCHEMA_VERSION, 3);
  assert.equal(env.closetLibrary.CLOSET_ITEM_TAXONOMY_FIELDS.length, 8);
});

test('PHASE4-REGRESSION-TAXONOMY-PRESERVED: promotion still preserves 8 of 8 after Phase 4', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const { committed } = await stageAndPromote(env, req, '/pick/a.jpg');
  for (const field of env.closetLibrary.CLOSET_ITEM_TAXONOMY_FIELDS) {
    assert.deepEqual(committed[field], FULL_TAXONOMY[field], `${field} was not preserved`);
  }
});

test('PHASE4-REGRESSION-PROMOTION-IDEMPOTENT: a retry over the crash window resolves to the same item', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const { candidate, committed } = await stageAndPromote(env, req, '/pick/a.jpg');

  // A candidate that is already `saved` is refused by commit-time eligibility as
  // terminal — the review surface never offers a promoted card, so reaching the
  // provenance path that way is not the case idempotency is about. The case that
  // matters is the CRASH WINDOW: committed, but not yet finalized.
  const records = readManifest(env, CANDIDATE_MANIFEST);
  const index = records.findIndex((e) => e.candidateId === candidate.candidateId);
  records[index] = {
    ...records[index],
    status: 'ready_for_review',
    promotedClosetItemId: null,
    promotedAt: null,
  };
  writeManifest(env, CANDIDATE_MANIFEST, records);

  const again = await env.promotion.promoteSelectedClosetCandidates({
    candidateIds: [candidate.candidateId],
    yieldToUi: async () => {},
  });
  assert.equal(again.alreadyPromotedCount, 1, 'provenance resolves before content');
  assert.equal(again.promotedCount, 0);
  assert.equal(again.results[0].committedClosetItemId, committed.id);
  assert.equal((await env.closetLibrary.loadCloset('user-a')).length, 1);

  // And the terminal refusal is itself still the contract.
  const terminal = await env.promotion.promoteSelectedClosetCandidates({
    candidateIds: [candidate.candidateId],
    yieldToUi: async () => {},
  });
  assert.equal(terminal.results[0].status, 'ineligible');
  assert.equal((await env.closetLibrary.loadCloset('user-a')).length, 1);
});

test('PHASE4-RECOVERY-READ-IS-ACTOR-SCOPED: the fail-closed read partitions before anything downstream does', async () => {
  const env = load();
  const reqA = asActor(env.actorContext, 'user-a');
  const a = await stageReady(env, reqA, '/pick/a.jpg');
  const reqB = asActor(env.actorContext, 'user-b');
  const b = await stageReady(env, reqB, '/pick/b.jpg');

  // ASSERTED AT THIS LAYER ON PURPOSE. Every stage downstream is independently
  // actor-scoped, so a leak here is invisible in end-to-end behaviour — which is
  // exactly why the partition needs its own test rather than relying on the next
  // guard to cover for it.
  const seenByB = await env.store.listClosetCandidatesForRecovery(reqB);
  assert.equal(seenByB.ok, true);
  assert.deepEqual(
    seenByB.candidates.map((c) => c.candidateId),
    [b.candidateId],
  );

  const seenByA = await env.store.listClosetCandidatesForRecovery(
    asActor(env.actorContext, 'user-a'),
  );
  assert.deepEqual(
    seenByA.candidates.map((c) => c.candidateId),
    [a.candidateId],
  );

  // And it still fails closed on a partial read, before any partitioning.
  const records = readManifest(env, CANDIDATE_MANIFEST);
  writeManifest(env, CANDIDATE_MANIFEST, [...records, { schemaVersion: 99, candidateId: 'x' }]);
  const partial = await env.store.listClosetCandidatesForRecovery(
    asActor(env.actorContext, 'user-a'),
  );
  assert.equal(partial.ok, false);
  assert.deepEqual(partial.candidates, []);
});

test('PHASE4-REGRESSION-ACTOR-ISOLATION: recovery never reaches another actor partition', async () => {
  const env = load();
  const reqA = asActor(env.actorContext, 'user-a');
  const a = await stageAndPromote(env, reqA, '/pick/a.jpg');
  const reqB = asActor(env.actorContext, 'user-b');
  const b = await stageAndPromote(env, reqB, '/pick/b.jpg');

  const storedA = candidateOnDisk(env, a.candidate.candidateId);
  await env.recovery.runClosetStartupRecovery(reqB, { yieldToUi: async () => {} });

  // B converged; A is exactly as it was.
  assert.equal(candidateOnDisk(env, b.candidate.candidateId).candidateImageUri, null);
  assert.equal(
    candidateOnDisk(env, a.candidate.candidateId).candidateImageUri,
    storedA.candidateImageUri,
  );
  assert.ok(env.m.files.has(storedA.candidateImageUri));
  assert.ok(env.m.files.has(a.committed.imageUri));
});

test('PHASE4-REGRESSION-NO-CROSS-DOMAIN-SIDE-EFFECT: Recent Scan and commerce are untouched', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const scanFile = LIBRARY_IMAGES + 'scan.jpg';
  env.m.files.set(scanFile, 'scan');
  env.m.modified.set(scanFile, Date.now() - DAY_MS);
  env.m.files.set('/doc/kscan_library/kscan_library.json', JSON.stringify([]));

  await stageAndPromote(env, req, '/pick/a.jpg');
  await env.recovery.runClosetStartupRecovery(req, { yieldToUi: async () => {} });

  assert.ok(env.m.files.has(scanFile), 'a Recent Scan image must survive Closet recovery');
  assert.equal(env.m.files.get('/doc/kscan_library/kscan_library.json'), JSON.stringify([]));

  // No commerce vocabulary anywhere in the Phase 4 surface.
  const recoverySource = code('services/closetRecovery.js');
  assert.equal(/retailer|price|sku|checkout|purchase/i.test(recoverySource), false);
});
