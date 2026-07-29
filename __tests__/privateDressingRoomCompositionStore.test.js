// Private Dressing Room composition persistence (Phase 2, Stage 5).
//
// Runs the REAL store against an in-memory filesystem with the REAL actor
// context, mirroring __tests__/privateDressingRoomSessionStore.test.js.
//
// `.test.js` so scripts/run-all-tests.js discovers it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

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
  'expo-crypto': { getRandomBytes: (n) => Uint8Array.from({ length: n }, (_, i) => (i * 13) % 256) },
};

const moduleCache = new Map();

function loadModule(relPath) {
  if (moduleCache.has(relPath)) return moduleCache.get(relPath);
  const filename = path.join(ROOT, relPath);
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
      allowJs: true,
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
  vm.runInThisContext(`(function (exports, module, require) {\n${output}\n})`, { filename })(
    mod.exports,
    mod,
    localRequire,
  );
  moduleCache.set(relPath, mod.exports);
  return mod.exports;
}

const actorContext = loadModule('services/actorContext.js');
const store = loadModule('services/privateDressingRoomCompositionStore.ts');
const schema = loadModule('services/privateDressingRoomCompositionSchema.ts');

const MANIFEST = store.COMPOSITION_MANIFEST_PATH;
const BACKUP = store.COMPOSITION_MANIFEST_BACKUP_PATH;
const TEMP = store.COMPOSITION_MANIFEST_TEMP_PATH;

const SESSION_ID = 'drsession_1';

function fingerprint(overrides = {}) {
  return schema.buildCompositionFingerprint({
    actorId: 'user-a',
    sessionId: SESSION_ID,
    status: 'active',
    anchorClosetItemId: 'c-top',
    occasion: 'Work',
    ...overrides,
  });
}

function looks(count = 1) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    out.push({
      lookId: `drlook_${i}`,
      sessionId: SESSION_ID,
      items: [
        { slot: 'top', closetItemId: 'c-top' },
        { slot: 'bottom', closetItemId: `c-bottom-${i}` },
        { slot: 'footwear', closetItemId: 'c-shoes' },
      ],
      completeness: 'complete',
      missingSlots: [],
      labelCodes: ['NO_PURCHASE_NEEDED'],
      rank: i,
    });
  }
  return out;
}

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

function stored() {
  return JSON.parse(files.get(MANIFEST));
}

// ── Save and load ────────────────────────────────────────────────────────────

test('a composition saves and loads under the same fingerprint', async () => {
  const request = reset();
  const fp = fingerprint();
  const saved = await store.replaceCompositionSet(request, {
    sessionId: SESSION_ID,
    inputFingerprint: fp,
    looks: looks(2),
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.composition.looks.length, 2);

  const loaded = await store.loadCompositionSet(request, fp);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.composition.compositionId, saved.composition.compositionId);
});

test('no composition for this actor is success with null, not an error', async () => {
  const request = reset();
  const loaded = await store.loadCompositionSet(request, fingerprint());
  assert.equal(loaded.ok, true);
  assert.equal(loaded.composition, null);
  assert.equal(loaded.errorCode, null);
});

test('replacing keeps exactly one composition per actor', async () => {
  const request = reset();
  const fp = fingerprint();
  await store.replaceCompositionSet(request, { sessionId: SESSION_ID, inputFingerprint: fp, looks: looks(1) });
  await store.replaceCompositionSet(request, { sessionId: SESSION_ID, inputFingerprint: fp, looks: looks(3) });
  assert.equal(stored().length, 1);
  const loaded = await store.loadCompositionSet(request, fp);
  assert.equal(loaded.composition.looks.length, 3);
});

// ── Fingerprint invalidation ─────────────────────────────────────────────────

test('a composition whose fingerprint moved on is reported stale, not returned', async () => {
  const request = reset();
  await store.replaceCompositionSet(request, {
    sessionId: SESSION_ID,
    inputFingerprint: fingerprint(),
    looks: looks(1),
  });
  const loaded = await store.loadCompositionSet(request, fingerprint({ anchorClosetItemId: 'c-other' }));
  assert.equal(loaded.stale, true);
  assert.equal(loaded.composition, null, 'stale outfits must never be shown');
  assert.equal(loaded.errorCode, 'composition_stale');
});

test('an anchor change invalidates the old composition', async () => {
  const request = reset();
  await store.replaceCompositionSet(request, {
    sessionId: SESSION_ID,
    inputFingerprint: fingerprint({ anchorClosetItemId: 'c-a' }),
    looks: looks(1),
  });
  const after = await store.loadCompositionSet(request, fingerprint({ anchorClosetItemId: 'c-b' }));
  assert.equal(after.composition, null);
  assert.equal(after.stale, true);
});

test('an occasion change invalidates the old composition', async () => {
  const request = reset();
  await store.replaceCompositionSet(request, {
    sessionId: SESSION_ID,
    inputFingerprint: fingerprint({ occasion: 'Work' }),
    looks: looks(1),
  });
  const after = await store.loadCompositionSet(request, fingerprint({ occasion: 'Dinner' }));
  assert.equal(after.composition, null);
  assert.equal(after.stale, true);
});

test('a discarded session invalidates its composition with no cleanup at all', async () => {
  const request = reset();
  await store.replaceCompositionSet(request, {
    sessionId: SESSION_ID,
    inputFingerprint: fingerprint({ status: 'active' }),
    looks: looks(1),
  });
  // The file is still on disk; the context it names no longer exists.
  const after = await store.loadCompositionSet(request, fingerprint({ status: 'discarded' }));
  assert.equal(after.composition, null);
  assert.equal(after.stale, true);
  assert.equal(stored().length, 1, 'cleanup did not have to run for safety to hold');
});

test('a surviving stale file can never be shown under the new context', async () => {
  const request = reset();
  await store.replaceCompositionSet(request, {
    sessionId: SESSION_ID,
    inputFingerprint: fingerprint(),
    looks: looks(1),
  });
  // Simulate cleanup failing entirely: the file stays exactly as written.
  const before = files.get(MANIFEST);
  const newContext = fingerprint({ occasion: 'Dinner' });
  const loaded = await store.loadCompositionSet(request, newContext);
  assert.equal(loaded.composition, null);
  assert.equal(files.get(MANIFEST), before, 'no write was needed to make it unusable');
});

// ── Replacement failure ──────────────────────────────────────────────────────

test('a failed replacement reports persistence failure and publishes nothing', async () => {
  const request = reset();
  const fp = fingerprint();
  faults.truncateTempOnWrite = true;
  const result = await store.replaceCompositionSet(request, {
    sessionId: SESSION_ID,
    inputFingerprint: fp,
    looks: looks(1),
  });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'composition_persist_failed');
  assert.equal(result.composition, null);
});

test('a failed replacement does not restore the previous composition', async () => {
  const request = reset();
  const oldFp = fingerprint({ occasion: 'Work' });
  await store.replaceCompositionSet(request, { sessionId: SESSION_ID, inputFingerprint: oldFp, looks: looks(1) });

  const newFp = fingerprint({ occasion: 'Dinner' });
  faults.truncateTempOnWrite = true;
  const failed = await store.replaceCompositionSet(request, {
    sessionId: SESSION_ID,
    inputFingerprint: newFp,
    looks: looks(2),
  });
  assert.equal(failed.ok, false);

  faults.truncateTempOnWrite = false;
  // The session already moved to the new context, so the surviving old
  // composition is stale and stays hidden.
  const loaded = await store.loadCompositionSet(request, newFp);
  assert.equal(loaded.composition, null);
});

// ── Active look ──────────────────────────────────────────────────────────────

test('selecting a look persists and survives a reload', async () => {
  const request = reset();
  const fp = fingerprint();
  const saved = await store.replaceCompositionSet(request, {
    sessionId: SESSION_ID,
    inputFingerprint: fp,
    looks: looks(3),
  });
  assert.equal(saved.composition.activeLookId, null);

  const selected = await store.setActiveLook(request, { lookId: 'drlook_1', expectedFingerprint: fp });
  assert.equal(selected.ok, true);
  assert.equal(selected.composition.activeLookId, 'drlook_1');

  const reloaded = await store.loadCompositionSet(request, fp);
  assert.equal(reloaded.composition.activeLookId, 'drlook_1');
});

test('selection leaves look contents untouched and bumps updatedAt', async () => {
  const request = reset();
  const fp = fingerprint();
  const saved = await store.replaceCompositionSet(request, {
    sessionId: SESSION_ID,
    inputFingerprint: fp,
    looks: looks(2),
  });
  const selected = await store.setActiveLook(request, { lookId: 'drlook_0', expectedFingerprint: fp });
  assert.deepEqual(selected.composition.looks, saved.composition.looks);
  assert.equal(selected.composition.createdAt, saved.composition.createdAt);
  assert.ok(Date.parse(selected.composition.updatedAt) >= Date.parse(saved.composition.createdAt));
});

test('selecting an unknown look is refused', async () => {
  const request = reset();
  const fp = fingerprint();
  await store.replaceCompositionSet(request, { sessionId: SESSION_ID, inputFingerprint: fp, looks: looks(2) });
  const result = await store.setActiveLook(request, { lookId: 'drlook_nope', expectedFingerprint: fp });
  assert.equal(result.ok, false);
});

test('selecting inside a stale composition is refused', async () => {
  const request = reset();
  await store.replaceCompositionSet(request, {
    sessionId: SESSION_ID,
    inputFingerprint: fingerprint(),
    looks: looks(2),
  });
  const result = await store.setActiveLook(request, {
    lookId: 'drlook_0',
    expectedFingerprint: fingerprint({ occasion: 'Dinner' }),
  });
  assert.equal(result.stale, true);
  assert.equal(result.composition, null);
});

test('concurrent selections serialize without forking the record', async () => {
  const request = reset();
  const fp = fingerprint();
  await store.replaceCompositionSet(request, { sessionId: SESSION_ID, inputFingerprint: fp, looks: looks(3) });
  const results = await Promise.all([
    store.setActiveLook(request, { lookId: 'drlook_0', expectedFingerprint: fp }),
    store.setActiveLook(request, { lookId: 'drlook_1', expectedFingerprint: fp }),
    store.setActiveLook(request, { lookId: 'drlook_2', expectedFingerprint: fp }),
  ]);
  for (const result of results) assert.equal(result.ok, true);
  assert.equal(stored().length, 1);
  assert.ok(['drlook_0', 'drlook_1', 'drlook_2'].includes(stored()[0].activeLookId));
});

// ── Actor isolation ──────────────────────────────────────────────────────────

test('compositions are partitioned per actor', async () => {
  const requestA = reset('user-a');
  const fpA = fingerprint({ actorId: 'user-a' });
  await store.replaceCompositionSet(requestA, { sessionId: SESSION_ID, inputFingerprint: fpA, looks: looks(1) });

  actorContext.advanceActorEpoch('user-b');
  const requestB = actorContext.createActorRequest();
  const fpB = fingerprint({ actorId: 'user-b' });
  await store.replaceCompositionSet(requestB, { sessionId: SESSION_ID, inputFingerprint: fpB, looks: looks(2) });

  assert.equal(stored().length, 2);
  const loadedB = await store.loadCompositionSet(requestB, fpB);
  assert.equal(loadedB.composition.looks.length, 2);
});

test('actor A cannot read actor B', async () => {
  const requestA = reset('user-a');
  await store.replaceCompositionSet(requestA, {
    sessionId: SESSION_ID,
    inputFingerprint: fingerprint({ actorId: 'user-a' }),
    looks: looks(1),
  });
  actorContext.advanceActorEpoch('user-b');
  const requestB = actorContext.createActorRequest();
  const loaded = await store.loadCompositionSet(requestB, fingerprint({ actorId: 'user-b' }));
  assert.equal(loaded.ok, true);
  assert.equal(loaded.composition, null);
});

test('a stale actor request cannot read or write', async () => {
  const stale = reset('user-a');
  const fp = fingerprint();
  await store.replaceCompositionSet(stale, { sessionId: SESSION_ID, inputFingerprint: fp, looks: looks(1) });
  actorContext.advanceActorEpoch('user-b');

  const loaded = await store.loadCompositionSet(stale, fp);
  assert.equal(loaded.ok, false);
  assert.equal(loaded.errorCode, 'stale_actor_context');

  const written = await store.replaceCompositionSet(stale, {
    sessionId: SESSION_ID,
    inputFingerprint: fp,
    looks: looks(2),
  });
  assert.equal(written.ok, false);
});

test('an actor switch DURING a write rejects the completion', async () => {
  const request = reset('user-a');
  const fp = fingerprint();
  await store.replaceCompositionSet(request, { sessionId: SESSION_ID, inputFingerprint: fp, looks: looks(1) });
  const before = files.get(MANIFEST);

  faults.onRead = (uri) => {
    if (uri === MANIFEST) {
      faults.onRead = null;
      actorContext.advanceActorEpoch('user-b');
    }
  };
  const result = await store.setActiveLook(request, { lookId: 'drlook_0', expectedFingerprint: fp });
  assert.equal(result.ok, false);
  assert.equal(files.get(MANIFEST), before, 'disk is unchanged');
});

test('Android refuses the signed-out partition; iOS keeps it', async () => {
  reset(null);
  PlatformMock.OS = 'android';
  const signedOut = actorContext.createActorRequest();
  const android = await store.loadCompositionSet(signedOut, fingerprint({ actorId: null }));
  assert.equal(android.ok, false);
  assert.equal(android.errorCode, 'missing_actor_context');

  PlatformMock.OS = 'ios';
  const ios = await store.loadCompositionSet(signedOut, fingerprint({ actorId: null }));
  assert.equal(ios.ok, true);
});

test('no store function accepts an actor id', () => {
  const source = fs.readFileSync(
    path.join(ROOT, 'services/privateDressingRoomCompositionStore.ts'),
    'utf8',
  );
  assert.equal(/export async function \w+\([^)]*actorId\s*:/.test(source), false);
});

// ── Atomic write and recovery ────────────────────────────────────────────────

test('a clean write leaves no temp and drops the backup', async () => {
  const request = reset();
  await store.replaceCompositionSet(request, {
    sessionId: SESSION_ID,
    inputFingerprint: fingerprint(),
    looks: looks(1),
  });
  assert.equal(files.has(TEMP), false);
  assert.equal(files.has(BACKUP), false);
  assert.equal(files.has(MANIFEST), true);
});

test('an unverified temp write never replaces a good manifest', async () => {
  const request = reset();
  const fp = fingerprint();
  await store.replaceCompositionSet(request, { sessionId: SESSION_ID, inputFingerprint: fp, looks: looks(1) });
  const before = files.get(MANIFEST);

  faults.truncateTempOnWrite = true;
  const failed = await store.setActiveLook(request, { lookId: 'drlook_0', expectedFingerprint: fp });
  assert.equal(failed.ok, false);
  assert.equal(files.get(MANIFEST), before);
});

test('an interrupted swap recovers from the backup on the next read', async () => {
  const request = reset();
  const fp = fingerprint();
  await store.replaceCompositionSet(request, { sessionId: SESSION_ID, inputFingerprint: fp, looks: looks(1) });

  files.set(BACKUP, files.get(MANIFEST));
  files.delete(MANIFEST);

  const loaded = await store.loadCompositionSet(request, fp);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.recovered, 'backup');
  assert.equal(files.has(MANIFEST), true);
});

test('a corrupt primary with a valid backup recovers and leaves the damage on disk', async () => {
  const request = reset();
  const fp = fingerprint();
  await store.replaceCompositionSet(request, { sessionId: SESSION_ID, inputFingerprint: fp, looks: looks(1) });
  files.set(BACKUP, files.get(MANIFEST));
  files.set(MANIFEST, '{ not json');

  const loaded = await store.loadCompositionSet(request, fp);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.recovered, 'backup');
  assert.equal(files.get(MANIFEST), '{ not json', 'a read never erases');
});

test('both copies unusable is a typed recoverable failure', async () => {
  const request = reset();
  const fp = fingerprint();
  await store.replaceCompositionSet(request, { sessionId: SESSION_ID, inputFingerprint: fp, looks: looks(1) });
  files.set(MANIFEST, 'broken');
  files.set(BACKUP, 'also broken');

  const loaded = await store.loadCompositionSet(request, fp);
  assert.equal(loaded.ok, false);
  assert.equal(loaded.errorCode, 'composition_store_corrupt');
  assert.equal(loaded.recoverable, true);
});

test('a future schema is refused and not replaced by an older backup', async () => {
  const request = reset();
  const fp = fingerprint();
  await store.replaceCompositionSet(request, { sessionId: SESSION_ID, inputFingerprint: fp, looks: looks(1) });
  const good = files.get(MANIFEST);
  files.set(BACKUP, good);
  files.set(MANIFEST, JSON.stringify(JSON.parse(good).map((r) => ({ ...r, schemaVersion: 99 }))));

  const loaded = await store.loadCompositionSet(request, fp);
  assert.equal(loaded.ok, false);
  assert.equal(loaded.errorCode, 'composition_store_future_schema');
});

test('unknown fields on disk are stripped on load', async () => {
  const request = reset();
  const fp = fingerprint();
  await store.replaceCompositionSet(request, { sessionId: SESSION_ID, inputFingerprint: fp, looks: looks(1) });
  const raw = JSON.parse(files.get(MANIFEST));
  raw[0].savedLookId = 'look-1';
  raw[0].retailer = 'Example';
  files.set(MANIFEST, JSON.stringify(raw));

  const loaded = await store.loadCompositionSet(request, fp);
  assert.equal(loaded.ok, true);
  assert.equal('savedLookId' in loaded.composition, false);
  assert.equal('retailer' in loaded.composition, false);
});

test('an explicit reset clears the damage and keeps the store usable', async () => {
  const request = reset();
  const fp = fingerprint();
  await store.replaceCompositionSet(request, { sessionId: SESSION_ID, inputFingerprint: fp, looks: looks(1) });
  files.set(MANIFEST, 'broken');
  files.set(BACKUP, 'also broken');

  const wiped = await store.resetCorruptComposition(request);
  assert.equal(wiped.ok, true);
  assert.equal(wiped.composition, null);

  const rebuilt = await store.replaceCompositionSet(request, {
    sessionId: SESSION_ID,
    inputFingerprint: fp,
    looks: looks(2),
  });
  assert.equal(rebuilt.ok, true);
  const loaded = await store.loadCompositionSet(request, fp);
  assert.equal(loaded.composition.looks.length, 2);
});

test('discard removes only this actor partition', async () => {
  const requestA = reset('user-a');
  await store.replaceCompositionSet(requestA, {
    sessionId: SESSION_ID,
    inputFingerprint: fingerprint({ actorId: 'user-a' }),
    looks: looks(1),
  });
  actorContext.advanceActorEpoch('user-b');
  const requestB = actorContext.createActorRequest();
  await store.replaceCompositionSet(requestB, {
    sessionId: SESSION_ID,
    inputFingerprint: fingerprint({ actorId: 'user-b' }),
    looks: looks(1),
  });

  await store.discardCompositionSet(requestB);
  const remaining = stored();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].actorId, 'user-a');
});

test('the store writes only inside its own namespace', async () => {
  const request = reset();
  await store.replaceCompositionSet(request, {
    sessionId: SESSION_ID,
    inputFingerprint: fingerprint(),
    looks: looks(1),
  });
  for (const uri of files.keys()) {
    assert.ok(uri.startsWith(store.COMPOSITION_DIR), `${uri} escapes the namespace`);
    assert.equal(uri.includes('kscan_closet'), false);
    // Distinct from the Phase 1 SESSION manifest.
    assert.equal(uri.includes('kscan_private_dressing_room/'), false);
  }
});

// ── Reconciliation ───────────────────────────────────────────────────────────

test('reconciliation reports a missing anchor without repairing it', () => {
  const composition = {
    looks: looks(2),
  };
  const result = store.reconcileCompositionSet(composition, ['c-bottom-0', 'c-shoes'], 'c-top');
  assert.equal(result.anchorMissing, true);
});

test('a look whose supporting item disappeared is stale, not silently repaired', () => {
  const composition = { looks: looks(2) };
  // c-bottom-1 has been deleted from the Closet.
  const result = store.reconcileCompositionSet(
    composition,
    ['c-top', 'c-bottom-0', 'c-shoes'],
    'c-top',
  );
  assert.equal(result.anchorMissing, false);
  assert.deepEqual(result.staleLookIds, ['drlook_1']);
  assert.deepEqual(
    result.usableLooks.map((look) => look.lookId),
    ['drlook_0'],
  );
});

test('a newly added Closet item does not invalidate a valid composition', () => {
  const composition = { looks: looks(1) };
  const result = store.reconcileCompositionSet(
    composition,
    ['c-top', 'c-bottom-0', 'c-shoes', 'brand-new-item'],
    'c-top',
  );
  assert.deepEqual(result.staleLookIds, []);
  assert.equal(result.usableLooks.length, 1);
});

test('reconciliation is pure and handles a missing composition', () => {
  const composition = { looks: looks(1) };
  const before = JSON.stringify(composition);
  store.reconcileCompositionSet(composition, [], 'c-top');
  assert.equal(JSON.stringify(composition), before);
  assert.deepEqual(store.reconcileCompositionSet(null, ['x']), {
    anchorMissing: false,
    staleLookIds: [],
    usableLooks: [],
  });
});

test('no remote call or Closet mutation is reachable from the store', () => {
  const source = fs.readFileSync(
    path.join(ROOT, 'services/privateDressingRoomCompositionStore.ts'),
    'utf8',
  );
  const imports = source.match(/^import .*$/gm) ?? [];
  for (const line of imports) {
    for (const forbidden of ['supabase', 'closetLibrary', 'styleObjects', 'outfitDecisions']) {
      assert.equal(line.includes(forbidden), false, `must not import ${forbidden}`);
    }
  }
  for (const call of ['fetch(', 'invoke(']) {
    assert.equal(source.includes(call), false, `must not call ${call}`);
  }
});
