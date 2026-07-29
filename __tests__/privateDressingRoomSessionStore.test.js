// Actor-scoped persistence for the private Dressing Room session.
//
// FILE EXTENSION: `.test.js`, not `.test.ts`. scripts/run-all-tests.js discovers
// on a literal `.test.js` suffix, so a `.test.ts` file would be silently
// excluded from `npm run test:all` — coverage that looks present in the tree and
// never runs in certification.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

// ── In-memory FileSystem double ──────────────────────────────────────────────

const faults = {
  failWrite: false,
  truncateTempOnWrite: false,
  failMoveToCanonical: false,
  onRead: null,
};

const files = new Map();

const FileSystemMock = {
  documentDirectory: 'file:///doc/',
  EncodingType: { UTF8: 'utf8' },
  async makeDirectoryAsync() {
    return null;
  },
  async writeAsStringAsync(uri, contents) {
    if (faults.failWrite) throw new Error('write failed');
    files.set(uri, faults.truncateTempOnWrite ? String(contents).slice(0, 4) : contents);
  },
  async readAsStringAsync(uri) {
    if (typeof faults.onRead === 'function') faults.onRead(uri);
    if (!files.has(uri)) throw new Error(`ENOENT ${uri}`);
    return files.get(uri);
  },
  async getInfoAsync(uri) {
    return { exists: files.has(uri) };
  },
  async deleteAsync(uri) {
    files.delete(uri);
    return null;
  },
  async moveAsync({ from, to }) {
    if (faults.failMoveToCanonical && to.endsWith('.json')) throw new Error('move failed');
    if (!files.has(from)) throw new Error(`ENOENT ${from}`);
    files.set(to, files.get(from));
    files.delete(from);
  },
};

const PlatformMock = { OS: 'ios' };

const MOCKS = {
  'expo-file-system/legacy': FileSystemMock,
  'react-native': { Platform: PlatformMock },
  'expo-crypto': { getRandomBytes: (n) => Uint8Array.from({ length: n }, (_, i) => (i * 37) % 256) },
};

// ── Module harness (shared instances, so actorContext is a singleton) ─────────

const moduleCache = new Map();

function loadModule(relPath) {
  if (moduleCache.has(relPath)) return moduleCache.get(relPath);
  const filename = path.join(ROOT, relPath);
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const mod = { exports: {} };
  const dirname = path.dirname(filename);
  const localRequire = (specifier) => {
    if (specifier in MOCKS) return MOCKS[specifier];
    if (specifier.startsWith('.')) {
      let resolved = path.resolve(dirname, specifier);
      for (const ext of ['', '.ts', '.js']) {
        if (fs.existsSync(resolved + ext) && fs.statSync(resolved + ext).isFile()) {
          resolved += ext;
          break;
        }
      }
      return loadModule(path.relative(ROOT, resolved).replace(/\\/g, '/'));
    }
    throw new Error(`Unexpected import in ${relPath}: ${specifier}`);
  };
  vm.runInNewContext(
    output,
    {
      module: mod,
      exports: mod.exports,
      require: localRequire,
      console,
      Date,
      Math,
      Number,
      Array,
      Object,
      JSON,
      String,
      Boolean,
      Error,
      Promise,
      Uint8Array,
      globalThis: {},
      setTimeout,
    },
    { filename },
  );
  moduleCache.set(relPath, mod.exports);
  return mod.exports;
}

const actorContext = loadModule('services/actorContext.js');
const store = loadModule('services/privateDressingRoomSessionStore.ts');
const schema = loadModule('services/privateDressingRoomSessionSchema.ts');

const MANIFEST = store.PRIVATE_SESSION_MANIFEST_PATH;
const BACKUP = store.PRIVATE_SESSION_MANIFEST_BACKUP_PATH;
const TEMP = store.PRIVATE_SESSION_MANIFEST_TEMP_PATH;

// ── Helpers ──────────────────────────────────────────────────────────────────

function reset(actorId = 'user-a') {
  files.clear();
  faults.failWrite = false;
  faults.truncateTempOnWrite = false;
  faults.failMoveToCanonical = false;
  faults.onRead = null;
  PlatformMock.OS = 'ios';
  actorContext.__resetActorContextForTests();
  actorContext.advanceActorEpoch(actorId);
  return actorContext.createActorRequest();
}

function writeManifest(records) {
  files.set(MANIFEST, JSON.stringify(records));
}

function readManifestRecords() {
  return JSON.parse(files.get(MANIFEST));
}

// ── Create / load / update / discard ─────────────────────────────────────────

test('createActiveSession persists an active session for the actor', async () => {
  const request = reset('user-a');
  const created = await store.startActiveSession(request, { occasion: 'Dinner' });
  assert.equal(created.ok, true);
  assert.equal(created.session.status, 'active');
  assert.equal(created.session.actorId, 'user-a');
  assert.equal(created.session.occasion, 'Dinner');

  const stored = readManifestRecords();
  assert.equal(stored.length, 1);
  assert.equal(stored[0].sessionId, created.session.sessionId);
});

test('loadActiveSession returns the persisted session', async () => {
  const request = reset('user-a');
  const created = await store.startActiveSession(request, { anchorClosetItemId: 'closet-1' });
  const loaded = await store.loadActiveSession(request);
  assert.equal(loaded.ok, true);
  assert.deepEqual(loaded.session, created.session);
});

test('missing manifest means no active session, not an error', async () => {
  const request = reset('user-a');
  const loaded = await store.loadActiveSession(request);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.session, null);
  assert.equal(loaded.errorCode, null);
});

test('updateActiveSession mutates in place and keeps one record', async () => {
  const request = reset('user-a');
  const created = await store.startActiveSession(request, { occasion: 'Dinner' });
  const updated = await store.updateActiveSession(request, { occasion: 'Wedding' });
  assert.equal(updated.ok, true);
  assert.equal(updated.session.sessionId, created.session.sessionId);
  assert.equal(updated.session.occasion, 'Wedding');
  assert.equal(readManifestRecords().length, 1);
});

test('anchor can be set and cleared independently of occasion', async () => {
  const request = reset('user-a');
  await store.startActiveSession(request, { occasion: 'Dinner' });
  const withAnchor = await store.updateActiveSession(request, { anchorClosetItemId: 'closet-9' });
  assert.equal(withAnchor.session.anchorClosetItemId, 'closet-9');
  assert.equal(withAnchor.session.occasion, 'Dinner');

  const cleared = await store.updateActiveSession(request, { anchorClosetItemId: null });
  assert.equal(cleared.session.anchorClosetItemId, null);
  assert.equal(cleared.session.occasion, 'Dinner');
});

test('discardActiveSession transitions to discarded rather than deleting', async () => {
  const request = reset('user-a');
  const created = await store.startActiveSession(request);
  const discarded = await store.discardActiveSession(request);
  assert.equal(discarded.ok, true);
  assert.equal(discarded.session.status, 'discarded');
  assert.equal(discarded.session.sessionId, created.session.sessionId);

  const stored = readManifestRecords();
  assert.equal(stored.length, 1, 'the record is retained, not removed');
  assert.equal(stored[0].status, 'discarded');

  const loaded = await store.loadActiveSession(request);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.session, null, 'a discarded session is not active');
});

// ── Session lifecycle semantics ──────────────────────────────────────────────

test('starting twice returns the SAME active session, never a second one', async () => {
  const request = reset('user-a');
  const first = await store.startActiveSession(request);
  const second = await store.startActiveSession(request);
  assert.equal(second.session.sessionId, first.session.sessionId);
  assert.equal(readManifestRecords().length, 1);
});

test('starting with an anchor while active UPDATES the running session', async () => {
  const request = reset('user-a');
  const first = await store.startActiveSession(request, { occasion: 'Dinner' });
  const second = await store.startActiveSession(request, { anchorClosetItemId: 'closet-2' });
  assert.equal(second.session.sessionId, first.session.sessionId);
  assert.equal(second.session.anchorClosetItemId, 'closet-2');
  assert.equal(second.session.occasion, 'Dinner', 'an unsupplied field is preserved');
});

test('the next start after a discard mints a NEW session id', async () => {
  const request = reset('user-a');
  const first = await store.startActiveSession(request);
  await store.discardActiveSession(request);
  const second = await store.startActiveSession(request);
  assert.notEqual(second.session.sessionId, first.session.sessionId);
  assert.equal(second.session.status, 'active');
  assert.equal(readManifestRecords().length, 1, 'the discarded record is replaced, not accumulated');
});

test('createdAt is stable across every mutation; updatedAt advances', async () => {
  const request = reset('user-a');
  const created = await store.startActiveSession(request);
  await new Promise((resolve) => setTimeout(resolve, 2));
  const updated = await store.updateActiveSession(request, { occasion: 'Brunch' });
  assert.equal(updated.session.createdAt, created.session.createdAt);
  assert.ok(
    Date.parse(updated.session.updatedAt) >= Date.parse(created.session.updatedAt),
    'updatedAt must not go backwards',
  );
});

test('a read-only recovery does NOT advance updatedAt', async () => {
  const request = reset('user-a');
  const created = await store.startActiveSession(request);
  const recovered = await store.recoverActiveSession(request);
  assert.equal(recovered.ok, true);
  assert.equal(recovered.session.updatedAt, created.session.updatedAt);
  assert.equal(recovered.session.createdAt, created.session.createdAt);
});

// ── Actor isolation ──────────────────────────────────────────────────────────

test('sessions are partitioned per actor', async () => {
  const requestA = reset('user-a');
  const a = await store.startActiveSession(requestA, { occasion: 'A-occasion' });

  actorContext.advanceActorEpoch('user-b');
  const requestB = actorContext.createActorRequest();
  const b = await store.startActiveSession(requestB, { occasion: 'B-occasion' });

  assert.notEqual(a.session.sessionId, b.session.sessionId);
  assert.equal(readManifestRecords().length, 2, 'both partitions coexist');

  const loadedB = await store.loadActiveSession(requestB);
  assert.equal(loadedB.session.occasion, 'B-occasion');
});

test('actor A cannot read actor B', async () => {
  const requestA = reset('user-a');
  await store.startActiveSession(requestA, { occasion: 'A-occasion' });

  actorContext.advanceActorEpoch('user-b');
  const requestB = actorContext.createActorRequest();
  const loadedB = await store.loadActiveSession(requestB);
  assert.equal(loadedB.ok, true);
  assert.equal(loadedB.session, null, "B must not see A's session");
});

test("actor A cannot write over actor B's session", async () => {
  const requestA = reset('user-a');
  await store.startActiveSession(requestA, { occasion: 'A-occasion' });

  actorContext.advanceActorEpoch('user-b');
  const requestB = actorContext.createActorRequest();
  await store.startActiveSession(requestB, { occasion: 'B-occasion' });
  await store.updateActiveSession(requestB, { occasion: 'B-changed' });

  const stored = readManifestRecords();
  const aRecord = stored.find((r) => r.actorId === 'user-a');
  assert.equal(aRecord.occasion, 'A-occasion', "A's record is untouched");
});

test('signing out does not restore the previous actor session', async () => {
  const requestA = reset('user-a');
  await store.startActiveSession(requestA, { occasion: 'A-occasion' });

  actorContext.advanceActorEpoch(null); // signed out
  const signedOut = actorContext.createActorRequest();
  const loaded = await store.loadActiveSession(signedOut);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.session, null);
});

test('a stale actor request cannot load or write', async () => {
  const stale = reset('user-a');
  await store.startActiveSession(stale, { occasion: 'Dinner' });

  actorContext.advanceActorEpoch('user-b'); // stale now has the wrong epoch

  const loaded = await store.loadActiveSession(stale);
  assert.equal(loaded.ok, false);
  assert.equal(loaded.errorCode, 'stale_actor_context');

  const written = await store.updateActiveSession(stale, { occasion: 'hijack' });
  assert.equal(written.ok, false);
  assert.equal(written.errorCode, 'stale_actor_context');
});

test('a sign-out/sign-in cycle for the SAME actor still invalidates in-flight work', async () => {
  const request = reset('user-a');
  await store.startActiveSession(request, { occasion: 'Dinner' });

  actorContext.advanceActorEpoch(null);
  actorContext.advanceActorEpoch('user-a'); // same id, new epoch

  const result = await store.updateActiveSession(request, { occasion: 'stale write' });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'stale_actor_context');
});

test('a missing actor context is refused', async () => {
  reset('user-a');
  for (const bad of [null, undefined, {}, 'nope', 42]) {
    const result = await store.loadActiveSession(bad);
    assert.equal(result.ok, false);
    assert.ok(['missing_actor_context', 'stale_actor_context'].includes(result.errorCode));
  }
});

test('no store function accepts an actor id, so a route cannot select one', () => {
  // The actor is derived from the captured request only. Passing an extra
  // argument that looks like an actor id must not change the partition.
  const source = fs.readFileSync(
    path.join(ROOT, 'services/privateDressingRoomSessionStore.ts'),
    'utf8',
  );
  assert.equal(/export async function \w+\([^)]*actorId\s*:/.test(source), false);
});

test('Android refuses the signed-out ownerless partition', async () => {
  reset(null);
  PlatformMock.OS = 'android';
  const signedOut = actorContext.createActorRequest();
  const result = await store.startActiveSession(signedOut);
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'missing_actor_context');
});

test('iOS keeps its durable signed-out partition', async () => {
  reset(null);
  PlatformMock.OS = 'ios';
  const signedOut = actorContext.createActorRequest();
  const result = await store.startActiveSession(signedOut, { occasion: 'Local' });
  assert.equal(result.ok, true);
  assert.equal(result.session.actorId, null);
});

// ── Concurrency ──────────────────────────────────────────────────────────────

test('concurrent writes are serialized and none is lost', async () => {
  const request = reset('user-a');
  await store.startActiveSession(request);

  const results = await Promise.all([
    store.updateActiveSession(request, { occasion: 'one' }),
    store.updateActiveSession(request, { occasion: 'two' }),
    store.updateActiveSession(request, { occasion: 'three' }),
  ]);
  for (const result of results) assert.equal(result.ok, true);

  const stored = readManifestRecords();
  assert.equal(stored.length, 1, 'serialization must not fork the record');
  assert.ok(['one', 'two', 'three'].includes(stored[0].occasion));
});

test('an actor switch DURING a write rejects the completion and writes nothing', async () => {
  const request = reset('user-a');
  await store.startActiveSession(request, { occasion: 'original' });
  const before = readManifestRecords();

  // Flip the actor while the mutation's authoritative read is in flight.
  faults.onRead = (uri) => {
    if (uri === MANIFEST) {
      faults.onRead = null;
      actorContext.advanceActorEpoch('user-b');
    }
  };

  const result = await store.updateActiveSession(request, { occasion: 'must not land' });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'stale_actor_context');
  assert.deepEqual(readManifestRecords(), before, 'disk is unchanged');
});

// ── Atomic write and recovery ────────────────────────────────────────────────

test('the write sequence leaves no temp file behind and drops the backup', async () => {
  const request = reset('user-a');
  await store.startActiveSession(request);
  assert.equal(files.has(TEMP), false, 'temp is consumed by the swap');
  assert.equal(files.has(BACKUP), false, 'backup is dropped after a clean write');
  assert.equal(files.has(MANIFEST), true);
});

test('an unverified temp write never replaces a good manifest', async () => {
  const request = reset('user-a');
  const created = await store.startActiveSession(request, { occasion: 'good' });
  const before = files.get(MANIFEST);

  faults.truncateTempOnWrite = true;
  const result = await store.updateActiveSession(request, { occasion: 'truncated' });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'session_persist_failed');
  assert.equal(files.get(MANIFEST), before, 'the good manifest survives');

  faults.truncateTempOnWrite = false;
  const loaded = await store.loadActiveSession(request);
  assert.equal(loaded.session.occasion, 'good');
  assert.equal(loaded.session.sessionId, created.session.sessionId);
});

test('an interrupted swap is recovered from the backup on the next read', async () => {
  const request = reset('user-a');
  await store.startActiveSession(request, { occasion: 'committed' });

  // Simulate a crash between "move canonical aside" and "move temp into place".
  files.set(BACKUP, files.get(MANIFEST));
  files.delete(MANIFEST);

  const loaded = await store.loadActiveSession(request);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.session.occasion, 'committed');
  assert.equal(loaded.recovered, 'backup');
  assert.equal(files.has(MANIFEST), true, 'the backup is promoted back into place');
});

test('a failed swap restores the last valid manifest rather than leaving none', async () => {
  const request = reset('user-a');
  await store.startActiveSession(request, { occasion: 'committed' });

  faults.failMoveToCanonical = true;
  const result = await store.updateActiveSession(request, { occasion: 'never lands' });
  assert.equal(result.ok, false);

  faults.failMoveToCanonical = false;
  const loaded = await store.loadActiveSession(request);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.session.occasion, 'committed');
});

test('a corrupt primary with a valid backup recovers, leaving the primary on disk', async () => {
  const request = reset('user-a');
  await store.startActiveSession(request, { occasion: 'committed' });

  files.set(BACKUP, files.get(MANIFEST));
  files.set(MANIFEST, '{ this is not json');

  const loaded = await store.loadActiveSession(request);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.session.occasion, 'committed');
  assert.equal(loaded.recovered, 'backup');
  assert.equal(files.get(MANIFEST), '{ this is not json', 'damaged bytes are NOT erased by a read');
});

test('a corrupt primary with no backup is a typed, recoverable failure', async () => {
  const request = reset('user-a');
  await store.startActiveSession(request);
  files.set(MANIFEST, 'not json at all');

  const loaded = await store.loadActiveSession(request);
  assert.equal(loaded.ok, false);
  assert.equal(loaded.errorCode, 'session_store_corrupt');
  assert.equal(loaded.recoverable, true);
  assert.equal(loaded.session, null);
});

test('both copies corrupt does NOT silently mint a new session', async () => {
  const request = reset('user-a');
  await store.startActiveSession(request);
  files.set(MANIFEST, 'broken');
  files.set(BACKUP, 'also broken');

  const loaded = await store.loadActiveSession(request);
  assert.equal(loaded.ok, false);
  assert.equal(loaded.recoverable, true);

  // A mutation must also refuse rather than overwrite unreadable data.
  const written = await store.updateActiveSession(request, { occasion: 'x' });
  assert.equal(written.ok, false);
  assert.equal(files.get(MANIFEST), 'broken', 'nothing was overwritten');
});

test('an explicit reset clears the failure and only then erases', async () => {
  const request = reset('user-a');
  await store.startActiveSession(request);
  files.set(MANIFEST, 'broken');
  files.set(BACKUP, 'also broken');

  const reseted = await store.resetCorruptSession(request);
  assert.equal(reseted.ok, true);
  assert.equal(reseted.session, null);

  const loaded = await store.loadActiveSession(request);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.session, null);

  const created = await store.startActiveSession(request, { occasion: 'fresh' });
  assert.equal(created.ok, true);
  assert.equal(created.session.occasion, 'fresh');
});

test('a reset on a READABLE manifest clears only this actor partition', async () => {
  const requestA = reset('user-a');
  await store.startActiveSession(requestA, { occasion: 'A-occasion' });
  actorContext.advanceActorEpoch('user-b');
  const requestB = actorContext.createActorRequest();
  await store.startActiveSession(requestB, { occasion: 'B-occasion' });

  await store.resetCorruptSession(requestB);

  const stored = readManifestRecords();
  assert.equal(stored.length, 1);
  assert.equal(stored[0].actorId, 'user-a');
  assert.equal(stored[0].occasion, 'A-occasion');
});

// ── Schema handling on disk ──────────────────────────────────────────────────

test('a future schema version is refused and never downgraded', async () => {
  const request = reset('user-a');
  const session = schema.buildPrivateDressingRoomSession({ actorId: 'user-a' });
  writeManifest([{ ...session, schemaVersion: 99 }]);

  const loaded = await store.loadActiveSession(request);
  assert.equal(loaded.ok, false);
  assert.equal(loaded.errorCode, 'session_store_future_schema');

  const written = await store.updateActiveSession(request, { occasion: 'x' });
  assert.equal(written.ok, false);
  assert.equal(readManifestRecords()[0].schemaVersion, 99, 'the newer record is left intact');
});

test('a future-schema primary is NOT replaced by an older backup', async () => {
  const request = reset('user-a');
  const session = schema.buildPrivateDressingRoomSession({ actorId: 'user-a' });
  files.set(BACKUP, JSON.stringify([session]));
  writeManifest([{ ...session, schemaVersion: 99 }]);

  const loaded = await store.loadActiveSession(request);
  assert.equal(loaded.ok, false);
  assert.equal(loaded.errorCode, 'session_store_future_schema');
});

test('unknown fields on disk are stripped by allowlisted reconstruction', async () => {
  const request = reset('user-a');
  const session = schema.buildPrivateDressingRoomSession({ actorId: 'user-a' });
  writeManifest([{ ...session, lookId: 'look-1', savedLookId: 'x', injected: true }]);

  const loaded = await store.loadActiveSession(request);
  assert.equal(loaded.ok, true);
  assert.equal('lookId' in loaded.session, false);
  assert.equal('savedLookId' in loaded.session, false);
  assert.equal('injected' in loaded.session, false);
});

test('one unreadable record does not hide a readable one for another actor', async () => {
  const request = reset('user-a');
  const good = schema.buildPrivateDressingRoomSession({ actorId: 'user-a' });
  writeManifest([{ garbage: true }, good]);

  const loaded = await store.loadActiveSession(request);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.session.sessionId, good.sessionId);
});

test('the store writes only to its own namespace', async () => {
  const request = reset('user-a');
  await store.startActiveSession(request);
  for (const uri of files.keys()) {
    assert.ok(
      uri.startsWith(store.PRIVATE_SESSION_DIR),
      `${uri} escapes the private session namespace`,
    );
    assert.equal(uri.includes('kscan_closet'), false, 'must not touch Closet storage');
  }
});
