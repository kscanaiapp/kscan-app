/**
 * Build 34 — CROSS-PLATFORM SHARED CLIENT CONVERGENCE closure.
 *
 * WHAT THIS FILE IS FOR, AND WHY IT IS NOT A DUPLICATE. The existing suites
 * prove the repairs the Android and iOS candidates each shipped.
 * __tests__/identityLifecycleClosure.test.js in particular already wires the
 * real module graph and proves A -> B isolation, cold start, the actor race,
 * K+ and PostHog. Two of its assertions stop one step short of what the
 * convergence contract requires, and that gap is exactly where the two
 * remaining defects live:
 *
 *   - it asserts a deleted actor's free-tier namespace is UNREADABLE by the
 *     next account. Unreadable is not erased, and CPR-FT-001 is precisely the
 *     difference: `ownerTerminalPurge` skipped these stores on an assumption
 *     that stopped being true when B34-FE-FT-001 made them owner-filed.
 *   - it asserts a read fault RESOLVES to the fallback and leaks nothing. It
 *     never asks whether the data is still there afterwards. P5-C2 is that the
 *     old `catch` deleted it.
 *
 * So this file asserts ERASURE and SURVIVAL — the two properties nothing was
 * checking — against the real modules, plus the negative controls §11 requires
 * on the new owner-specific primitive.
 *
 * THE MUTANTS AT THE BOTTOM ARE THE POINT. A closure test that would still pass
 * against the broken code proves nothing. Each mutant reintroduces one specific
 * pre-repair behaviour into the real source and asserts that the corresponding
 * invariant above FAILS. If someone reverts the fix and these tests stay green,
 * these tests were worthless — the mutants are what makes that impossible.
 *
 * NOTHING HERE MAY BE RELAXED TO MAKE A CALL PASS.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');

globalThis.__DEV__ = false;

const USER_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

/** All ten stores B34-FE-FT-001 brought under actor scope. */
const FREE_TIER_KEYS = {
  brandSizing: 'kscan.freeTier.brandSizing.v1',
  outfitFeedback: 'kscan.freeTier.outfitFeedback.v1',
  careNotes: 'kscan.freeTier.careNotes.v1',
  wishlistIntent: 'kscan.freeTier.wishlistIntent.v1',
  collections: 'kscan.freeTier.collections.v1',
  wearTracking: 'kscan.freeTier.wearTracking.v1',
  activityLog: 'kscan.freeTier.activityLog.v1',
  styleBoards: 'kscan.freeTier.styleBoards.v1',
  utilityMeta: 'kscan.freeTier.utilityMeta.v1',
  syncQueue: 'kscan.freeTier.syncQueue.v1',
};

const FREE_TIER_REL = 'services/free-tier/freeTierStorage.ts';
const PURGE_REL = 'services/deletion/ownerTerminalPurge.ts';

/**
 * A process launch.
 *
 * `mutations` maps a repo-relative source path to a transform applied to that
 * file's text before it is transpiled. Production runs load no mutations; the
 * negative controls at the bottom of this file are the only callers that pass
 * any, and each one states which pre-repair behaviour it restores.
 */
function boot({ storage = new Map(), mutations = {} } = {}) {
  let faults = {};

  const asyncStorage = {
    async getItem(key) {
      if (faults.getItem) throw new Error('storage read fault');
      return storage.has(key) ? storage.get(key) : null;
    },
    async setItem(key, value) {
      if (faults.setItem) throw new Error('storage write fault');
      storage.set(key, value);
    },
    async removeItem(key) {
      if (faults.removeItem) throw new Error('storage remove fault');
      storage.delete(key);
    },
    async multiRemove(keys) {
      if (faults.multiRemove) throw new Error('storage batch-remove fault');
      for (const key of keys) storage.delete(key);
    },
    async getAllKeys() {
      if (faults.getAllKeys) throw new Error('storage listing fault');
      return [...storage.keys()];
    },
  };

  const cache = new Map();

  function nativeStub() {
    const noop = () => undefined;
    return new Proxy(
      { __esModule: true },
      {
        get: (target, prop) => {
          if (prop in target) return target[prop];
          if (prop === 'default') return nativeStub();
          return noop;
        },
      },
    );
  }

  function resolveFile(candidate) {
    if (path.extname(candidate) && fs.existsSync(candidate)) return candidate;
    for (const ext of ['.ts', '.tsx', '.js']) {
      if (fs.existsSync(candidate + ext)) return candidate + ext;
    }
    return null;
  }

  function load(absolute) {
    const resolved = resolveFile(absolute);
    if (!resolved) throw new Error(`unresolved module: ${absolute}`);
    if (cache.has(resolved)) return cache.get(resolved).exports;

    const module = { exports: {} };
    cache.set(resolved, module);

    const relative = path.relative(ROOT, resolved);
    let source = fs.readFileSync(resolved, 'utf8');
    if (mutations[relative]) source = mutations[relative](source, relative);

    const { outputText } = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
      },
      fileName: resolved,
    });

    const localRequire = (id) => {
      if (id === '@react-native-async-storage/async-storage') {
        return { __esModule: true, default: asyncStorage };
      }
      if (id === 'react-native') {
        return { Platform: { OS: 'android', select: (o) => o.android ?? o.default } };
      }
      if (id.startsWith('.')) return load(path.resolve(path.dirname(resolved), id));
      try {
        return require(id);
      } catch {
        return nativeStub();
      }
    };

    // eslint-disable-next-line no-new-func
    Function('exports', 'require', 'module', '__filename', '__dirname', outputText)(
      module.exports,
      localRequire,
      module,
      resolved,
      path.dirname(resolved),
    );
    return module.exports;
  }

  const actorContext = load(path.join(ROOT, 'services/actorContext'));
  const freeTier = load(path.join(ROOT, 'services/free-tier/freeTierStorage'));
  const purge = load(path.join(ROOT, 'services/deletion/ownerTerminalPurge'));

  return {
    storage,
    actorContext,
    freeTier,
    purge,
    signIn: (userId) => actorContext.advanceActorEpoch(userId),
    signOut: () => actorContext.advanceActorEpoch(null),
    injectFaults: (next) => {
      faults = next ?? {};
    },
    /** Physical keys currently present, so "erased" can be asserted literally. */
    keys: () => [...storage.keys()],
  };
}

/** Every purge dependency stubbed to succeed EXCEPT the free-tier one under test. */
function purgeDepsExceptFreeTier() {
  const deps = {};
  for (const name of [
    'purgeScans', 'purgeCloset', 'purgeClosetCandidates', 'purgeClosetSync',
    'purgeClosetRestoreMedia', 'purgeSavedLooks', 'purgeDressingRoomSessions',
    'purgeDressingRoomCompositions', 'purgeDressingRoomInteractions',
    'purgeSavedLookReturnContext', 'purgeStylistVoicePreference',
    'clearSignatureStylePreferences', 'clearSignatureStyleFeedback',
    'clearSignatureStyleReasons', 'clearPackingPlanCache', 'clearOnboarding',
  ]) {
    deps[name] = async () => ({ ok: true });
  }
  return deps;
}

function envelope(data, userId) {
  return JSON.stringify({ version: 1, userId, updatedAt: '2026-01-01T00:00:00.000Z', data });
}

function namespaced(app, key, owner) {
  return app.freeTier.__freeTierStorageInternals.namespacedKey(key, owner);
}

/** Seeds every free-tier store for `userId`, through the real write path. */
async function seedAllStores(app, userId) {
  app.signIn(userId);
  for (const key of Object.values(FREE_TIER_KEYS)) {
    await app.freeTier.writeStore(key, { owner: userId, key });
  }
}

// ─── §6 / §10 — terminal deletion ERASES, it does not merely hide ────────────

test('CPR-FT-001: terminal deletion physically removes the deleted actor\'s free-tier namespace', async () => {
  const app = boot();

  await seedAllStores(app, USER_A);
  const aKeys = Object.values(FREE_TIER_KEYS).map((key) => namespaced(app, key, USER_A));
  for (const key of aKeys) {
    assert.ok(app.storage.has(key), `precondition: ${key} must exist before the purge`);
  }

  // A is deleted while B is the actor actually signed in — the real sequencing.
  app.signIn(USER_B);
  const result = await app.purge.purgeOwnerScopedLocalData(USER_A, purgeDepsExceptFreeTier());

  assert.equal(result.complete, true, 'the free-tier step must report success');
  assert.ok(
    result.steps.some((step) => step.step === 'free_tier_stores' && step.ok),
    'terminal purge must carry a free-tier step at all',
  );

  for (const key of aKeys) {
    assert.ok(
      !app.storage.has(key),
      `${key} survived a terminal deletion — unreadable is not erased`,
    );
  }
});

test('CPR-FT-001: the purge takes the deleted actor\'s stores and NOTHING else on the device', async () => {
  const app = boot();

  await seedAllStores(app, USER_A);
  await seedAllStores(app, USER_B);

  // A signed-out visitor's own partition, and a pre-namespace legacy blob that
  // no account has been shown to own.
  app.signOut();
  await app.freeTier.writeStore(FREE_TIER_KEYS.wishlistIntent, { anonymous: true });
  app.storage.set(FREE_TIER_KEYS.careNotes, envelope({ legacy: true }));
  const unrelated = 'kscan.watchlist.deviceId.v1';
  app.storage.set(unrelated, 'device-scoped, not owner-filed');

  app.signIn(USER_B);
  await app.purge.purgeOwnerScopedLocalData(USER_A, purgeDepsExceptFreeTier());

  for (const key of Object.values(FREE_TIER_KEYS)) {
    assert.ok(
      app.storage.has(namespaced(app, key, USER_B)),
      `the signed-in actor's ${key} was taken by a purge meant for someone else`,
    );
  }
  assert.ok(
    app.storage.has(namespaced(app, FREE_TIER_KEYS.wishlistIntent, 'anonymous')),
    'the signed-out partition is device-local history no account deletion may take',
  );
  assert.ok(
    app.storage.has(FREE_TIER_KEYS.careNotes),
    'an unstamped legacy blob cannot be proven to belong to the deleted account',
  );
  assert.ok(app.storage.has(unrelated), 'unrelated device state must be untouched');

  // And B, still signed in, can still read their own data.
  assert.deepEqual(await app.freeTier.readStore(FREE_TIER_KEYS.collections, null), {
    owner: USER_B,
    key: FREE_TIER_KEYS.collections,
  });
});

test('DELETE -> RELAUNCH -> B: a fresh process after deletion hands B nothing of A\'s', async () => {
  const shared = new Map();

  const first = boot({ storage: shared });
  await seedAllStores(first, USER_A);
  first.signOut();
  await first.purge.purgeOwnerScopedLocalData(USER_A, purgeDepsExceptFreeTier());

  // Termination and relaunch: a genuinely fresh module graph over the same disk.
  const relaunched = boot({ storage: shared });
  relaunched.signIn(USER_B);

  for (const key of Object.values(FREE_TIER_KEYS)) {
    assert.equal(
      await relaunched.freeTier.readStore(key, null),
      null,
      `${key} from a deleted account reached the next account after a relaunch`,
    );
  }
  assert.deepEqual(
    relaunched.keys().filter((key) => key.includes(USER_A)),
    [],
    'no physical key naming the deleted actor may survive the relaunch',
  );
});

// ─── §6 / §11 — the primitive's own negative controls ────────────────────────

test('PURGE PRIMITIVE: an unusable actor id refuses the call and removes nothing', async () => {
  const app = boot();
  await seedAllStores(app, USER_A);
  const before = app.keys().sort();

  // A blank scope would address the anonymous partition; `anonymous` IS that
  // partition by name; a separator-bearing id could otherwise address a
  // namespace it does not own; a non-string is not an actor at all.
  for (const bad of ['', '   ', null, undefined, 'anonymous', `${USER_A}::${USER_B}`, 42, {}]) {
    const result = await app.freeTier.clearFreeTierStoresForActor(bad);
    assert.equal(result.ok, false, `${JSON.stringify(bad)} must be refused`);
    assert.equal(result.reason, 'missing_actor');
    assert.deepEqual(result.targetedKeys, [], 'a refused call targets nothing');
  }

  assert.deepEqual(app.keys().sort(), before, 'a refused purge removed something');
});

test('PURGE PRIMITIVE: it cannot reach another actor, and cannot clear all actors', async () => {
  const app = boot();
  await seedAllStores(app, USER_A);
  await seedAllStores(app, USER_B);

  const result = await app.freeTier.clearFreeTierStoresForActor(USER_A);

  assert.equal(result.ok, true);
  assert.equal(result.actorId, USER_A);
  assert.equal(result.targetedKeys.length, Object.keys(FREE_TIER_KEYS).length);
  assert.ok(
    result.targetedKeys.every((key) => key.endsWith(`::${USER_A}`)),
    'every targeted key must name the supplied actor',
  );
  assert.ok(
    !result.targetedKeys.some((key) => key.includes(USER_B)),
    'a purge for A named a key belonging to B',
  );
  for (const key of Object.values(FREE_TIER_KEYS)) {
    assert.ok(app.storage.has(namespaced(app, key, USER_B)), 'B lost data to A\'s purge');
  }
});

test('PURGE PRIMITIVE: it never consults the ambient actor', async () => {
  const app = boot();
  await seedAllStores(app, USER_A);

  // B is the live actor. If the primitive fell back to "the current actor" for
  // any reason, this call would take B's stores instead of A's.
  await seedAllStores(app, USER_B);
  app.signIn(USER_B);
  await app.freeTier.clearFreeTierStoresForActor(USER_A);

  assert.deepEqual(app.keys().filter((key) => key.includes(USER_A)), []);
  assert.equal(
    app.keys().filter((key) => key.includes(USER_B)).length,
    Object.keys(FREE_TIER_KEYS).length,
    'the ambient actor was purged instead of, or alongside, the named one',
  );

  // And it behaves identically with no actor signed in at all.
  app.signOut();
  const second = await app.freeTier.clearFreeTierStoresForActor(USER_B);
  assert.equal(second.ok, true, 'a departed owner is purgeable with nobody signed in');
  assert.deepEqual(app.keys().filter((key) => key.includes(USER_B)), []);
});

test('PURGE PRIMITIVE: it is idempotent and tolerates a partially cleaned namespace', async () => {
  const app = boot();
  await seedAllStores(app, USER_A);

  // An earlier run that got halfway.
  app.storage.delete(namespaced(app, FREE_TIER_KEYS.careNotes, USER_A));
  app.storage.delete(namespaced(app, FREE_TIER_KEYS.syncQueue, USER_A));

  assert.equal((await app.freeTier.clearFreeTierStoresForActor(USER_A)).ok, true);
  assert.equal((await app.freeTier.clearFreeTierStoresForActor(USER_A)).ok, true);
  assert.equal(
    (await app.freeTier.clearFreeTierStoresForActor('cccccccc-3333-4333-8333-cccccccccccc')).ok,
    true,
    'an actor that never wrote a single store is not an error',
  );
  assert.deepEqual(app.keys().filter((key) => key.includes(USER_A)), []);
});

test('PURGE PRIMITIVE: a batch-remove fault degrades to per-key removal, not to silence', async () => {
  const app = boot();
  await seedAllStores(app, USER_A);

  app.injectFaults({ multiRemove: true });
  const recovered = await app.freeTier.clearFreeTierStoresForActor(USER_A);
  assert.equal(recovered.ok, true, 'the per-key fallback must still complete the work');
  assert.deepEqual(app.keys().filter((key) => key.includes(USER_A)), []);

  // And when the storage layer cannot remove at all, it reports failure so the
  // marker survives and the whole purge is retried.
  await seedAllStores(app, USER_A);
  app.injectFaults({ multiRemove: true, removeItem: true });
  const failed = await app.freeTier.clearFreeTierStoresForActor(USER_A);
  assert.equal(failed.ok, false, 'an unremovable namespace must not report success');
  assert.equal(failed.reason, 'storage_error');
  app.injectFaults({});
});

// ─── §11 — the purge is unreachable outside a terminal, authorized lifecycle ──

test('NEGATIVE CONTROL: no free-tier data is reachable through a refused purge scope', async () => {
  const app = boot();
  await seedAllStores(app, USER_A);
  const before = app.keys().sort();

  // `purgeOwnerScopedLocalData` is the ONLY caller, and it refuses a blank
  // scope before any step runs. Pending, restored, transient-error and
  // unauthorized lifecycles never reach it at all — that decision lives in
  // terminalDeletionReconciler and is asserted in terminalDeletionCleanup.
  for (const blank of ['', '   ', null, undefined]) {
    const result = await app.purge.purgeOwnerScopedLocalData(blank, purgeDepsExceptFreeTier());
    assert.equal(result.complete, false);
    assert.deepEqual(result.steps, [{ step: 'owner_scope', ok: false }]);
  }
  assert.deepEqual(app.keys().sort(), before, 'a refused scope reached a purge primitive');
});

// ─── §7 — P5-C2: a transient read fault must not destroy valid data ──────────

test('P5-C2: a transient read fault leaves valid data intact and readable afterwards', async () => {
  const app = boot();
  const KEY = FREE_TIER_KEYS.styleBoards;
  const saved = { looks: [{ id: 'look-1', title: 'the one the user actually made' }] };

  app.signIn(USER_A);
  await app.freeTier.writeStore(KEY, saved);

  app.injectFaults({ getItem: true });
  assert.equal(
    await app.freeTier.readStore(KEY, 'FALLBACK'),
    'FALLBACK',
    'a read fault must resolve to the fallback, not reject',
  );

  assert.ok(
    app.storage.has(namespaced(app, KEY, USER_A)),
    'a transient read fault DELETED valid user data — this is P5-C2',
  );

  app.injectFaults({});
  assert.deepEqual(
    await app.freeTier.readStore(KEY, null),
    saved,
    'the data must still be there once the storage layer recovers',
  );
});

test('P5-C2: every store survives a read fault, including the ones with no server mirror', async () => {
  const app = boot();
  await seedAllStores(app, USER_A);

  app.injectFaults({ getItem: true });
  for (const key of Object.values(FREE_TIER_KEYS)) {
    await app.freeTier.readStore(key, null);
  }
  app.injectFaults({});

  for (const key of Object.values(FREE_TIER_KEYS)) {
    assert.deepEqual(
      await app.freeTier.readStore(key, null),
      { owner: USER_A, key },
      `${key} was destroyed by a read fault`,
    );
  }
});

test('P5-C2: a read fault on a LEGACY key neither adopts nor destroys it', async () => {
  const app = boot();
  app.storage.set(FREE_TIER_KEYS.wearTracking, envelope({ legacy: 'pre-upgrade wear log' }));

  app.signIn(USER_A);
  app.injectFaults({ getItem: true });
  assert.equal(await app.freeTier.readStore(FREE_TIER_KEYS.wearTracking, null), null);
  app.injectFaults({});

  assert.ok(
    app.storage.has(FREE_TIER_KEYS.wearTracking),
    'a fault during the upgrade read destroyed the data it was meant to migrate',
  );
  assert.deepEqual(
    await app.freeTier.readStore(FREE_TIER_KEYS.wearTracking, null),
    { legacy: 'pre-upgrade wear log' },
    'the retry must complete the adoption the fault interrupted',
  );
});

test('READ FAULTS: corruption is still cleared, because that data is genuinely unusable', async () => {
  const app = boot();
  app.signIn(USER_A);

  const key = namespaced(app, FREE_TIER_KEYS.collections, USER_A);
  app.storage.set(key, 'not json at all');
  assert.deepEqual(await app.freeTier.readStore(FREE_TIER_KEYS.collections, {}), {});
  assert.ok(!app.storage.has(key), 'unparseable data must be reset, not kept forever');

  // A version this build cannot read is the same class of unusable.
  app.storage.set(key, JSON.stringify({ version: 99, data: { future: true } }));
  assert.deepEqual(await app.freeTier.readStore(FREE_TIER_KEYS.collections, {}), {});
  assert.ok(!app.storage.has(key));
});

test('READ FAULTS: a blob stamped for another actor is refused WITHOUT being destroyed', async () => {
  const app = boot();
  const key = namespaced(app, FREE_TIER_KEYS.careNotes, USER_A);
  app.storage.set(key, envelope({ notes: 'B\'s' }, USER_B));

  app.signIn(USER_A);
  assert.deepEqual(
    await app.freeTier.readStore(FREE_TIER_KEYS.careNotes, {}),
    {},
    'the envelope stamp must be a real second check',
  );
  assert.ok(
    app.storage.has(key),
    'making another actor\'s misfiled row invisible is the requirement; destroying it is not',
  );
});

// ─── §5 / §14 — owner resolution never guesses ───────────────────────────────

test('OWNER RESOLUTION: an explicit-but-unusable owner refuses rather than falling back to the live actor', async () => {
  const app = boot();
  app.signIn(USER_A);
  await app.freeTier.writeStore(FREE_TIER_KEYS.wishlistIntent, { owner: 'A' });

  for (const malformed of ['   ', 'anonymous', `${USER_B}::${USER_A}`]) {
    assert.equal(
      await app.freeTier.writeStore(FREE_TIER_KEYS.wishlistIntent, { forged: true }, malformed),
      false,
      `a write for ${JSON.stringify(malformed)} must be refused, not filed under the live actor`,
    );
    assert.equal(
      await app.freeTier.readStore(FREE_TIER_KEYS.wishlistIntent, 'REFUSED', malformed),
      'REFUSED',
      'a read for an unusable owner must not fall through to the live actor',
    );
  }

  assert.deepEqual(
    await app.freeTier.readStore(FREE_TIER_KEYS.wishlistIntent, null),
    { owner: 'A' },
    'the live actor\'s own data must be untouched by the refused calls',
  );
});

test('LATE WRITE: a sync response for the departed actor lands in THEIR namespace, not the new one', async () => {
  const app = boot();

  // The shape services/free-tier/freeTierSupabaseSync.ts uses: capture the id
  // it is syncing for, then write with it after an await that may outlive the
  // session.
  app.signIn(USER_A);
  const syncingFor = USER_A;
  app.signIn(USER_B);
  await app.freeTier.writeStore(FREE_TIER_KEYS.careNotes, { from: 'A backend' }, syncingFor);

  assert.equal(
    await app.freeTier.readStore(FREE_TIER_KEYS.careNotes, null),
    null,
    'a late response for A appeared in B\'s session',
  );
  assert.ok(app.storage.has(namespaced(app, FREE_TIER_KEYS.careNotes, USER_A)));
});

test('RMW: an actor switch between the read and the write cannot move A\'s rows into B', async () => {
  const app = boot();

  app.signIn(USER_A);
  await app.freeTier.writeStore(FREE_TIER_KEYS.activityLog, ['a-event']);

  const committed = await app.freeTier.updateStore(
    FREE_TIER_KEYS.activityLog,
    [],
    (current) => {
      // The switch lands mid-update, exactly as a sign-out during a save would.
      app.signIn(USER_B);
      return [...current, 'a-event-2'];
    },
  );

  assert.deepEqual(committed, ['a-event', 'a-event-2']);
  assert.deepEqual(
    await app.freeTier.readStore(FREE_TIER_KEYS.activityLog, null),
    null,
    'B inherited an update that began under A',
  );
  app.signIn(USER_A);
  assert.deepEqual(await app.freeTier.readStore(FREE_TIER_KEYS.activityLog, null), [
    'a-event',
    'a-event-2',
  ]);
});

// ─── §12 / §13 — upgrade and cold start ──────────────────────────────────────

test('UPGRADE: adopted legacy data is owned, survives a relaunch, and is erased by deletion', async () => {
  const shared = new Map();
  shared.set(FREE_TIER_KEYS.wishlistIntent, envelope({ 'item-9': { intent: 'wishlist' } }));

  const first = boot({ storage: shared });
  first.signIn(USER_A);
  assert.deepEqual(
    await first.freeTier.readStore(FREE_TIER_KEYS.wishlistIntent, {}),
    { 'item-9': { intent: 'wishlist' } },
    'an upgrading user must not silently lose their wardrobe notes',
  );
  assert.ok(!shared.has(FREE_TIER_KEYS.wishlistIntent), 'adoption runs at most once');

  // Relaunch: the migrated data is still A's, and still only A's.
  const relaunched = boot({ storage: shared });
  relaunched.signIn(USER_A);
  assert.deepEqual(await relaunched.freeTier.readStore(FREE_TIER_KEYS.wishlistIntent, {}), {
    'item-9': { intent: 'wishlist' },
  });
  relaunched.signIn(USER_B);
  assert.deepEqual(
    await relaunched.freeTier.readStore(FREE_TIER_KEYS.wishlistIntent, {}),
    {},
    'a second account adopted the first account\'s legacy data',
  );

  // And deletion erases the migrated state, not just the natively-written kind.
  relaunched.signIn(USER_B);
  await relaunched.purge.purgeOwnerScopedLocalData(USER_A, purgeDepsExceptFreeTier());
  assert.deepEqual(relaunched.keys().filter((key) => key.includes(USER_A)), []);
});

test('UPGRADE: an old store format crashes nothing and costs the wrong actor nothing', async () => {
  const app = boot();
  // Shapes a pre-repair build could plausibly have left behind.
  app.storage.set(FREE_TIER_KEYS.collections, JSON.stringify({ version: 0, data: [] }));
  app.storage.set(FREE_TIER_KEYS.careNotes, JSON.stringify(['a bare array, no envelope']));
  app.storage.set(FREE_TIER_KEYS.brandSizing, '');

  app.signIn(USER_A);
  for (const key of [FREE_TIER_KEYS.collections, FREE_TIER_KEYS.careNotes, FREE_TIER_KEYS.brandSizing]) {
    assert.deepEqual(await app.freeTier.readStore(key, {}), {}, `${key} must degrade, not throw`);
  }

  app.signIn(USER_B);
  for (const key of Object.values(FREE_TIER_KEYS)) {
    assert.deepEqual(await app.freeTier.readStore(key, {}), {});
  }
});

test('COLD START: a read before the actor resolves uses the anonymous partition and adopts nothing', async () => {
  const shared = new Map();
  shared.set(FREE_TIER_KEYS.careNotes, envelope({ legacy: true }));

  const app = boot({ storage: shared });
  // No advanceActorEpoch yet — this is the window before auth resolves.
  assert.deepEqual(await app.freeTier.readStore(FREE_TIER_KEYS.careNotes, {}), {});
  await app.freeTier.writeStore(FREE_TIER_KEYS.collections, { written: 'unresolved' });

  assert.ok(
    shared.has(FREE_TIER_KEYS.careNotes),
    'an unresolved reader must not consume the legacy blob a real actor may own',
  );
  assert.ok(
    shared.has(namespaced(app, FREE_TIER_KEYS.collections, 'anonymous')),
    'an unresolved write must land in the anonymous partition',
  );

  // Auth then resolves — to either account — and neither inherits the other's
  // unresolved-window write.
  for (const actor of [USER_A, USER_B]) {
    app.signIn(actor);
    assert.deepEqual(
      await app.freeTier.readStore(FREE_TIER_KEYS.collections, null),
      null,
      `${actor} adopted a write made before any actor was known`,
    );
  }
});

test('COLD START: an actor authority that cannot answer fails closed', async () => {
  const app = boot({
    mutations: {
      // The authority throwing is not a case the real one can produce today;
      // this proves the storage layer does not ASSUME that, because "cannot
      // answer" must never be read as "signed out with someone's data".
      'services/actorScope.ts': (source) =>
        source.replace(
          'export function currentActorId(): string | null {\n  return getActorContext().actorId;\n}',
          'export function currentActorId(): string | null {\n  throw new Error("actor authority unavailable");\n}',
        ),
    },
  });

  await app.freeTier.writeStore(FREE_TIER_KEYS.wishlistIntent, { x: 1 });
  assert.deepEqual(
    await app.freeTier.readStore(FREE_TIER_KEYS.wishlistIntent, null),
    { x: 1 },
    'a broken authority must still resolve, into the partition nobody else can read',
  );
  assert.ok(
    app.storage.has(namespaced(app, FREE_TIER_KEYS.wishlistIntent, 'anonymous')),
    'a broken authority must degrade to the anonymous partition, never to an account',
  );
});

// ─── §18 — NEGATIVE CONTROLS: the mutants ────────────────────────────────────
//
// Each of these restores one pre-repair behaviour into the real source and
// asserts the closure invariant above FAILS. Without them, nothing proves these
// tests can tell a repaired build from a broken one.

/**
 * Pre-B34-FE-FT-001: one device-wide key per store, and an envelope `userId`
 * that is written but never compared.
 *
 * BOTH removals are required, and that is worth stating. Dropping the namespace
 * alone does NOT reopen the leak — the envelope-stamp check catches A's blob
 * under the shared key and refuses it. The repair's "two independent checks"
 * claim is therefore not decoration: either layer alone still closes the
 * reported defect, so the mutant has to defeat both to reconstruct the
 * pre-repair behaviour the closure tests must be able to detect.
 */
const GLOBAL_KEY_MUTANT = {
  [FREE_TIER_REL]: (source) => {
    const flattened = source.replace(
      'function namespacedKey(key: FreeTierStorageKey, owner: string): string {\n  return `${key}${OWNER_SEPARATOR}${owner}`;\n}',
      'function namespacedKey(key: FreeTierStorageKey, _owner: string): string {\n  return key;\n}',
    );
    assert.notEqual(flattened, source, 'the global-key mutant no longer matches namespacedKey');
    const unchecked = flattened.replace(
      "  if (stamped && owner !== ANONYMOUS_OWNER && stamped !== owner) return { status: 'foreign' };",
      '  // stamp recorded, never compared — the pre-repair behaviour',
    );
    assert.notEqual(unchecked, flattened, 'the global-key mutant no longer matches the stamp check');
    return unchecked;
  },
};

/** Pre-P5-C2-repair: one `try` around the whole read, whose `catch` deletes. */
const DELETE_ON_FAULT_MUTANT = {
  [FREE_TIER_REL]: (source) =>
    source.replace(
      '  if (!loaded.ok) return fallback;\n\n  if (loaded.raw === null) {',
      '  if (!loaded.ok) {\n    await removeQuietly(physicalKey);\n    return fallback;\n  }\n\n  if (loaded.raw === null) {',
    ),
};

/** Pre-CPR-FT-001: the terminal purge skips the free-tier stores. */
const NO_FREE_TIER_PURGE_MUTANT = {
  [PURGE_REL]: (source) =>
    source.replace(
      /steps\.push\(\s*await runStep\('free_tier_stores',[\s\S]*?\),\s*\);/,
      '',
    ),
};

function assertMutantApplied(mutations, rel, marker) {
  const source = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  assert.notEqual(
    mutations[rel](source, rel),
    source,
    `the ${marker} mutant no longer matches the source — it is testing nothing`,
  );
}

test('MUTANT: restoring the pre-repair storage reopens the cross-account leak', async () => {
  assertMutantApplied(GLOBAL_KEY_MUTANT, FREE_TIER_REL, 'global-key');
  const app = boot({ mutations: GLOBAL_KEY_MUTANT });

  app.signIn(USER_A);
  await app.freeTier.writeStore(FREE_TIER_KEYS.wishlistIntent, { a: 1 });
  app.signIn(USER_B);

  assert.deepEqual(
    await app.freeTier.readStore(FREE_TIER_KEYS.wishlistIntent, null),
    { a: 1 },
    'the mutant did not reproduce B34-FE-FT-001 — the isolation tests prove nothing',
  );
});

test('MUTANT: the namespace ALONE still closes the leak, so both layers are real', async () => {
  const namespaceOnly = {
    [FREE_TIER_REL]: (source) => {
      const unchecked = source.replace(
        "  if (stamped && owner !== ANONYMOUS_OWNER && stamped !== owner) return { status: 'foreign' };",
        '  // stamp recorded, never compared',
      );
      assert.notEqual(unchecked, source, 'the stamp-only mutant no longer matches the source');
      return unchecked;
    },
  };
  const app = boot({ mutations: namespaceOnly });

  app.signIn(USER_A);
  await app.freeTier.writeStore(FREE_TIER_KEYS.wishlistIntent, { a: 1 });
  app.signIn(USER_B);

  assert.equal(
    await app.freeTier.readStore(FREE_TIER_KEYS.wishlistIntent, null),
    null,
    'with the stamp check gone, the namespace must still hold the boundary alone',
  );
});

test('MUTANT: restoring the device-global key breaks owner-specific deletion', async () => {
  const app = boot({ mutations: GLOBAL_KEY_MUTANT });

  app.signIn(USER_A);
  await app.freeTier.writeStore(FREE_TIER_KEYS.careNotes, { a: 1 });
  app.signIn(USER_B);
  await app.freeTier.writeStore(FREE_TIER_KEYS.careNotes, { b: 2 });

  // With one shared key there is no such thing as "A's namespace": purging A
  // necessarily takes the signed-in actor's data too.
  await app.freeTier.clearFreeTierStoresForActor(USER_A);

  assert.equal(
    await app.freeTier.readStore(FREE_TIER_KEYS.careNotes, null),
    null,
    'the mutant did not reproduce CPR-FT-001\'s blast radius — the wrong-actor test proves nothing',
  );
});

test('MUTANT: restoring delete-on-read-fault destroys valid data', async () => {
  assertMutantApplied(DELETE_ON_FAULT_MUTANT, FREE_TIER_REL, 'delete-on-fault');
  const app = boot({ mutations: DELETE_ON_FAULT_MUTANT });

  app.signIn(USER_A);
  await app.freeTier.writeStore(FREE_TIER_KEYS.styleBoards, { looks: ['irreplaceable'] });

  app.injectFaults({ getItem: true });
  await app.freeTier.readStore(FREE_TIER_KEYS.styleBoards, null);
  app.injectFaults({});

  assert.ok(
    !app.storage.has(namespaced(app, FREE_TIER_KEYS.styleBoards, USER_A)),
    'the mutant did not reproduce P5-C2 — the survival test above proves nothing',
  );
});

test('MUTANT: dropping the free-tier purge step reproduces CPR-FT-001', async () => {
  assertMutantApplied(NO_FREE_TIER_PURGE_MUTANT, PURGE_REL, 'no-free-tier-purge');
  const app = boot({ mutations: NO_FREE_TIER_PURGE_MUTANT });

  await seedAllStores(app, USER_A);
  app.signIn(USER_B);
  const result = await app.purge.purgeOwnerScopedLocalData(USER_A, purgeDepsExceptFreeTier());

  assert.equal(result.complete, true, 'the mutant purge still reports success — that was the defect');
  assert.ok(
    !result.steps.some((step) => step.step === 'free_tier_stores'),
    'the mutant must actually remove the step',
  );
  assert.equal(
    app.keys().filter((key) => key.includes(USER_A)).length,
    Object.keys(FREE_TIER_KEYS).length,
    'the mutant did not reproduce CPR-FT-001 — the erasure test above proves nothing',
  );
});
