// Closet candidate MANUAL CLASSIFICATION suite (Build 1 addendum).
//
// `needs_manual_classification` was a dead end in the original Build 1: the
// state existed, the hook API existed, and no surface called it. These tests
// execute the REAL service sequence — validate, patch through the protected-
// field gate, transition through the authoritative state machine — against the
// real transpiled store, so the affordance's contract holds independent of any
// component.

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

// ── Manual classification (real store) ───────────────────────────────────────

/** Create a candidate and walk it to needs_manual_classification legally. */
async function stageNeedsManual(env, req, uri = '/picker/manual.jpg') {
  seedSource(env.m, uri);
  const created = await env.store.createClosetCandidate(req, {
    sourceUri: uri,
    sourceType: 'gallery',
    ownerId: req.actorId,
  });
  assert.equal(created.kind, 'created');
  const id = created.candidate.candidateId;
  await env.store.transitionClosetCandidate(req, id, { to: 'classifying', attempt: 'automatic' });
  await env.store.transitionClosetCandidate(req, id, {
    to: 'needs_manual_classification',
    errorCode: 'classification_requires_manual_category',
  });
  const loaded = await env.store.getClosetCandidate(req, id);
  assert.equal(loaded.candidate.status, 'needs_manual_classification');
  return loaded.candidate;
}

test('an empty category is rejected and the candidate is untouched', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const before = await stageNeedsManual(env, req);

  for (const bad of [undefined, null, '', '   ']) {
    const result = await env.store.manuallyClassifyClosetCandidate(req, before.candidateId, {
      category: bad,
      subtype: 'Trench coat',
    });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'classification_requires_manual_category');
  }

  const after = (await env.store.getClosetCandidate(req, before.candidateId)).candidate;
  assert.equal(after.status, 'needs_manual_classification');
  assert.equal(after.subtype, null, 'a rejected submission persists nothing');
  assert.equal(after.updatedAt, before.updatedAt);
});

test('a valid category advances to ready_for_review with optional fields persisted', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const before = await stageNeedsManual(env, req);

  const result = await env.store.manuallyClassifyClosetCandidate(req, before.candidateId, {
    category: '  Outerwear  ',
    subtype: 'Trench coat',
    primaryColor: 'Navy',
    secondaryColors: ['Cream'],
  });
  assert.equal(result.ok, true, JSON.stringify(result));

  const after = (await env.store.getClosetCandidate(req, before.candidateId)).candidate;
  assert.equal(after.status, 'ready_for_review');
  assert.equal(after.category, 'Outerwear', 'category is trimmed');
  assert.equal(after.subtype, 'Trench coat');
  assert.equal(after.primaryColor, 'Navy');
  assert.deepEqual(after.secondaryColors, ['Cream']);
  assert.equal(after.errorCode, null, 'the resolved candidate no longer reports an error');

  // Lifetime and ledgers are exactly what they were.
  assert.equal(after.createdAt, before.createdAt);
  assert.equal(after.expiresAt, before.expiresAt);
  assert.equal(after.interruptionCount, before.interruptionCount);
  assert.equal(after.attemptCount, before.attemptCount);
  assert.equal(after.automaticRetryCount, before.automaticRetryCount);

  // Still a candidate. Nothing reached the committed Closet.
  assert.equal(env.m.files.has(COMMITTED_MANIFEST), false);
  assert.equal((await env.closetLibrary.loadCloset('user-a')).length, 0);
});

test('protected fields cannot ride in on a manual submission', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const before = await stageNeedsManual(env, req);

  const result = await env.store.manuallyClassifyClosetCandidate(req, before.candidateId, {
    category: 'Outerwear',
    ownerId: 'attacker',
    expiresAt: '2999-01-01T00:00:00.000Z',
    interruptionCount: 0,
    status: 'saved',
  });
  assert.equal(result.ok, true, 'unknown keys are simply never forwarded');

  const after = (await env.store.getClosetCandidate(req, before.candidateId)).candidate;
  assert.equal(after.ownerId, 'user-a');
  assert.equal(after.expiresAt, before.expiresAt);
  assert.equal(after.status, 'ready_for_review', 'status came from the transition, not the input');
});

test('another actor cannot manually classify the candidate', async () => {
  const env = load();
  const reqA = asActor(env.actorContext, 'user-a');
  const target = await stageNeedsManual(env, reqA);

  const reqB = asActor(env.actorContext, 'user-b');
  const result = await env.store.manuallyClassifyClosetCandidate(reqB, target.candidateId, {
    category: 'Outerwear',
  });
  assert.equal(result.ok, false);

  const reqA2 = asActor(env.actorContext, 'user-a');
  const after = (await env.store.getClosetCandidate(reqA2, target.candidateId)).candidate;
  assert.equal(after.status, 'needs_manual_classification');
  assert.equal(after.category, null);
});

test('an expired candidate cannot be manually advanced', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const target = await stageNeedsManual(env, req);

  const afterExpiry = Date.now() + 8 * DAY_MS;
  const result = await env.store.manuallyClassifyClosetCandidate(
    req,
    target.candidateId,
    { category: 'Outerwear' },
    { nowMs: afterExpiry },
  );
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'candidate_expired');
});

test('manual classification refuses candidates that are not waiting for it', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/queued.jpg');
  const created = await env.store.createClosetCandidate(req, {
    sourceUri: '/picker/queued.jpg',
    sourceType: 'gallery',
    ownerId: req.actorId,
  });

  const result = await env.store.manuallyClassifyClosetCandidate(
    req,
    created.candidate.candidateId,
    { category: 'Outerwear' },
  );
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'candidate_invalid_transition');

  // The pre-check ran before the patch: no user-authored taxonomy leaked onto a
  // queued record whose classification has not even run yet.
  const after = (await env.store.getClosetCandidate(req, created.candidate.candidateId)).candidate;
  assert.equal(after.status, 'queued');
  assert.equal(after.category, null);
});

test('the manual transition is the authoritative state machine, not a status write', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const target = await stageNeedsManual(env, req);

  // Directly patching status is rejected by the protected-field gate...
  const direct = await env.store.updateClosetCandidate(req, target.candidateId, {
    status: 'ready_for_review',
  });
  assert.equal(direct.ok, false);
  assert.equal(direct.errorCode, 'candidate_invalid_transition');

  // ...while the service's transition path succeeds, because it goes through
  // evaluateTransition on the needs_manual_classification → ready_for_review edge.
  const viaService = await env.store.manuallyClassifyClosetCandidate(req, target.candidateId, {
    category: 'Outerwear',
  });
  assert.equal(viaService.ok, true);
});
