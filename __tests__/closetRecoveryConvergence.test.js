// CLOSET RECOVERY CONVERGENCE: the crash window, the recovery matrix, and
// candidate-media cleanup (Build 2, Phase 4).
//
// THE WINDOW THIS SUITE EXISTS FOR. Phase 3 deliberately finalizes a candidate
// AFTER the committed item is durable, so a process death in between leaves a
// committed Closet item and a candidate that still looks reviewable. That is the
// safe choice — the alternative loses the user's item — but on its own it is only
// half a design. The characterization test below is that half-state written down;
// everything after it is the convergence contract that closes it.
//
// The real stores run against an in-memory filesystem. Nothing is stubbed on the
// paths under test: the committed store, the candidate store, the promotion
// coordinator and the recovery coordinator are all the production modules.

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
  const hooks = { beforeWrite: null, beforeDelete: null };
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
  const contract = runModule('services/closetCandidatePromotionContract.ts', (s) => {
    throw new Error(`the promotion contract must import nothing: ${s}`);
  });
  const batchReview = runModule('services/closetBatchReview.ts', (s) => {
    if (s === '../types/closetCandidate') return types;
    if (s === './closetCandidateStateMachine') return stateMachine;
    if (s === './closetCandidateErrors') return candidateErrors;
    if (s === './closetCandidateReviewEligibility') return eligibility;
    if (s === './closetCandidatePromotionContract') return contract;
    throw new Error(`the projection must not import ${s}`);
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
  // THE RECOVERY COORDINATOR'S IMPORT SURFACE IS ITSELF A LOCK. A shim that
  // refuses anything unexpected proves it cannot reach the network, React, or a
  // module that would let it invent a third source of truth.
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

  return { m, actorContext, closetLibrary, store, schema, types, batchReview, promotion, recovery };
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const CANDIDATE_MANIFEST = '/doc/kscan_closet_candidates/kscan_closet_candidates.json';
const CLOSET_MANIFEST = '/doc/kscan_closet/kscan_closet.json';

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

function readManifest(env, manifestPath) {
  const raw = env.m.files.get(manifestPath);
  return raw ? JSON.parse(raw) : [];
}

function writeManifest(env, manifestPath, records) {
  env.m.files.set(manifestPath, JSON.stringify(records));
  env.m.modified.set(manifestPath, Date.now());
}

/**
 * Rewind a finalized candidate to the state a crash between the committed write
 * and finalization leaves. Written straight to disk on purpose: the store has no
 * API for un-finalizing a promotion, and it must not grow one.
 */
function simulateCrashBeforeFinalization(env, candidateId) {
  const records = readManifest(env, CANDIDATE_MANIFEST);
  const index = records.findIndex((entry) => entry.candidateId === candidateId);
  assert.notEqual(index, -1, 'candidate not on disk');
  records[index] = {
    ...records[index],
    status: 'ready_for_review',
    promotedClosetItemId: null,
    promotedAt: null,
  };
  writeManifest(env, CANDIDATE_MANIFEST, records);
}

function candidateOnDisk(env, candidateId) {
  return readManifest(env, CANDIDATE_MANIFEST).find(
    (entry) => entry.candidateId === candidateId,
  );
}

async function promoteOne(env, candidateId) {
  return env.promotion.promoteSelectedClosetCandidates({
    candidateIds: [candidateId],
    yieldToUi: async () => {},
  });
}

/** A fully promoted candidate, plus the committed item it became. */
async function stageAndPromote(env, req, uri, taxonomy = FULL_TAXONOMY) {
  const candidate = await stageReady(env, req, uri, taxonomy);
  const result = await promoteOne(env, candidate.candidateId);
  assert.equal(result.promotedCount, 1, `promotion failed: ${JSON.stringify(result.results)}`);
  const committed = await env.closetLibrary.findClosetItemBySourceCandidate(
    candidate.candidateId,
    req.actorId ?? null,
  );
  assert.ok(committed, 'committed item missing after promotion');
  return { candidate, committed };
}

// ── Characterization ─────────────────────────────────────────────────────────

test('PHASE4-CHARACTERIZATION: a crash between the committed write and finalization leaves a committed item beside an unfinalized candidate', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const { candidate, committed } = await stageAndPromote(env, req, '/pick/a.jpg');

  simulateCrashBeforeFinalization(env, candidate.candidateId);

  // The Closet is correct. The candidate is not.
  const closet = await env.closetLibrary.loadCloset('user-a');
  assert.equal(closet.length, 1);
  assert.equal(closet[0].id, committed.id);

  const stranded = candidateOnDisk(env, candidate.candidateId);
  assert.equal(stranded.status, 'ready_for_review');
  assert.equal(stranded.promotedClosetItemId, null);
  // And its media is still there, because Phase 3 never cleans it up.
  assert.ok(env.m.files.has(stranded.candidateImageUri));
});

// ── Case A: nothing committed ────────────────────────────────────────────────

test('PHASE4-CASE-A: a ready candidate with no committed item is left recoverable and is never auto-promoted', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const candidate = await stageReady(env, req, '/pick/a.jpg');

  const result = await env.recovery.runClosetStartupRecovery(req, { yieldToUi: async () => {} });

  assert.equal(result.ok, true);
  assert.equal(result.finalizedCount, 0);
  assert.equal(result.cleanedCount, 0);

  // NOTHING WAS COMMITTED. Startup does not spend the user's Closet for them.
  assert.deepEqual(await env.closetLibrary.loadCloset('user-a'), []);

  const after = candidateOnDisk(env, candidate.candidateId);
  assert.equal(after.status, 'ready_for_review');
  assert.ok(env.m.files.has(after.candidateImageUri), 'candidate media must survive');

  // Still selectable, exactly as before.
  const projection = env.batchReview.getClosetBatchReviewProjection({
    actorId: 'user-a',
    candidates: [after],
  });
  assert.equal(projection.activeGroup.items[0].selectionEligible, true);
});

// ── Case B: committed, unfinalized ───────────────────────────────────────────

test('PHASE4-CASE-B: recovery finalizes a candidate whose committed item already exists', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const { candidate, committed } = await stageAndPromote(env, req, '/pick/a.jpg');
  simulateCrashBeforeFinalization(env, candidate.candidateId);

  const result = await env.recovery.runClosetStartupRecovery(req, { yieldToUi: async () => {} });

  assert.equal(result.finalizedCount, 1);
  const after = candidateOnDisk(env, candidate.candidateId);
  assert.equal(after.status, 'saved');
  assert.equal(after.promotedClosetItemId, committed.id);
  assert.ok(after.promotedAt, 'finalization must stamp promotedAt');
});

test('PHASE4-NO-DUPLICATE-ITEM: recovery never creates a second committed item', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const { candidate, committed } = await stageAndPromote(env, req, '/pick/a.jpg');
  simulateCrashBeforeFinalization(env, candidate.candidateId);

  await env.recovery.runClosetStartupRecovery(req, { yieldToUi: async () => {} });

  const closet = await env.closetLibrary.loadCloset('user-a');
  assert.equal(closet.length, 1, 'recovery must not mint a second committed item');
  assert.equal(closet[0].id, committed.id);
});

test('PHASE4-NO-MEDIA-RECOPY: recovery does not rewrite the committed media it verified', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const { candidate, committed } = await stageAndPromote(env, req, '/pick/a.jpg');
  simulateCrashBeforeFinalization(env, candidate.candidateId);

  const before = env.m.files.get(committed.imageUri);
  const beforeMtime = env.m.modified.get(committed.imageUri);
  const beforeCount = [...env.m.files.keys()].filter((k) =>
    k.startsWith('/doc/kscan_closet/images/'),
  ).length;

  await env.recovery.runClosetStartupRecovery(req, { yieldToUi: async () => {} });

  assert.equal(env.m.files.get(committed.imageUri), before, 'committed bytes changed');
  assert.equal(env.m.modified.get(committed.imageUri), beforeMtime, 'committed media rewritten');
  assert.equal(
    [...env.m.files.keys()].filter((k) => k.startsWith('/doc/kscan_closet/images/')).length,
    beforeCount,
    'recovery created an extra committed image',
  );
  const after = candidateOnDisk(env, candidate.candidateId);
  assert.equal(after.promotedClosetItemId, committed.id);
});

// ── Case C: legacy taxonomy repair ───────────────────────────────────────────

test('PHASE4-CASE-C: a legacy committed item missing taxonomy is repaired in place, then finalized', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const { candidate, committed } = await stageAndPromote(env, req, '/pick/a.jpg');
  simulateCrashBeforeFinalization(env, candidate.candidateId);

  // Rewind the committed record to what Phase 3 could store: a category only.
  const items = readManifest(env, CLOSET_MANIFEST);
  const index = items.findIndex((item) => item.id === committed.id);
  items[index] = {
    ...items[index],
    schemaVersion: 1,
    clothingType: null,
    subtype: null,
    brand: null,
    primaryColor: null,
    secondaryColors: [],
    material: [],
    size: null,
  };
  writeManifest(env, CLOSET_MANIFEST, items);

  const result = await env.recovery.runClosetStartupRecovery(req, { yieldToUi: async () => {} });

  assert.equal(result.repairedCount, 1);
  assert.equal(result.finalizedCount, 0, 'a repair is reported as a repair, not a bare finalize');

  const repaired = await env.closetLibrary.findClosetItemBySourceCandidate(
    candidate.candidateId,
    'user-a',
  );
  assert.equal(repaired.id, committed.id, 'the committed id must be preserved');
  assert.equal(repaired.imageUri, committed.imageUri, 'the committed media must be preserved');
  assert.equal(repaired.brand, 'Acme');
  assert.equal(repaired.subtype, 'Bomber');
  assert.deepEqual(repaired.material, ['Wool', 'Nylon']);

  assert.equal(candidateOnDisk(env, candidate.candidateId).status, 'saved');
});

test('PHASE4-CASE-C-CONFLICT: conflicting user-managed taxonomy fails closed and the candidate is not finalized', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const { candidate, committed } = await stageAndPromote(env, req, '/pick/a.jpg');
  simulateCrashBeforeFinalization(env, candidate.candidateId);

  // The user edited the category on the committed item. That is not a gap.
  const items = readManifest(env, CLOSET_MANIFEST);
  const index = items.findIndex((item) => item.id === committed.id);
  items[index] = { ...items[index], category: 'Knitwear' };
  writeManifest(env, CLOSET_MANIFEST, items);

  const result = await env.recovery.runClosetStartupRecovery(req, { yieldToUi: async () => {} });

  assert.ok(result.issues.includes('taxonomy_conflict'));
  assert.equal(result.finalizedCount, 0);
  assert.equal(result.repairedCount, 0);
  assert.equal(candidateOnDisk(env, candidate.candidateId).status, 'ready_for_review');

  // The user's edit is untouched.
  const item = await env.closetLibrary.findClosetItemBySourceCandidate(
    candidate.candidateId,
    'user-a',
  );
  assert.equal(item.category, 'Knitwear');
});

// ── Case D: committed media invalid ──────────────────────────────────────────

test('PHASE4-CASE-D: missing committed media prevents finalization and retains candidate media', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const { candidate, committed } = await stageAndPromote(env, req, '/pick/a.jpg');
  simulateCrashBeforeFinalization(env, candidate.candidateId);

  env.m.files.delete(committed.imageUri);

  const result = await env.recovery.runClosetStartupRecovery(req, { yieldToUi: async () => {} });

  assert.ok(result.issues.includes('committed_media_invalid'));
  assert.equal(result.finalizedCount, 0);

  const after = candidateOnDisk(env, candidate.candidateId);
  assert.equal(after.status, 'ready_for_review', 'the candidate stays recoverable');
  assert.ok(env.m.files.has(after.candidateImageUri), 'candidate media must be retained');

  // And the committed record was NOT repointed at candidate-owned media.
  const item = await env.closetLibrary.findClosetItemBySourceCandidate(
    candidate.candidateId,
    'user-a',
  );
  assert.equal(item.imageUri, committed.imageUri);
});

// ── Case E / F: candidate-media cleanup ──────────────────────────────────────

test('PHASE4-CASE-E: a verified promoted candidate has its own media released', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const { candidate, committed } = await stageAndPromote(env, req, '/pick/a.jpg');

  const stored = candidateOnDisk(env, candidate.candidateId);
  const candidateImage = stored.candidateImageUri;
  const candidateThumb = stored.candidateThumbnailUri;
  assert.ok(env.m.files.has(candidateImage));

  const result = await env.recovery.runClosetStartupRecovery(req, { yieldToUi: async () => {} });

  assert.equal(result.cleanedCount, 1);
  assert.equal(env.m.files.has(candidateImage), false, 'candidate image must be unlinked');
  assert.equal(env.m.files.has(candidateThumb), false, 'candidate thumbnail must be unlinked');

  // THE COMMITTED ITEM IS UNTOUCHED — id, media path, and bytes.
  const item = await env.closetLibrary.findClosetItemBySourceCandidate(
    candidate.candidateId,
    'user-a',
  );
  assert.equal(item.id, committed.id);
  assert.equal(item.imageUri, committed.imageUri);
  assert.ok(env.m.files.has(committed.imageUri));

  // The tombstone survives, with its media references cleared.
  const after = candidateOnDisk(env, candidate.candidateId);
  assert.equal(after.status, 'saved');
  assert.equal(after.candidateImageUri, null);
  assert.equal(after.promotedClosetItemId, committed.id);
});

test('PHASE4-CASE-E-IDEMPOTENT: repeated recovery passes converge once and stay converged', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const { candidate, committed } = await stageAndPromote(env, req, '/pick/a.jpg');
  simulateCrashBeforeFinalization(env, candidate.candidateId);

  const first = await env.recovery.runClosetStartupRecovery(req, { yieldToUi: async () => {} });
  assert.equal(first.finalizedCount, 1);

  // A relaunch: same actor, new epoch, same disk.
  const relaunch = asActor(env.actorContext, 'user-a');
  const second = await env.recovery.runClosetStartupRecovery(relaunch, { yieldToUi: async () => {} });
  const third = await env.recovery.runClosetStartupRecovery(
    asActor(env.actorContext, 'user-a'),
    { yieldToUi: async () => {} },
  );

  assert.equal(second.finalizedCount, 0);
  assert.equal(third.finalizedCount, 0);
  assert.equal(third.cleanedCount, 0, 'nothing is cleaned twice');

  const closet = await env.closetLibrary.loadCloset('user-a');
  assert.equal(closet.length, 1);
  assert.equal(closet[0].id, committed.id);
  assert.ok(env.m.files.has(committed.imageUri));
  assert.equal(candidateOnDisk(env, candidate.candidateId).candidateImageUri, null);
});

test('PHASE4-CASE-F: a tombstone whose committed item is gone keeps its media and reports an issue', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const { candidate } = await stageAndPromote(env, req, '/pick/a.jpg');

  // The committed record disappears; the tombstone does not.
  writeManifest(env, CLOSET_MANIFEST, []);

  const stored = candidateOnDisk(env, candidate.candidateId);
  const result = await env.recovery.runClosetStartupRecovery(req, { yieldToUi: async () => {} });

  assert.ok(result.issues.includes('committed_missing'));
  assert.equal(result.cleanedCount, 0);
  assert.equal(result.retiredCount, 0);
  assert.ok(env.m.files.has(stored.candidateImageUri), 'uncertain media is retained');
  assert.equal(candidateOnDisk(env, candidate.candidateId).status, 'saved');
});

test('PHASE4-CLEANUP-BLOCKED-ON-TAXONOMY: an unverifiable committed taxonomy retains candidate media', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const { candidate, committed } = await stageAndPromote(env, req, '/pick/a.jpg');

  const items = readManifest(env, CLOSET_MANIFEST);
  const index = items.findIndex((item) => item.id === committed.id);
  // The committed record loses a field the candidate carried: a gap, not an edit.
  items[index] = { ...items[index], subtype: null };
  writeManifest(env, CLOSET_MANIFEST, items);

  const stored = candidateOnDisk(env, candidate.candidateId);
  const result = await env.recovery.runClosetStartupRecovery(req, { yieldToUi: async () => {} });

  assert.ok(result.issues.includes('taxonomy_unverified'));
  assert.equal(result.cleanedCount, 0);
  assert.ok(env.m.files.has(stored.candidateImageUri));
});

// ── Actor and epoch isolation ────────────────────────────────────────────────

test('PHASE4-ENTRY-ACTOR-GUARD: a stale request is rejected before recovery starts', () => {
  const source = fs.readFileSync(path.join(ROOT, 'services/closetRecovery.js'), 'utf8');
  const entry = source.slice(
    source.indexOf('export async function runClosetStartupRecovery'),
    source.indexOf('const key = recoveryKey(actorRequest)'),
  );
  assert.match(entry, /if \(!isActorRequestCurrent\(actorRequest\)\) return emptyResult\('actor_stale'\)/);
});

test('PHASE4-ACTOR-CHANGE: a recovery pass whose actor changed mutates nothing further', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const { candidate } = await stageAndPromote(env, req, '/pick/a.jpg');
  simulateCrashBeforeFinalization(env, candidate.candidateId);

  const stored = candidateOnDisk(env, candidate.candidateId);

  // The actor moves before the pass is asked to run.
  asActor(env.actorContext, 'user-b');

  const result = await env.recovery.runClosetStartupRecovery(req, { yieldToUi: async () => {} });

  assert.equal(result.stopReason, 'actor_stale');
  assert.equal(result.finalizedCount, 0);
  assert.equal(result.cleanedCount, 0);
  const after = candidateOnDisk(env, candidate.candidateId);
  assert.equal(after.status, 'ready_for_review');
  assert.ok(env.m.files.has(stored.candidateImageUri));
});

test('PHASE4-EPOCH-CHANGE: the same actor id at a new epoch cannot settle the old pass', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const { candidate } = await stageAndPromote(env, req, '/pick/a.jpg');
  simulateCrashBeforeFinalization(env, candidate.candidateId);

  // Sign out and back in as the same user: id identical, epoch advanced.
  asActor(env.actorContext, null);
  asActor(env.actorContext, 'user-a');

  const result = await env.recovery.runClosetStartupRecovery(req, { yieldToUi: async () => {} });
  assert.equal(result.stopReason, 'actor_stale');
  assert.equal(candidateOnDisk(env, candidate.candidateId).status, 'ready_for_review');
});

test('PHASE4-ACTOR-CHANGE-MIDPASS: an actor change between units stops the dequeue', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const a = await stageAndPromote(env, req, '/pick/a.jpg');
  const b = await stageAndPromote(env, req, '/pick/b.jpg');
  simulateCrashBeforeFinalization(env, a.candidate.candidateId);
  simulateCrashBeforeFinalization(env, b.candidate.candidateId);

  let units = 0;
  const result = await env.recovery.runClosetStartupRecovery(req, {
    yieldToUi: async () => {},
    // The pass yields on a fixed cadence; steal the actor at the first boundary.
    shouldContinue: () => {
      units += 1;
      if (units === 1) env.actorContext.advanceActorEpoch('user-b');
      return true;
    },
  });

  assert.equal(result.complete, false);
  assert.equal(result.stopReason, 'actor_stale');
  const statuses = [a, b].map((entry) => candidateOnDisk(env, entry.candidate.candidateId).status);
  assert.ok(
    statuses.filter((status) => status === 'saved').length <= 1,
    'at most the unit already in flight may settle',
  );
});

test('PHASE4-BACKGROUNDED: a cancelled pass stops at a safe checkpoint and is not memoized', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const a = await stageAndPromote(env, req, '/pick/a.jpg');
  const b = await stageAndPromote(env, req, '/pick/b.jpg');
  simulateCrashBeforeFinalization(env, a.candidate.candidateId);
  simulateCrashBeforeFinalization(env, b.candidate.candidateId);

  let calls = 0;
  const stopped = await env.recovery.runClosetStartupRecovery(req, {
    yieldToUi: async () => {},
    shouldContinue: () => {
      calls += 1;
      return calls < 2;
    },
  });
  assert.equal(stopped.complete, false);
  assert.equal(stopped.stopReason, 'backgrounded');

  // NOT MEMOIZED. The next foreground for the same epoch retries and finishes.
  const resumed = await env.recovery.runClosetStartupRecovery(req, { yieldToUi: async () => {} });
  assert.equal(resumed.complete, true);
  assert.equal(candidateOnDisk(env, a.candidate.candidateId).status, 'saved');
  assert.equal(candidateOnDisk(env, b.candidate.candidateId).status, 'saved');
});

// ── Single flight ────────────────────────────────────────────────────────────

test('PHASE4-SINGLE-FLIGHT: concurrent starts for one actor epoch collapse into one pass', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const { candidate } = await stageAndPromote(env, req, '/pick/a.jpg');
  simulateCrashBeforeFinalization(env, candidate.candidateId);

  const [first, second, third] = await Promise.all([
    env.recovery.runClosetStartupRecovery(req, { yieldToUi: async () => {} }),
    env.recovery.runClosetStartupRecovery(req, { yieldToUi: async () => {} }),
    env.recovery.runClosetStartupRecovery(req, { yieldToUi: async () => {} }),
  ]);

  assert.equal(first.passId, second.passId);
  assert.equal(second.passId, third.passId);
  assert.equal(first.finalizedCount, 1);
  assert.equal(env.recovery.isClosetRecoveryRunning(), false);
});

test('PHASE4-COMPLETED-PASS-IS-SKIPPED: a second call for a completed epoch does no work', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  await stageReady(env, req, '/pick/a.jpg');

  const first = await env.recovery.runClosetStartupRecovery(req, { yieldToUi: async () => {} });
  assert.equal(first.complete, true);

  const second = await env.recovery.runClosetStartupRecovery(req, { yieldToUi: async () => {} });
  assert.equal(second.stopReason, 'already_complete');
  assert.equal(second.passId, null);
});

test('PHASE4-NEW-ACTOR-GETS-ITS-OWN-PASS: a different epoch is never skipped', async () => {
  const env = load();
  const reqA = asActor(env.actorContext, 'user-a');
  await stageReady(env, reqA, '/pick/a.jpg');
  await env.recovery.runClosetStartupRecovery(reqA, { yieldToUi: async () => {} });

  const reqB = asActor(env.actorContext, 'user-b');
  const { candidate } = await stageAndPromote(env, reqB, '/pick/b.jpg');
  simulateCrashBeforeFinalization(env, candidate.candidateId);

  const result = await env.recovery.runClosetStartupRecovery(reqB, { yieldToUi: async () => {} });
  assert.equal(result.finalizedCount, 1);
  assert.equal(candidateOnDisk(env, candidate.candidateId).status, 'saved');

  // The other actor's record is untouched by this pass.
  const foreign = readManifest(env, CANDIDATE_MANIFEST).filter(
    (entry) => entry.ownerId === 'user-a',
  );
  assert.equal(foreign.length, 1);
  assert.equal(foreign[0].status, 'ready_for_review');
});

// ── Fail-closed reads ────────────────────────────────────────────────────────

test('PHASE4-CORRUPT-CANDIDATE-MANIFEST: an incomplete read refuses the whole pass and deletes nothing', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const { candidate } = await stageAndPromote(env, req, '/pick/a.jpg');
  const stored = candidateOnDisk(env, candidate.candidateId);

  // One record this build cannot interpret is enough to make the reference set
  // incomplete, and incomplete is not a licence to delete.
  const records = readManifest(env, CANDIDATE_MANIFEST);
  writeManifest(env, CANDIDATE_MANIFEST, [...records, { schemaVersion: 99, candidateId: 'x' }]);

  const result = await env.recovery.runClosetStartupRecovery(req, { yieldToUi: async () => {} });

  assert.equal(result.ok, false);
  assert.equal(result.stopReason, 'store_unreadable');
  assert.equal(result.cleanedCount, 0);
  assert.equal(result.retiredCount, 0);
  assert.ok(env.m.files.has(stored.candidateImageUri), 'nothing may be deleted on a partial read');
  assert.equal(readManifest(env, CANDIDATE_MANIFEST).length, 2, 'the manifest is not rewritten');
});

test('PHASE4-UNPARSEABLE-CANDIDATE-MANIFEST: a corrupt manifest is neither interpreted nor rewritten', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  await stageAndPromote(env, req, '/pick/a.jpg');

  env.m.files.set(CANDIDATE_MANIFEST, '{ not json');

  const result = await env.recovery.runClosetStartupRecovery(req, { yieldToUi: async () => {} });
  assert.equal(result.ok, false);
  assert.equal(result.stopReason, 'store_unreadable');
  assert.equal(env.m.files.get(CANDIDATE_MANIFEST), '{ not json');
});

// ── Serialized writes ────────────────────────────────────────────────────────

test('PHASE4-SERIALIZED-WRITES: recovery writes only through the stores own mutation queues', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const { candidate } = await stageAndPromote(env, req, '/pick/a.jpg');
  simulateCrashBeforeFinalization(env, candidate.candidateId);

  // Every candidate-manifest write must be the atomic temp-then-swap the store
  // owns. A direct write onto the canonical path would mean recovery had grown
  // its own persistence.
  const writes = [];
  env.m.hooks.beforeWrite = (p) => {
    if (p.startsWith('/doc/kscan_closet_candidates/')) writes.push(p);
    return undefined;
  };

  await env.recovery.runClosetStartupRecovery(req, { yieldToUi: async () => {} });

  assert.ok(writes.length > 0, 'the pass must have persisted something');
  for (const target of writes) {
    assert.equal(
      target,
      CANDIDATE_MANIFEST + '.tmp',
      'recovery must not write the canonical manifest directly',
    );
  }
});

test('PHASE4-NO-PROMOTION-STARTED: recovery leaves the promotion coordinator idle', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  await stageReady(env, req, '/pick/a.jpg');
  await stageReady(env, req, '/pick/b.jpg');

  await env.recovery.runClosetStartupRecovery(req, { yieldToUi: async () => {} });

  assert.equal(env.promotion.getActiveClosetPromotion(), null);
  assert.deepEqual(await env.closetLibrary.loadCloset('user-a'), []);
});
