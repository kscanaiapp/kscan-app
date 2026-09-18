/**
 * B34-FE-FT-001 — free-tier wardrobe data crossed accounts on a shared device.
 *
 * THE DEFECT. services/free-tier/freeTierStorage.ts kept every store at ONE
 * device-wide AsyncStorage key. `writeStore` stamped the envelope with a
 * `userId` "for future per-user isolation"; `readStore` never read it. The
 * module's own `clearAllFreeTierStores()` carried the comment "safe to call on
 * sign-out if wired later" and had ZERO call sites. So when one account signed
 * out and another signed in on the same handset, the arriving account read the
 * departing account's wishlist, saved outfits, collections, care notes, wear
 * log, brand sizing, outfit ratings and activity log — and deleting the account
 * did not remove any of it, because none of it is server state.
 *
 * NOT LATENT. EXPO_PUBLIC_FREE_TIER_UTILITY_ENABLED,
 * EXPO_PUBLIC_FREE_TIER_WISHLIST_INTENT_ENABLED and
 * EXPO_PUBLIC_FREE_TIER_OUTFIT_GENERATOR_ENABLED are all "true" on the
 * production EAS profile, and app/library.tsx, components/AnalysisCard.tsx and
 * components/scan-results/ScanResultV2.tsx mount those surfaces.
 *
 * WHAT IS ASSERTED HERE is the behaviour of the REAL module against a fake
 * AsyncStorage and a fake actor authority: what one actor can read of another's
 * data, what an upgrading user keeps, and what a signed-out reader can reach.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');

const USER_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

function createHarness() {
  const store = new Map();
  const asyncStorage = {
    async getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async setItem(key, value) {
      store.set(key, value);
    },
    async removeItem(key) {
      store.delete(key);
    },
    async multiRemove(keys) {
      for (const key of keys) store.delete(key);
    },
    async getAllKeys() {
      return [...store.keys()];
    },
  };

  let actorId = null;
  const actorScope = { currentActorId: () => actorId };

  const relativePath = 'services/free-tier/freeTierStorage.ts';
  const { outputText } = ts.transpileModule(
    fs.readFileSync(path.join(ROOT, relativePath), 'utf8'),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
      },
      fileName: relativePath,
    },
  );

  const module = { exports: {} };
  const requireFn = (id) => {
    // `__esModule` matters: without it TypeScript's esModuleInterop helper
    // wraps the mock a second time and `AsyncStorage.getItem` is undefined.
    if (id === '@react-native-async-storage/async-storage') {
      return { __esModule: true, default: asyncStorage };
    }
    if (id.endsWith('/actorScope')) return actorScope;
    if (id.endsWith('/wardrobeUtilityTypes')) {
      return {
        FREE_TIER_STORAGE_KEYS: {
          wishlistIntent: 'kscan.freeTier.wishlistIntent.v1',
          careNotes: 'kscan.freeTier.careNotes.v1',
        },
      };
    }
    return require(id);
  };

  // eslint-disable-next-line no-new-func
  Function('exports', 'require', 'module', '__filename', '__dirname', outputText)(
    module.exports,
    requireFn,
    module,
    path.join(ROOT, relativePath),
    path.dirname(path.join(ROOT, relativePath)),
  );

  return {
    api: module.exports,
    store,
    signIn(id) {
      actorId = id;
    },
    signOut() {
      actorId = null;
    },
  };
}

const WISHLIST = 'kscan.freeTier.wishlistIntent.v1';

function legacyEnvelope(data, userId) {
  return JSON.stringify({
    version: 1,
    userId,
    updatedAt: '2026-01-01T00:00:00.000Z',
    data,
  });
}

// ─── The reported defect ─────────────────────────────────────────────────────

test('a second account cannot read the first account\'s wishlist on the same device', async () => {
  const h = createHarness();

  h.signIn(USER_A);
  await h.api.writeStore(WISHLIST, { 'item-1': { intent: 'wishlist' } });
  assert.deepEqual(await h.api.readStore(WISHLIST, {}), { 'item-1': { intent: 'wishlist' } });

  h.signOut();
  h.signIn(USER_B);

  assert.deepEqual(
    await h.api.readStore(WISHLIST, {}),
    {},
    'User B must see an empty wishlist, not User A\'s',
  );
});

test('writing as the second account does not overwrite or expose the first account\'s copy', async () => {
  const h = createHarness();

  h.signIn(USER_A);
  await h.api.writeStore(WISHLIST, { a: 1 });

  h.signIn(USER_B);
  await h.api.writeStore(WISHLIST, { b: 2 });
  assert.deepEqual(await h.api.readStore(WISHLIST, {}), { b: 2 });

  h.signIn(USER_A);
  assert.deepEqual(await h.api.readStore(WISHLIST, {}), { a: 1 }, 'A keeps their own data');
});

test('an A -> B -> A switch returns A their data and never B\'s', async () => {
  const h = createHarness();

  h.signIn(USER_A);
  await h.api.writeStore(WISHLIST, { a: 1 });
  h.signIn(USER_B);
  await h.api.writeStore(WISHLIST, { b: 2 });
  h.signIn(USER_A);

  const read = await h.api.readStore(WISHLIST, {});
  assert.deepEqual(read, { a: 1 });
  assert.ok(!('b' in read));
});

// ─── Signed out ──────────────────────────────────────────────────────────────

test('a signed-out reader reaches no account\'s data and cannot adopt the legacy key', async () => {
  const h = createHarness();

  h.signIn(USER_A);
  await h.api.writeStore(WISHLIST, { a: 1 });
  h.store.set(WISHLIST, legacyEnvelope({ legacy: true }));

  h.signOut();
  assert.deepEqual(await h.api.readStore(WISHLIST, {}), {});
  assert.ok(h.store.has(WISHLIST), 'the legacy key survives a signed-out read for a real actor to adopt');
});

// ─── The upgrade path ────────────────────────────────────────────────────────

test('an upgrading user keeps their pre-namespace data exactly once', async () => {
  const h = createHarness();

  // Written by a build before this repair: no namespace, no stamp.
  h.store.set(WISHLIST, legacyEnvelope({ 'item-9': { intent: 'wishlist' } }));

  h.signIn(USER_A);
  assert.deepEqual(
    await h.api.readStore(WISHLIST, {}),
    { 'item-9': { intent: 'wishlist' } },
    'the upgrading user must not silently lose their wardrobe notes',
  );

  assert.ok(!h.store.has(WISHLIST), 'the legacy key is removed once adopted');

  // ...and the next account cannot adopt what no longer exists.
  h.signIn(USER_B);
  assert.deepEqual(await h.api.readStore(WISHLIST, {}), {});
});

test('adoption survives a failed re-read and is not repeated', async () => {
  const h = createHarness();
  h.store.set(WISHLIST, legacyEnvelope({ x: 1 }));

  h.signIn(USER_A);
  await h.api.readStore(WISHLIST, {});
  // A second read comes from the namespace, not from the (now absent) legacy key.
  assert.deepEqual(await h.api.readStore(WISHLIST, {}), { x: 1 });
});

test('a corrupt legacy blob is discarded rather than adopted or left readable', async () => {
  const h = createHarness();
  h.store.set(WISHLIST, 'not json at all');

  h.signIn(USER_A);
  assert.deepEqual(await h.api.readStore(WISHLIST, {}), {});
  assert.ok(!h.store.has(WISHLIST), 'a blob nobody can own must not stay readable');
});

// ─── Envelope stamp as a second, independent check ───────────────────────────

test('a blob stamped for another actor is refused even under this actor\'s key', async () => {
  const h = createHarness();
  const { __freeTierStorageInternals } = h.api;

  // Hand-plant B's stamped envelope under A's namespace.
  h.store.set(
    __freeTierStorageInternals.namespacedKey(WISHLIST, USER_A),
    legacyEnvelope({ b: 2 }, USER_B),
  );

  h.signIn(USER_A);
  assert.deepEqual(
    await h.api.readStore(WISHLIST, {}),
    {},
    'the envelope stamp must be verified, not just the namespace',
  );
});

test('every write stamps the owner so the second check has something to verify', async () => {
  const h = createHarness();
  const { __freeTierStorageInternals } = h.api;

  h.signIn(USER_A);
  await h.api.writeStore(WISHLIST, { a: 1 });

  const raw = h.store.get(__freeTierStorageInternals.namespacedKey(WISHLIST, USER_A));
  assert.equal(JSON.parse(raw).userId, USER_A);
});

// ─── updateStore and an explicit owner ───────────────────────────────────────

test('updateStore reads and writes the SAME namespace when given an explicit owner', async () => {
  const h = createHarness();

  h.signIn(USER_A);
  await h.api.writeStore(WISHLIST, { a: 1 }, USER_A);

  // A late sync response for A, applied while B is the live actor.
  h.signIn(USER_B);
  const next = await h.api.updateStore(
    WISHLIST,
    {},
    (current) => ({ ...current, synced: true }),
    USER_A,
  );

  assert.deepEqual(next, { a: 1, synced: true }, 'the explicit owner must read A\'s copy');

  h.signIn(USER_A);
  assert.deepEqual(await h.api.readStore(WISHLIST, {}), { a: 1, synced: true });

  h.signIn(USER_B);
  assert.deepEqual(await h.api.readStore(WISHLIST, {}), {}, 'B is untouched by A\'s sync');
});

// ─── The device wipe ─────────────────────────────────────────────────────────

test('clearAllFreeTierStores removes every actor namespace and the legacy key', async () => {
  const h = createHarness();

  h.signIn(USER_A);
  await h.api.writeStore(WISHLIST, { a: 1 });
  h.signIn(USER_B);
  await h.api.writeStore(WISHLIST, { b: 2 });
  h.store.set(WISHLIST, legacyEnvelope({ legacy: true }));
  h.store.set('unrelated.key', 'keep me');

  await h.api.clearAllFreeTierStores();

  const remaining = [...h.store.keys()];
  assert.deepEqual(remaining, ['unrelated.key'], 'only free-tier keys are removed');
});
