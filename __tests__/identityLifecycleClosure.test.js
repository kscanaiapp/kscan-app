/**
 * Build 34 Android — identity, deletion and regression CLOSURE harness.
 *
 * WHY THIS EXISTS AND WHAT MAKES IT DIFFERENT. The repair suites written with
 * B34-FE-FT-001 each exercise ONE module against a hand-made fake. That proves
 * the module. It does not prove the SYSTEM: that the actor authority the app
 * actually advances on an auth transition is the same one the storage layer
 * reads, that a cold start resolves an actor before anything commits, or that
 * a purge running for a departed owner leaves the signed-in one alone.
 *
 * So this file wires the REAL modules together through ONE shared module graph
 * — services/actorContext.js (the epoch authority AuthSessionContext advances),
 * services/actorScope.ts, services/free-tier/freeTierStorage.ts,
 * services/kplus/kplusEntitlementStore.ts,
 * services/analytics/posthogIdentitySync.ts and
 * services/deletion/ownerTerminalPurge.ts — and drives them through the
 * lifecycles a real handset goes through: A -> B, cold start, rapid switch,
 * delete -> relaunch, delete -> B.
 *
 * The one thing faked is the leaf I/O (AsyncStorage) and the purge's own
 * subsystem primitives, which are injected through the dependency seam
 * ownerTerminalPurge already exposes for exactly this purpose.
 *
 * NOTHING HERE MAY BE RELAXED TO MAKE A CALL PASS. Every assertion states an
 * isolation invariant; weakening one would be weakening the boundary it names.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');

// React Native's global, referenced by several of the real modules' dev-log paths.
globalThis.__DEV__ = false;

const USER_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

/** Every free-tier store the B34-FE-FT-001 repair brought under actor scope. */
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

/**
 * One module graph per scenario — the app's own singletons are module-scoped,
 * so a scenario that wants a COLD START must get a genuinely fresh graph
 * rather than a reset one. `boot()` is what a process launch looks like here.
 */
function boot(initialStorage = new Map()) {
  const storage = initialStorage;
  let deferReads = null;

  let faults = {};

  const asyncStorage = {
    async getItem(key) {
      if (deferReads) await deferReads;
      if (faults.getItem) throw new Error('storage read fault');
      return storage.has(key) ? storage.get(key) : null;
    },
    async setItem(key, value) {
      if (faults.setItem) throw new Error('storage write fault');
      storage.set(key, value);
    },
    async removeItem(key) {
      storage.delete(key);
    },
    async multiRemove(keys) {
      for (const key of keys) storage.delete(key);
    },
    async getAllKeys() {
      if (faults.getAllKeys) throw new Error('storage listing fault');
      return [...storage.keys()];
    },
  };

  const cache = new Map();

  /** A module whose every export is a harmless no-op, for native leaves. */
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

    const { outputText } = ts.transpileModule(fs.readFileSync(resolved, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
      },
      fileName: resolved,
    });

    const localRequire = (id) => {
      // `__esModule` matters: without it esModuleInterop wraps the mock twice
      // and the default import resolves to the wrapper, not the storage.
      if (id === '@react-native-async-storage/async-storage') {
        return { __esModule: true, default: asyncStorage };
      }
      if (id === 'react-native') {
        return { Platform: { OS: 'android', select: (o) => o.android ?? o.default } };
      }
      if (id.endsWith('/kplusClient')) return kplusClientStub;
      if (id.startsWith('.')) return load(path.resolve(path.dirname(resolved), id));
      try {
        return require(id);
      } catch {
        // Native/Expo leaves (expo-file-system, expo-crypto, …) are pulled in
        // transitively by the purge module's DEFAULT dependencies. Every test
        // here injects its own purge deps, so those defaults are never called —
        // they only have to be constructible.
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

  /** Controllable K+ backend, so a late response can be made to land after a switch. */
  const kplusClientStub = {
    fetchKPlusStatus: async () => kplusClientStub.__next,
    activateKPlusEarlyAccess: async () => ({ ok: false, reason: 'request_failed' }),
    __next: { ok: true, row: null },
  };

  const actorContext = load(path.join(ROOT, 'services/actorContext'));
  const freeTier = load(path.join(ROOT, 'services/free-tier/freeTierStorage'));
  const kplus = load(path.join(ROOT, 'services/kplus/kplusEntitlementStore'));
  const posthogSync = load(path.join(ROOT, 'services/analytics/posthogIdentitySync'));
  const purge = load(path.join(ROOT, 'services/deletion/ownerTerminalPurge'));

  return {
    storage,
    actorContext,
    freeTier,
    kplus,
    kplusClientStub,
    posthogSync,
    purge,
    /** What AuthSessionContext.resetActorScopedRuntimeState does, in order. */
    signIn(userId) {
      actorContext.advanceActorEpoch(userId);
      kplus.resetKPlusEntitlementCache();
    },
    signOut() {
      actorContext.advanceActorEpoch(null);
      kplus.resetKPlusEntitlementCache();
    },
    /** Makes the named AsyncStorage operations throw. */
    injectFaults(next) {
      faults = next ?? {};
    },
    /** Holds every storage read open until `release()` is called. */
    holdReads() {
      let release;
      deferReads = new Promise((resolve) => {
        release = resolve;
      });
      return () => {
        const done = deferReads;
        deferReads = null;
        release();
        return done;
      };
    },
  };
}

/** Every injectable purge step, stubbed to succeed. */
function noopPurgeDeps() {
  const deps = {};
  for (const name of [
    'purgeScans', 'purgeCloset', 'purgeClosetCandidates', 'purgeClosetSync',
    'purgeClosetRestoreMedia', 'purgeSavedLooks', 'purgeDressingRoomSessions',
    'purgeDressingRoomCompositions', 'purgeDressingRoomInteractions',
    'purgeSavedLookReturnContext', 'purgeStylistVoicePreference',
    'clearSignatureStylePreferences', 'clearSignatureStyleFeedback',
    'clearSignatureStyleReasons', 'clearPackingPlanCache', 'clearOnboarding',
    // CPR-FT-001 — owner-scoped since B34-FE-FT-001, purged since this campaign.
    'clearFreeTierStores',
  ]) {
    deps[name] = async () => ({ ok: true });
  }
  return deps;
}

function envelope(data, userId) {
  return JSON.stringify({ version: 1, userId, updatedAt: '2026-01-01T00:00:00.000Z', data });
}

// ─── §5 / §6 — USER A -> USER B across every repaired store ──────────────────

test('A -> B: none of the eight repaired free-tier stores crosses accounts', async () => {
  const app = boot();
  const stores = Object.values(FREE_TIER_KEYS);

  app.signIn(USER_A);
  for (const key of stores) {
    await app.freeTier.writeStore(key, { owner: 'A', key });
  }
  for (const key of stores) {
    assert.deepEqual(await app.freeTier.readStore(key, null), { owner: 'A', key });
  }

  app.signOut();
  app.signIn(USER_B);

  for (const key of stores) {
    assert.equal(
      await app.freeTier.readStore(key, null),
      null,
      `${key} leaked User A's data into User B's session`,
    );
  }
});

test('A -> B: B writing does not reach A, and A -> B -> A returns A their own', async () => {
  const app = boot();
  const KEY = FREE_TIER_KEYS.wishlistIntent;

  app.signIn(USER_A);
  await app.freeTier.writeStore(KEY, { a: 1 });
  app.signIn(USER_B);
  await app.freeTier.writeStore(KEY, { b: 2 });

  app.signIn(USER_A);
  assert.deepEqual(await app.freeTier.readStore(KEY, null), { a: 1 });
  app.signIn(USER_B);
  assert.deepEqual(await app.freeTier.readStore(KEY, null), { b: 2 });
});

// ─── §7 — cold start ─────────────────────────────────────────────────────────

test('COLD START: a fresh process with a restored B session reads only B', async () => {
  const first = boot();
  first.signIn(USER_A);
  await first.freeTier.writeStore(FREE_TIER_KEYS.careNotes, { owner: 'A' });
  first.signIn(USER_B);
  await first.freeTier.writeStore(FREE_TIER_KEYS.careNotes, { owner: 'B' });

  // Process death, then relaunch with the SAME disk and a restored B session.
  const relaunched = boot(first.storage);
  relaunched.signIn(USER_B);

  assert.deepEqual(await relaunched.freeTier.readStore(FREE_TIER_KEYS.careNotes, null), {
    owner: 'B',
  });
});

test('COLD START: a read taken BEFORE the actor resolves sees no account data and adopts nothing', async () => {
  const seeded = new Map();
  seeded.set(FREE_TIER_KEYS.wishlistIntent, envelope({ legacy: true }));

  const app = boot(seeded);

  // The window between JS bootstrap and the first advanceActorEpoch(): the
  // actor is genuinely unknown. It must resolve to the anonymous partition,
  // NOT to the pre-namespace global key.
  assert.equal(app.actorContext.getActorContext().actorId, null);
  assert.equal(await app.freeTier.readStore(FREE_TIER_KEYS.wishlistIntent, null), null);
  assert.ok(
    app.storage.has(FREE_TIER_KEYS.wishlistIntent),
    'an unresolved actor must not consume the legacy blob',
  );

  // Once the real actor arrives it still gets its one legitimate adoption.
  app.signIn(USER_A);
  assert.deepEqual(await app.freeTier.readStore(FREE_TIER_KEYS.wishlistIntent, null), {
    legacy: true,
  });
});

test('COLD START: a write taken before the actor resolves lands in the anonymous partition, never an account', async () => {
  const app = boot();
  await app.freeTier.writeStore(FREE_TIER_KEYS.activityLog, { stray: true });

  app.signIn(USER_A);
  assert.equal(
    await app.freeTier.readStore(FREE_TIER_KEYS.activityLog, null),
    null,
    'a pre-resolution write must never be attributed to the account that signs in next',
  );
});

// ─── §8 — rapid account-switch race ──────────────────────────────────────────

test('RACE: a read started as A and resolved after the switch cannot be written into B', async () => {
  const app = boot();
  const KEY = FREE_TIER_KEYS.collections;

  app.signIn(USER_A);
  await app.freeTier.writeStore(KEY, { a: 1 });

  // A's read is in flight...
  const release = app.holdReads();
  const inFlight = app.freeTier.readStore(KEY, null);

  // ...and the actor changes underneath it.
  app.signOut();
  app.signIn(USER_B);

  release();
  const resolved = await inFlight;

  // The owner was resolved when the call was MADE, so the late result is still
  // A's — and it must have gone nowhere near B's namespace.
  assert.deepEqual(resolved, { a: 1 }, "A's own in-flight read still resolves to A's data");
  assert.equal(
    await app.freeTier.readStore(KEY, null),
    null,
    "B must not observe A's late result",
  );
});

test('RACE: updateStore started as A commits to A, leaving B untouched', async () => {
  const app = boot();
  const KEY = FREE_TIER_KEYS.wearTracking;

  app.signIn(USER_A);
  await app.freeTier.writeStore(KEY, { count: 1 });

  const release = app.holdReads();
  const inFlight = app.freeTier.updateStore(KEY, {}, (current) => ({
    count: (current.count ?? 0) + 1,
  }));

  app.signIn(USER_B);
  release();
  await inFlight;

  assert.equal(await app.freeTier.readStore(KEY, null), null, 'B saw a write meant for A');
  app.signIn(USER_A);
  assert.deepEqual(await app.freeTier.readStore(KEY, null), { count: 2 });
});

test('RACE: a late K+ response from the previous actor is discarded, not applied', async () => {
  const app = boot();

  app.signIn(USER_A);
  app.kplusClientStub.__next = {
    ok: true,
    row: {
      entitlementKey: 'k_plus',
      status: 'active',
      grantReason: 'complimentary_early_access',
      campaignKey: 'c',
      grantedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2099-01-01T00:00:00.000Z',
      revokedAt: null,
      externalSyncStatus: 'not_required',
    },
  };

  const inFlight = app.kplus.refreshKPlusEntitlement();
  // A leaves and B arrives while A's entitlement read is still outstanding.
  app.signOut();
  app.signIn(USER_B);
  await inFlight;

  const snapshot = app.kplus.getKPlusEntitlementSnapshot();
  assert.notEqual(snapshot.state, 'active', "A's K+ grant was applied to B");
  assert.equal(snapshot.state, 'loading', 'B is still resolving, which is not Free either');
  app.kplus.__clearKPlusExpiryTimerForTests();
});

// ─── §6 — legacy adoption can happen once, for one actor ─────────────────────

test('two accounts cannot both adopt the same legacy blob', async () => {
  const seeded = new Map();
  seeded.set(FREE_TIER_KEYS.brandSizing, envelope({ shared: 'legacy' }));
  const app = boot(seeded);

  app.signIn(USER_A);
  assert.deepEqual(await app.freeTier.readStore(FREE_TIER_KEYS.brandSizing, null), {
    shared: 'legacy',
  });

  app.signIn(USER_B);
  assert.equal(await app.freeTier.readStore(FREE_TIER_KEYS.brandSizing, null), null);

  // And the adoption survives a relaunch for A alone.
  const relaunched = boot(app.storage);
  relaunched.signIn(USER_B);
  assert.equal(await relaunched.freeTier.readStore(FREE_TIER_KEYS.brandSizing, null), null);
  relaunched.signIn(USER_A);
  assert.deepEqual(await relaunched.freeTier.readStore(FREE_TIER_KEYS.brandSizing, null), {
    shared: 'legacy',
  });
});

test('a blob stamped for another actor is refused even when it sits under this actor\'s key', async () => {
  const app = boot();
  const { namespacedKey } = app.freeTier.__freeTierStorageInternals;
  app.storage.set(namespacedKey(FREE_TIER_KEYS.outfitFeedback, USER_A), envelope({ b: 1 }, USER_B));

  app.signIn(USER_A);
  assert.equal(await app.freeTier.readStore(FREE_TIER_KEYS.outfitFeedback, null), null);
});

// ─── §11 / §12 — terminal purge runs for a DEPARTED owner ────────────────────

test('DELETE: purging a departed owner leaves the signed-in actor completely intact', async () => {
  const app = boot();
  const purged = [];
  const deps = {};
  for (const name of [
    'purgeScans', 'purgeCloset', 'purgeClosetCandidates', 'purgeClosetSync',
    'purgeClosetRestoreMedia', 'purgeSavedLooks', 'purgeDressingRoomSessions',
    'purgeDressingRoomCompositions', 'purgeDressingRoomInteractions',
    'purgeSavedLookReturnContext', 'purgeStylistVoicePreference',
    'clearSignatureStylePreferences', 'clearSignatureStyleFeedback',
    'clearSignatureStyleReasons', 'clearPackingPlanCache', 'clearOnboarding',
  ]) {
    deps[name] = async (owner) => {
      purged.push({ name, owner });
      return { ok: true };
    };
  }

  // A is deleted; B is the one actually signed in while reconciliation runs.
  app.signIn(USER_B);
  const result = await app.purge.purgeOwnerScopedLocalData(USER_A, deps);

  assert.equal(result.complete, true);
  assert.equal(result.ownerId, USER_A);
  assert.ok(
    purged.every((call) => call.owner === USER_A || call.owner === `user:${USER_A}`),
    'a purge step targeted someone other than the deleted owner',
  );
  assert.ok(
    !purged.some((call) => call.owner === USER_B || call.owner === `user:${USER_B}`),
    "the signed-in actor's data was handed to a purge meant for the deleted one",
  );
});

test('DELETE: a blank owner purges nothing — an empty scope is the signed-out partition', async () => {
  const app = boot();
  let touched = 0;
  const deps = { purgeScans: async () => { touched += 1; return { ok: true }; } };

  for (const blank of ['', '   ', null, undefined]) {
    const result = await app.purge.purgeOwnerScopedLocalData(blank, deps);
    assert.equal(result.complete, false);
    assert.deepEqual(result.steps, [{ step: 'owner_scope', ok: false }]);
  }
  assert.equal(touched, 0, 'a blank owner must never reach a purge primitive');
});

test('DELETE: one broken subsystem fails the run without stopping the others', async () => {
  const app = boot();
  const ran = [];
  const deps = {
    purgeScans: async () => { ran.push('scans'); throw new Error('disk'); },
    purgeCloset: async () => { ran.push('closet'); return { ok: true }; },
    clearOnboarding: async () => { ran.push('onboarding'); },
  };

  const result = await app.purge.purgeOwnerScopedLocalData(USER_A, deps);

  assert.equal(result.complete, false, 'an incomplete purge must not report complete');
  assert.ok(ran.includes('closet') && ran.includes('onboarding'), 'later steps were skipped');
  assert.equal(result.steps.find((s) => s.step === 'recent_scans').ok, false);
  assert.equal(result.steps.find((s) => s.step === 'closet_items').ok, true);
});

test('DELETE -> B: the deleted account\'s free-tier namespace is unreadable by the next account', async () => {
  const app = boot();

  app.signIn(USER_A);
  for (const key of Object.values(FREE_TIER_KEYS)) {
    await app.freeTier.writeStore(key, { owner: 'A' });
  }

  // A is deleted and signed out; B arrives on the same handset.
  app.signOut();
  await app.purge.purgeOwnerScopedLocalData(USER_A, noopPurgeDeps());
  app.signIn(USER_B);

  for (const key of Object.values(FREE_TIER_KEYS)) {
    assert.equal(
      await app.freeTier.readStore(key, null),
      null,
      `${key} from a DELETED account was readable by the next account`,
    );
  }
});

// ─── §5 / §13 — analytics identity ───────────────────────────────────────────

test('POSTHOG: A -> logout -> B always resets before establishing a different identity', () => {
  const app = boot();
  const calls = [];
  const client = {
    identify: (id) => calls.push(`identify:${id}`),
    reset: () => calls.push('reset'),
  };

  app.posthogSync.syncPostHogIdentityWith(client, null);
  app.posthogSync.syncPostHogIdentityWith(client, USER_A);
  app.posthogSync.syncPostHogIdentityWith(client, null);
  app.posthogSync.syncPostHogIdentityWith(client, USER_B);

  assert.deepEqual(calls, [
    'reset',
    'reset', `identify:${USER_A}`,
    'reset',
    'reset', `identify:${USER_B}`,
  ]);
  app.posthogSync.__resetPostHogIdentitySyncForTests();
});

test('POSTHOG: a coalesced A -> B switch still resets first', () => {
  const app = boot();
  const calls = [];
  const client = { identify: (id) => calls.push(`identify:${id}`), reset: () => calls.push('reset') };

  app.posthogSync.syncPostHogIdentityWith(client, USER_A);
  calls.length = 0;
  // No intervening null — the session id changes straight from A to B.
  app.posthogSync.syncPostHogIdentityWith(client, USER_B);

  assert.deepEqual(calls, ['reset', `identify:${USER_B}`]);
  app.posthogSync.__resetPostHogIdentitySyncForTests();
});

test('POSTHOG: re-syncing the same actor is a no-op, so a re-render cannot churn identity', () => {
  const app = boot();
  const calls = [];
  const client = { identify: (id) => calls.push(`identify:${id}`), reset: () => calls.push('reset') };

  app.posthogSync.syncPostHogIdentityWith(client, USER_A);
  calls.length = 0;
  for (let i = 0; i < 25; i += 1) app.posthogSync.syncPostHogIdentityWith(client, USER_A);

  assert.deepEqual(calls, [], 'identity churned on re-render');
  app.posthogSync.__resetPostHogIdentitySyncForTests();
});

// ─── §14 — entitlement isolation ─────────────────────────────────────────────

test('KPLUS: an active grant for A is gone the moment the actor boundary is crossed', async () => {
  const app = boot();
  app.signIn(USER_A);
  app.kplusClientStub.__next = {
    ok: true,
    row: {
      entitlementKey: 'k_plus',
      status: 'active',
      grantReason: 'complimentary_early_access',
      campaignKey: 'c',
      grantedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2099-01-01T00:00:00.000Z',
      revokedAt: null,
      externalSyncStatus: 'not_required',
    },
  };
  await app.kplus.refreshKPlusEntitlement();
  assert.equal(app.kplus.getKPlusEntitlementSnapshot().state, 'active');

  app.signOut();
  assert.equal(app.kplus.getKPlusEntitlementSnapshot().state, 'loading');
  app.signIn(USER_B);
  assert.notEqual(app.kplus.getKPlusEntitlementSnapshot().state, 'active');
  app.kplus.__clearKPlusExpiryTimerForTests();
});

test('KPLUS: a revoked-but-still-active row fails closed, and a read failure is never Free', async () => {
  const app = boot();
  app.signIn(USER_A);

  app.kplusClientStub.__next = {
    ok: true,
    row: {
      entitlementKey: 'k_plus',
      status: 'active',
      grantReason: 'complimentary_early_access',
      campaignKey: 'c',
      grantedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2099-01-01T00:00:00.000Z',
      revokedAt: '2026-02-01T00:00:00.000Z',
      externalSyncStatus: 'not_required',
    },
  };
  await app.kplus.refreshKPlusEntitlement();
  assert.equal(app.kplus.getKPlusEntitlementSnapshot().state, 'expired');

  app.kplusClientStub.__next = { ok: false, reason: 'read_failed' };
  await app.kplus.refreshKPlusEntitlement();
  const snapshot = app.kplus.getKPlusEntitlementSnapshot();
  assert.equal(snapshot.state, 'error');
  assert.notEqual(snapshot.state, 'eligible', 'a transient read failure must not read as Free');
  app.kplus.__clearKPlusExpiryTimerForTests();
});

// ─── §21 — the repair must not have introduced a crash or a launch reset ─────

test('the actor-scoped storage layer still never throws and never resets on relaunch', async () => {
  const app = boot();
  const KEY = FREE_TIER_KEYS.styleBoards;

  app.signIn(USER_A);
  await app.freeTier.writeStore(KEY, { kept: true });

  // Three consecutive relaunches must not erode the data.
  let storage = app.storage;
  for (let launch = 0; launch < 3; launch += 1) {
    const relaunched = boot(storage);
    relaunched.signIn(USER_A);
    assert.deepEqual(
      await relaunched.freeTier.readStore(KEY, null),
      { kept: true },
      `data lost on relaunch ${launch + 1}`,
    );
    storage = relaunched.storage;
  }

  // And every hostile input resolves rather than rejecting.
  const hostile = boot();
  hostile.signIn(USER_A);
  await assert.doesNotReject(() => hostile.freeTier.readStore(KEY, null));
  await assert.doesNotReject(() => hostile.freeTier.writeStore(KEY, { x: 1 }));
  await assert.doesNotReject(() =>
    hostile.freeTier.updateStore(KEY, {}, () => {
      throw new Error('updater blew up');
    }),
  );
});

// ─── §28 — failure injection ─────────────────────────────────────────────────

test('FAULT: a storage read fault resolves to the fallback and exposes no other account', async () => {
  const app = boot();
  const KEY = FREE_TIER_KEYS.careNotes;

  app.signIn(USER_A);
  await app.freeTier.writeStore(KEY, { a: 1 });
  app.signIn(USER_B);
  await app.freeTier.writeStore(KEY, { b: 2 });

  app.signIn(USER_A);
  app.injectFaults({ getItem: true });
  const read = await app.freeTier.readStore(KEY, 'FALLBACK');
  assert.equal(read, 'FALLBACK', 'a read fault must resolve, not reject');
  assert.notDeepEqual(read, { b: 2 }, "a read fault must never surface another account's data");

  app.injectFaults({});
});

test('FAULT: a storage write fault reports false rather than throwing or corrupting a neighbour', async () => {
  const app = boot();
  const KEY = FREE_TIER_KEYS.collections;

  app.signIn(USER_B);
  await app.freeTier.writeStore(KEY, { b: 2 });

  app.signIn(USER_A);
  app.injectFaults({ setItem: true });
  assert.equal(await app.freeTier.writeStore(KEY, { a: 1 }), false);
  app.injectFaults({});

  app.signIn(USER_B);
  assert.deepEqual(
    await app.freeTier.readStore(KEY, null),
    { b: 2 },
    "another account's store was damaged by a failed write",
  );
});

test('FAULT: a listing fault still clears what can be named, and never rejects', async () => {
  const app = boot();
  app.signIn(USER_A);
  await app.freeTier.writeStore(FREE_TIER_KEYS.wishlistIntent, { a: 1 });
  app.storage.set(FREE_TIER_KEYS.wishlistIntent, envelope({ legacy: true }));

  app.injectFaults({ getAllKeys: true });
  await assert.doesNotReject(() => app.freeTier.clearAllFreeTierStores());
  app.injectFaults({});

  // The legacy keys are nameable without a listing, so those go; the namespaced
  // copy survives a listing fault, which is why the helper is best-effort.
  assert.ok(!app.storage.has(FREE_TIER_KEYS.wishlistIntent));
});

test('FAULT: a purge whose every step fails reports incomplete, so the marker is retried', async () => {
  const app = boot();
  const deps = {};
  for (const name of Object.keys(noopPurgeDeps())) {
    deps[name] = async () => { throw new Error('subsystem down'); };
  }

  const result = await app.purge.purgeOwnerScopedLocalData(USER_A, deps);
  assert.equal(result.complete, false, 'a total failure must never report complete');
  assert.ok(result.steps.length >= 17, 'every step must still be attempted');
  assert.ok(result.steps.every((step) => step.ok === false));
});
