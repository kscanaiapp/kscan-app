// Closet intake ROUTING suite (Build 1 addendum).
//
// The audit that preceded this suite found the entire candidate pipeline dark:
// every unit passed while the one production intake path was wired straight to
// the committed Closet. These tests exist so that wiring is a BEHAVIOURAL fact.
// The router is executed with both destinations injected as spies, and then
// against the REAL transpiled candidate store on an in-memory filesystem, so
// "flag on stages a candidate and does not write the committed Closet" is
// proven end to end rather than read off the screen's source.

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

function memfs() {
  const files = new Map();
  const api = {
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
  return { files, api };
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

/** The real candidate store + committed closet, as in closetCandidateStore.test.js. */
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
      return {
        saveScanToCloud: async () => ({ ok: true }),
        softDeleteCloudSavedScan: async () => ({ ok: true }),
      };
    }
    if (spec === './identificationSnapshot') {
      return { hydrateScanHistory: () => ({ records: [], corruptedCount: 0 }) };
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

  const routing = runModule('services/closetIntakeRouting.js', () => ({}));

  return { m, actorContext, closetLibrary, store, schema, routing };
}

function asActor(actorContext, actorId) {
  actorContext.advanceActorEpoch(actorId);
  return actorContext.createActorRequest();
}

function seedSource(m, uri) {
  m.files.set(uri, Buffer.from(`original:${uri}`).toString('base64'));
  return uri;
}

const CANDIDATE_MANIFEST = '/doc/kscan_closet_candidates/kscan_closet_candidates.json';
const COMMITTED_MANIFEST = '/doc/kscan_closet/kscan_closet.json';

/** Wire the router's candidate destination the way the hook does. */
function candidateIntakeFor(env, req) {
  return (uri, intake) =>
    env.store.createClosetCandidate(req, {
      sourceUri: uri,
      sourceType: intake.sourceType,
      batchId: intake.batchId,
      draft: intake.draft,
      ownerId: req.actorId,
    });
}

// ── Pure routing: the fork itself ────────────────────────────────────────────

test('staging off routes to the committed intake and never touches candidates', async () => {
  const { routing } = load();
  const committedCalls = [];
  const candidateCalls = [];
  const result = await routing.routeClosetIntake({
    stagingActive: false,
    sourceUri: '/picker/a.jpg',
    sourceType: 'camera',
    draft: { title: 'Coat', category: null },
    committedIntake: async (uri, draft) => {
      committedCalls.push({ uri, draft });
      return { ok: true };
    },
    candidateIntake: async (...args) => {
      candidateCalls.push(args);
      return { kind: 'created' };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(committedCalls.length, 1);
  assert.equal(committedCalls[0].uri, '/picker/a.jpg');
  assert.equal(committedCalls[0].draft.title, 'Coat');
  assert.equal(candidateCalls.length, 0, 'flag off must never reach the candidate store');
});

test('an undefined capability fails toward the committed path', async () => {
  const { routing } = load();
  let committed = 0;
  let candidate = 0;
  await routing.routeClosetIntake({
    stagingActive: undefined,
    sourceUri: '/picker/a.jpg',
    sourceType: 'gallery',
    committedIntake: async () => {
      committed += 1;
      return { ok: true };
    },
    candidateIntake: async () => {
      candidate += 1;
      return { kind: 'created' };
    },
  });
  assert.equal(committed, 1);
  assert.equal(candidate, 0);
});

test('staging on routes to the candidate intake and never the committed one', async () => {
  const { routing } = load();
  const candidateCalls = [];
  let committed = 0;
  const result = await routing.routeClosetIntake({
    stagingActive: true,
    sourceUri: '/picker/a.jpg',
    sourceType: 'camera',
    draft: { title: null, category: null },
    committedIntake: async () => {
      committed += 1;
      return { ok: true };
    },
    candidateIntake: async (uri, intake) => {
      candidateCalls.push({ uri, intake });
      return { kind: 'created', candidate: { candidateId: 'candidate_1' } };
    },
    createBatchId: () => 'batch_fixed',
  });

  assert.equal(result.ok, true);
  assert.equal(result.candidateId, 'candidate_1');
  assert.equal(committed, 0, 'flag on must never write the committed Closet');
  assert.equal(candidateCalls.length, 1);
  assert.equal(candidateCalls[0].intake.sourceType, 'camera');
  assert.equal(candidateCalls[0].intake.batchId, 'batch_fixed', 'a single intake still gets a batch id');
});

test('source mapping: camera stays camera, everything else is gallery', async () => {
  const { routing } = load();
  assert.equal(routing.normalizeClosetIntakeSource('camera'), 'camera');
  assert.equal(routing.normalizeClosetIntakeSource('gallery'), 'gallery');
  // The weaker claim wins: nothing is ever labelled a camera capture — or a
  // Recent Scan — by accident.
  assert.equal(routing.normalizeClosetIntakeSource('recent_scan'), 'gallery');
  assert.equal(routing.normalizeClosetIntakeSource(undefined), 'gallery');
});

test('non-created candidate outcomes surface reasons instead of vanishing', async () => {
  const { routing } = load();
  const route = (result) =>
    routing.routeClosetIntake({
      stagingActive: true,
      sourceUri: '/picker/a.jpg',
      sourceType: 'gallery',
      candidateIntake: async () => result,
      createBatchId: () => 'batch_x',
    });

  const deduped = await route({
    kind: 'deduped_candidate',
    candidate: { candidateId: 'candidate_1' },
    code: 'duplicate_active_candidate',
  });
  assert.equal(deduped.ok, true);
  assert.equal(deduped.reason, 'duplicate_active_candidate');

  const limit = await route({ kind: 'rejected', code: 'candidate_limit_reached' });
  assert.equal(limit.ok, false);
  assert.equal(limit.reason, 'candidate_limit_reached');
});

test('a blank source uri is rejected before either destination is called', async () => {
  const { routing } = load();
  let calls = 0;
  const result = await routing.routeClosetIntake({
    stagingActive: true,
    sourceUri: '   ',
    sourceType: 'camera',
    committedIntake: async () => {
      calls += 1;
      return { ok: true };
    },
    candidateIntake: async () => {
      calls += 1;
      return { kind: 'created' };
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'candidate_media_unreadable');
  assert.equal(calls, 0);
});

// ── Routing against the REAL stores ──────────────────────────────────────────

test('flag-on intake creates a durable candidate and the committed Closet is untouched', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/coat.jpg');

  const result = await env.routing.routeClosetIntake({
    stagingActive: true,
    sourceUri: '/picker/coat.jpg',
    sourceType: 'camera',
    draft: { title: 'Coat', category: null },
    committedIntake: async () => {
      throw new Error('committed intake must not run');
    },
    candidateIntake: candidateIntakeFor(env, req),
    createBatchId: env.schema.createClosetBatchId,
  });

  assert.equal(result.ok, true);
  assert.ok(result.candidateId);

  // Durable: on disk, actor-scoped, camera-sourced, batch-stamped, media owned.
  const listed = await env.store.listClosetCandidates(req);
  assert.equal(listed.candidates.length, 1);
  const record = listed.candidates[0];
  assert.equal(record.candidateId, result.candidateId);
  assert.equal(record.sourceType, 'camera');
  assert.ok(record.batchId);
  assert.ok(record.candidateImageUri.startsWith('/doc/kscan_closet_candidates/images/'));
  assert.ok(env.m.files.has(CANDIDATE_MANIFEST));

  // The committed Closet was never written.
  assert.equal(env.m.files.has(COMMITTED_MANIFEST), false);
  assert.equal((await env.closetLibrary.loadCloset('user-a')).length, 0);
});

test('flag-off intake reaches the committed destination and no candidate exists', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/coat.jpg');

  let committedRuns = 0;
  const result = await env.routing.routeClosetIntake({
    stagingActive: false,
    sourceUri: '/picker/coat.jpg',
    sourceType: 'gallery',
    draft: { title: 'Coat', category: null },
    committedIntake: async (uri, draft) => {
      committedRuns += 1;
      const created = await env.closetLibrary.createClosetItem({
        sourceUri: uri,
        draft,
        actorRequest: req,
        ownerId: 'user-a',
      });
      return { ok: created.ok !== false };
    },
    candidateIntake: candidateIntakeFor(env, req),
    createBatchId: env.schema.createClosetBatchId,
  });

  assert.equal(result.ok, true);
  assert.equal(committedRuns, 1);
  assert.equal((await env.closetLibrary.loadCloset('user-a')).length, 1);
  assert.equal(env.m.files.has(CANDIDATE_MANIFEST), false, 'no candidate manifest is created');
  assert.equal((await env.store.listClosetCandidates(req)).candidates.length, 0);
});

test('the same photo routed twice yields one candidate, not two', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/coat.jpg');
  const intake = candidateIntakeFor(env, req);

  const first = await env.routing.routeClosetIntake({
    stagingActive: true,
    sourceUri: '/picker/coat.jpg',
    sourceType: 'gallery',
    candidateIntake: intake,
    createBatchId: env.schema.createClosetBatchId,
  });
  const second = await env.routing.routeClosetIntake({
    stagingActive: true,
    sourceUri: '/picker/coat.jpg',
    sourceType: 'gallery',
    candidateIntake: intake,
    createBatchId: env.schema.createClosetBatchId,
  });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.kind, 'deduped_candidate');
  assert.equal(second.candidateId, first.candidateId, 'the existing candidate is returned');
  assert.equal((await env.store.listClosetCandidates(req)).candidates.length, 1);
});
