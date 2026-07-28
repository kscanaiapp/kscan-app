// COMMITTED PROVENANCE, STABLE MEDIA DESTINATION and the CANDIDATE PROMOTION
// TOMBSTONE (Closet Upgrade Build 2, Phase 3).
//
// services/closetLibrary.js, closetCandidateLibrary.js, closetCandidateMedia.js,
// closetCandidateSchema.js, library.js and actorContext.js are transpiled in
// process and run against an in-memory filesystem, so these exercise the REAL
// persistence logic with the REAL actor context — never a permissive double.
//
// WHAT THIS SUITE IS FOR: everything downstream of promotion depends on two
// claims. That the committed Closet can answer "has this actor already committed
// an item from this candidate?", and that asking twice cannot produce two items or
// two media files. Both are proven here against bytes on a disk.

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

/** In-memory filesystem. Content is real Base64 so byte comparison is real. */
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
    setModified(p, ms) {
      modified.set(p, ms);
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
      // Deterministic in the source and the width, so re-deriving the SAME
      // candidate image twice produces byte-identical output — which is what the
      // stable-destination reuse check is actually verifying.
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

  return { m, actorContext, library, closetLibrary, store, media, schema, types };
}

function asActor(actorContext, actorId) {
  actorContext.advanceActorEpoch(actorId);
  return actorContext.createActorRequest();
}

function seedSource(m, uri, marker = 'original') {
  m.files.set(uri, Buffer.from(`${marker}:${uri}`).toString('base64'));
  return uri;
}

async function stageReady(env, req, uri, overrides = {}) {
  const created = await env.store.createClosetCandidate(req, {
    sourceUri: uri,
    sourceType: 'gallery',
    ownerId: req?.actorId,
    ...overrides,
  });
  assert.equal(created.kind, 'created', `staging failed: ${created.code}`);
  const id = created.candidate.candidateId;
  await env.store.transitionClosetCandidate(req, id, { to: 'classifying' });
  const ready = await env.store.transitionClosetCandidate(req, id, {
    to: 'ready_for_review',
    patch: {
      category: 'Outerwear',
      clothingType: 'Jacket',
      primaryColor: 'Black',
      ...(overrides.classification ?? {}),
    },
  });
  assert.equal(ready.ok, true);
  return ready.candidate;
}

/** Commit a candidate the way the coordinator does: through the Closet service. */
async function commitFromCandidate(env, req, candidate, extra = {}) {
  return env.closetLibrary.createClosetItem({
    sourceUri: candidate.candidateImageUri,
    draft: {
      title: 'Jacket',
      category: candidate.category,
      origin: 'direct_intake',
      sourceCandidateId: candidate.candidateId,
      ...extra,
    },
    actorRequest: req,
    ownerId: req?.actorId ?? null,
  });
}

function imagesIn(m) {
  return [...m.files.keys()].filter((key) => key.startsWith('/doc/kscan_closet/images/'));
}

// ── Provenance ───────────────────────────────────────────────────────────────

test('a committed item stores the candidate it was promoted from', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');
  const candidate = await stageReady(env, req, '/picker/a.jpg');

  const committed = await commitFromCandidate(env, req, candidate);
  assert.equal(committed.ok, true);
  assert.equal(committed.item.sourceCandidateId, candidate.candidateId);
  assert.equal(committed.item.ownerId, 'user-a');

  // Present on the persisted record, not just on the returned object.
  const persisted = JSON.parse(env.m.files.get('/doc/kscan_closet/kscan_closet.json'));
  assert.equal(persisted[0].sourceCandidateId, candidate.candidateId);
});

test('provenance answers "has this actor already committed this candidate?"', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');
  const candidate = await stageReady(env, req, '/picker/a.jpg');

  assert.equal(
    await env.closetLibrary.findClosetItemBySourceCandidate(candidate.candidateId, 'user-a'),
    null,
  );
  const committed = await commitFromCandidate(env, req, candidate);
  const found = await env.closetLibrary.findClosetItemBySourceCandidate(
    candidate.candidateId,
    'user-a',
  );
  assert.ok(found);
  assert.equal(found.id, committed.item.id);
});

test('a pre-Build-2 Closet record stays readable and simply carries no provenance', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  // A record written before this phase existed: no sourceCandidateId key at all.
  env.m.files.set(
    '/doc/kscan_closet/kscan_closet.json',
    JSON.stringify([
      {
        schemaVersion: 1,
        id: 'closet_legacy',
        ownerId: 'user-a',
        imageUri: '/doc/kscan_closet/images/legacy.jpg',
        thumbnailUri: null,
        title: 'Legacy item',
        category: 'Shirt',
        notes: null,
        origin: 'direct_intake',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]),
  );

  const items = await env.closetLibrary.loadCloset('user-a');
  assert.equal(items.length, 1);
  assert.equal(items[0].id, 'closet_legacy');
  assert.equal(items[0].sourceCandidateId, undefined);
  assert.equal(
    await env.closetLibrary.findClosetItemBySourceCandidate('candidate_x', 'user-a'),
    null,
  );

  // And a new promotion coexists with it rather than replacing it.
  seedSource(env.m, '/picker/a.jpg');
  const candidate = await stageReady(env, req, '/picker/a.jpg');
  const committed = await commitFromCandidate(env, req, candidate);
  assert.equal(committed.ok, true);
  const after = await env.closetLibrary.loadCloset('user-a');
  assert.equal(after.length, 2);
  assert.ok(after.some((item) => item.id === 'closet_legacy'));
});

test('provenance survives an ordinary metadata update and cannot be patched', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');
  const candidate = await stageReady(env, req, '/picker/a.jpg');
  const committed = await commitFromCandidate(env, req, candidate);

  const updated = await env.closetLibrary.updateClosetItem(
    committed.item.id,
    {
      title: 'Renamed',
      notes: 'a note',
      // A caller trying to reassign or forge provenance.
      sourceCandidateId: 'candidate_someone_elses',
      ownerId: 'user-b',
      imageUri: '/doc/kscan_closet_candidates/images/evil.jpg',
    },
    { actorRequest: req, ownerId: 'user-a' },
  );
  assert.equal(updated.ok, true);
  assert.equal(updated.item.title, 'Renamed');
  assert.equal(updated.item.sourceCandidateId, candidate.candidateId);
  assert.equal(updated.item.ownerId, 'user-a');
  assert.equal(updated.item.imageUri, committed.item.imageUri);

  // And the same after a re-read from disk.
  const reread = await env.closetLibrary.findClosetItemBySourceCandidate(
    candidate.candidateId,
    'user-a',
  );
  assert.ok(reread);
  assert.equal(reread.id, committed.item.id);
});

test('two actors never share provenance identity', async () => {
  const env = load();
  const reqA = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');
  const candidateA = await stageReady(env, reqA, '/picker/a.jpg');
  const committedA = await commitFromCandidate(env, reqA, candidateA);

  const reqB = asActor(env.actorContext, 'user-b');
  seedSource(env.m, '/picker/b.jpg');
  const candidateB = await stageReady(env, reqB, '/picker/b.jpg');
  // Deliberately claim A's candidate id under B's actor.
  const committedB = await env.closetLibrary.createClosetItem({
    sourceUri: candidateB.candidateImageUri,
    draft: {
      title: 'Jacket',
      category: 'Outerwear',
      origin: 'direct_intake',
      sourceCandidateId: candidateA.candidateId,
    },
    actorRequest: reqB,
    ownerId: 'user-b',
  });
  assert.equal(committedB.ok, true);
  assert.equal(committedB.deduped, false, 'B was deduped onto A’s item across actors');
  assert.notEqual(committedB.item.id, committedA.item.id);

  // Each actor sees only their own.
  assert.equal(
    (await env.closetLibrary.findClosetItemBySourceCandidate(candidateA.candidateId, 'user-a')).id,
    committedA.item.id,
  );
  assert.equal(
    (await env.closetLibrary.findClosetItemBySourceCandidate(candidateA.candidateId, 'user-b')).id,
    committedB.item.id,
  );
  // ...and their media never collides.
  assert.notEqual(committedA.item.imageUri, committedB.item.imageUri);
});

test('committing the same candidate twice resolves to the one existing item', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');
  const candidate = await stageReady(env, req, '/picker/a.jpg');

  const first = await commitFromCandidate(env, req, candidate);
  const second = await commitFromCandidate(env, req, candidate);
  assert.equal(second.ok, true);
  assert.equal(second.deduped, true);
  assert.equal(second.item.id, first.item.id);

  const all = await env.closetLibrary.loadCloset('user-a');
  assert.equal(all.length, 1, 'a retry created a second committed item');
  assert.equal(imagesIn(env.m).length, 1, 'a retry created a second committed image');
});

// ── Stable committed-media destination ───────────────────────────────────────

test('a promotion writes into the committed Closet media root, never the candidate one', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');
  const candidate = await stageReady(env, req, '/picker/a.jpg');
  const committed = await commitFromCandidate(env, req, candidate);

  assert.ok(committed.item.imageUri.startsWith('/doc/kscan_closet/images/'));
  assert.ok(!committed.item.imageUri.startsWith('/doc/kscan_closet_candidates/'));
  assert.notEqual(committed.item.imageUri, candidate.candidateImageUri);
  assert.equal(env.closetLibrary.isClosetOwnedMediaPath(committed.item.imageUri), true);
  assert.equal(env.closetLibrary.isClosetOwnedMediaPath(candidate.candidateImageUri), false);
  assert.equal(await env.closetLibrary.verifyClosetItemMedia(committed.item), true);

  // The candidate's own media is untouched by the promotion.
  assert.equal(env.m.files.has(candidate.candidateImageUri), true);
});

test('the destination is derived from identity alone, and is stable across taxonomy edits', async () => {
  const env = load();
  const assetId = env.closetLibrary.closetPromotionMediaAssetId('user-a', 'candidate_x');
  assert.ok(assetId);
  assert.equal(env.closetLibrary.closetPromotionMediaAssetId('user-a', 'candidate_x'), assetId);
  // Different actor, different candidate: different destinations.
  assert.notEqual(env.closetLibrary.closetPromotionMediaAssetId('user-b', 'candidate_x'), assetId);
  assert.notEqual(env.closetLibrary.closetPromotionMediaAssetId('user-a', 'candidate_y'), assetId);
  // The signed-out partition is a real partition, not an error.
  assert.ok(env.closetLibrary.closetPromotionMediaAssetId(null, 'candidate_x'));
  assert.notEqual(env.closetLibrary.closetPromotionMediaAssetId(null, 'candidate_x'), assetId);
  // Nothing mutable is an input.
  assert.equal(env.closetLibrary.closetPromotionMediaAssetId('user-a', '  '), null);
});

test('a retry after a lost manifest reuses the same destination instead of a new file', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');
  const candidate = await stageReady(env, req, '/picker/a.jpg');

  const first = await commitFromCandidate(env, req, candidate);
  const firstPath = first.item.imageUri;
  assert.equal(imagesIn(env.m).length, 1);

  // THE CRASH WINDOW: media landed, the manifest entry did not. Simulated by
  // removing the committed record and leaving its media behind.
  env.m.files.set('/doc/kscan_closet/kscan_closet.json', JSON.stringify([]));
  assert.equal(env.m.files.has(firstPath), true);

  const retry = await commitFromCandidate(env, req, candidate);
  assert.equal(retry.ok, true);
  assert.equal(retry.item.imageUri, firstPath, 'the retry minted a new destination');
  assert.equal(imagesIn(env.m).length, 1, 'the retry left a second image behind');
});

test('a leftover artifact with different bytes is replaced, not trusted for existing', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');
  const candidate = await stageReady(env, req, '/picker/a.jpg');

  const assetId = env.closetLibrary.closetPromotionMediaAssetId('user-a', candidate.candidateId);
  const destPath = `/doc/kscan_closet/images/${assetId}.jpg`;
  // A half-written or unrelated leftover at OUR destination, referenced by nothing.
  env.m.files.set(destPath, Buffer.from('torn').toString('base64'));

  const committed = await commitFromCandidate(env, req, candidate);
  assert.equal(committed.ok, true);
  assert.equal(committed.item.imageUri, destPath);
  assert.notEqual(env.m.files.get(destPath), Buffer.from('torn').toString('base64'));
  assert.equal(await env.closetLibrary.verifyClosetItemMedia(committed.item), true);
});

test('a destination owned by another committed item fails closed', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');
  const candidate = await stageReady(env, req, '/picker/a.jpg');

  const assetId = env.closetLibrary.closetPromotionMediaAssetId('user-a', candidate.candidateId);
  const destPath = `/doc/kscan_closet/images/${assetId}.jpg`;
  const foreignBytes = Buffer.from('someone elses garment').toString('base64');
  env.m.files.set(destPath, foreignBytes);
  env.m.files.set(
    '/doc/kscan_closet/kscan_closet.json',
    JSON.stringify([
      {
        schemaVersion: 1,
        id: 'closet_other',
        ownerId: 'user-a',
        sourceCandidateId: 'candidate_unrelated',
        imageUri: destPath,
        thumbnailUri: null,
        title: 'Another item',
        category: 'Shirt',
        notes: null,
        origin: 'direct_intake',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]),
  );

  const committed = await commitFromCandidate(env, req, candidate);
  assert.equal(committed.ok, false);
  assert.equal(committed.reason, 'media_destination_conflict');
  // The other item's bytes are exactly as they were, and no record was added.
  assert.equal(env.m.files.get(destPath), foreignBytes);
  const items = await env.closetLibrary.loadCloset('user-a');
  assert.equal(items.length, 1);
  assert.equal(items[0].id, 'closet_other');
});

test('ordinary intake keeps its fresh random destination, unchanged by this phase', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');

  const first = await env.closetLibrary.createClosetItem({
    sourceUri: '/picker/a.jpg',
    draft: { title: 'Direct', category: 'Shirt', origin: 'direct_intake' },
    actorRequest: req,
    ownerId: 'user-a',
  });
  const second = await env.closetLibrary.createClosetItem({
    sourceUri: '/picker/a.jpg',
    draft: { title: 'Direct again', category: 'Shirt', origin: 'direct_intake' },
    actorRequest: req,
    ownerId: 'user-a',
  });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.notEqual(first.item.imageUri, second.item.imageUri);
  assert.equal(first.item.sourceCandidateId, null);
  assert.ok(!first.item.imageUri.includes('cand_'));
});

// ── Candidate promotion tombstone ────────────────────────────────────────────

test('finalization moves the candidate to the promoted terminal state', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');
  const candidate = await stageReady(env, req, '/picker/a.jpg');
  const committed = await commitFromCandidate(env, req, candidate);

  const finalized = await env.store.finalizeClosetCandidatePromotion(
    req,
    candidate.candidateId,
    { closetItemId: committed.item.id },
  );
  assert.equal(finalized.ok, true);
  assert.equal(finalized.candidate.status, 'saved');
  assert.equal(finalized.candidate.promotedClosetItemId, committed.item.id);
  assert.ok(finalized.candidate.promotedAt);
  // Batch identity and position survive, which is what keeps the promoted card in
  // place instead of reflowing the group under the user.
  assert.equal(finalized.candidate.batchId, candidate.batchId);
  assert.equal(finalized.candidate.batchPosition, candidate.batchPosition);
  assert.equal(finalized.candidate.createdAt, candidate.createdAt);
  assert.equal(finalized.candidate.expiresAt, candidate.expiresAt);
  // The tombstone keeps referencing its own candidate media (Phase 4 cleanup).
  assert.equal(finalized.candidate.candidateImageUri, candidate.candidateImageUri);
  assert.equal(env.m.files.has(candidate.candidateImageUri), true);
});

test('finalization is idempotent for the same item and refuses a different one', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');
  const candidate = await stageReady(env, req, '/picker/a.jpg');
  const committed = await commitFromCandidate(env, req, candidate);

  const once = await env.store.finalizeClosetCandidatePromotion(req, candidate.candidateId, {
    closetItemId: committed.item.id,
  });
  const twice = await env.store.finalizeClosetCandidatePromotion(req, candidate.candidateId, {
    closetItemId: committed.item.id,
  });
  assert.equal(twice.ok, true);
  assert.equal(twice.candidate.promotedAt, once.candidate.promotedAt, 'promotion time moved');

  const hijack = await env.store.finalizeClosetCandidatePromotion(req, candidate.candidateId, {
    closetItemId: 'closet_someone_else',
  });
  assert.equal(hijack.ok, false);
  assert.equal(hijack.errorCode, 'candidate_invalid_transition');
});

test('a promoted candidate can never return to review or be promoted again', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');
  const candidate = await stageReady(env, req, '/picker/a.jpg');
  const committed = await commitFromCandidate(env, req, candidate);
  await env.store.finalizeClosetCandidatePromotion(req, candidate.candidateId, {
    closetItemId: committed.item.id,
  });

  for (const to of ['ready_for_review', 'queued', 'classifying', 'rejected', 'saving']) {
    const attempt = await env.store.transitionClosetCandidate(req, candidate.candidateId, { to });
    assert.equal(attempt.ok, false, `saved -> ${to} was allowed`);
    assert.equal(attempt.errorCode, 'candidate_invalid_transition');
  }

  // And a second committed write for the same candidate still resolves to the one item.
  const again = await commitFromCandidate(env, req, candidate);
  assert.equal(again.deduped, true);
  assert.equal(again.item.id, committed.item.id);
  assert.equal((await env.closetLibrary.loadCloset('user-a')).length, 1);
});

test('the promotion tombstone cannot be forged through a patch or a transition', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');
  const candidate = await stageReady(env, req, '/picker/a.jpg');

  const patched = await env.store.updateClosetCandidate(req, candidate.candidateId, {
    promotedClosetItemId: 'closet_forged',
  });
  assert.equal(patched.ok, false);
  assert.equal(patched.errorCode, 'candidate_invalid_transition');

  const patchedAt = await env.store.updateClosetCandidate(req, candidate.candidateId, {
    promotedAt: '2026-07-28T00:00:00.000Z',
  });
  assert.equal(patchedAt.ok, false);

  // A transition patch may only carry PATCHABLE fields; protected keys are ignored.
  const transitioned = await env.store.transitionClosetCandidate(req, candidate.candidateId, {
    to: 'rejected',
    patch: { promotedClosetItemId: 'closet_forged', notes: 'kept' },
  });
  assert.equal(transitioned.ok, true);
  assert.equal(transitioned.candidate.promotedClosetItemId, null);
  assert.equal(transitioned.candidate.notes, 'kept');
});

test('finalization requires a real committed item id', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');
  const candidate = await stageReady(env, req, '/picker/a.jpg');

  for (const closetItemId of [null, undefined, '', '   ', 42, {}]) {
    const result = await env.store.finalizeClosetCandidatePromotion(req, candidate.candidateId, {
      closetItemId,
    });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'candidate_invalid_transition');
  }
  const unchanged = await env.store.getClosetCandidate(req, candidate.candidateId);
  assert.equal(unchanged.candidate.status, 'ready_for_review');
});

test('a foreign actor cannot finalize somebody else’s candidate', async () => {
  const env = load();
  const reqA = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');
  const candidate = await stageReady(env, reqA, '/picker/a.jpg');
  const committed = await commitFromCandidate(env, reqA, candidate);

  const reqB = asActor(env.actorContext, 'user-b');
  const stolen = await env.store.finalizeClosetCandidatePromotion(reqB, candidate.candidateId, {
    closetItemId: committed.item.id,
  });
  assert.equal(stolen.ok, false);

  const reqA2 = asActor(env.actorContext, 'user-a');
  const still = await env.store.getClosetCandidate(reqA2, candidate.candidateId);
  assert.equal(still.candidate.status, 'ready_for_review');
  assert.equal(still.candidate.promotedClosetItemId, null);
});

test('a stale actor request cannot finalize a promotion', async () => {
  const env = load();
  const stale = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');
  const candidate = await stageReady(env, stale, '/picker/a.jpg');
  const committed = await commitFromCandidate(env, stale, candidate);

  // Same user signs out and back in: the id matches, the epoch does not.
  env.actorContext.advanceActorEpoch(null);
  env.actorContext.advanceActorEpoch('user-a');

  const result = await env.store.finalizeClosetCandidatePromotion(stale, candidate.candidateId, {
    closetItemId: committed.item.id,
  });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'candidate_actor_stale');
});

// ── Retention (Phase 4 boundary) ─────────────────────────────────────────────

test('an EXPIRED candidate is still finalizable once its item is durable', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');
  const candidate = await stageReady(env, req, '/picker/a.jpg');
  const committed = await commitFromCandidate(env, req, candidate);

  // The lifetime lapses between the committed write and the finalization.
  const laterMs = Date.parse(candidate.expiresAt) + 1000;
  const finalized = await env.store.finalizeClosetCandidatePromotion(req, candidate.candidateId, {
    closetItemId: committed.item.id,
    nowMs: laterMs,
  });
  assert.equal(finalized.ok, true, 'a durable committed item became unrecordable');
  assert.equal(finalized.candidate.status, 'saved');

  // Expiry still blocks every OTHER mutation, so this is not a general bypass.
  const patched = await env.store.updateClosetCandidate(
    req,
    candidate.candidateId,
    { notes: 'x' },
    { nowMs: laterMs },
  );
  assert.equal(patched.ok, false);
  assert.equal(patched.errorCode, 'candidate_expired');
});

test('the expiry sweep never collects a promoted tombstone, and does collect drafts', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');
  seedSource(env.m, '/picker/b.jpg');
  const promotedCandidate = await stageReady(env, req, '/picker/a.jpg');
  const draft = await stageReady(env, req, '/picker/b.jpg');
  const committed = await commitFromCandidate(env, req, promotedCandidate);
  await env.store.finalizeClosetCandidatePromotion(req, promotedCandidate.candidateId, {
    closetItemId: committed.item.id,
  });

  const laterMs = Date.parse(promotedCandidate.expiresAt) + DAY_MS;
  const swept = await env.store.cleanupExpiredClosetCandidates(req, { nowMs: laterMs });
  assert.equal(swept.ok, true);
  assert.equal(swept.removed, 1, 'exactly the unresolved draft should be collected');

  const raw = JSON.parse(
    env.m.files.get('/doc/kscan_closet_candidates/kscan_closet_candidates.json'),
  );
  const surviving = raw.map((entry) => entry.candidateId);
  assert.deepEqual(surviving, [promotedCandidate.candidateId]);
  assert.equal(raw[0].status, 'saved');
  assert.equal(raw[0].promotedClosetItemId, committed.item.id);
  // The draft's media is gone; the tombstone's media is not.
  assert.equal(env.m.files.has(draft.candidateImageUri), false);
  assert.equal(env.m.files.has(promotedCandidate.candidateImageUri), true);
});

test('the candidate orphan sweep preserves media a promoted tombstone still references', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');
  const candidate = await stageReady(env, req, '/picker/a.jpg');
  const committed = await commitFromCandidate(env, req, candidate);
  await env.store.finalizeClosetCandidatePromotion(req, candidate.candidateId, {
    closetItemId: committed.item.id,
  });

  // Age every candidate file well past the in-flight grace period.
  for (const key of env.m.files.keys()) {
    if (key.startsWith('/doc/kscan_closet_candidates/')) env.m.setModified(key, 0);
  }
  const sweep = await env.store.sweepOrphanedClosetCandidateMedia(req, { nowMs: Date.now() });
  assert.equal(sweep.ok, true);
  assert.equal(sweep.deleted, 0, 'the sweep collected media a tombstone still owns');
  assert.equal(env.m.files.has(candidate.candidateImageUri), true);
  assert.equal(env.m.files.has(candidate.candidateThumbnailUri), true);
  // The committed copy is independent and untouched either way.
  assert.equal(env.m.files.has(committed.item.imageUri), true);
});
