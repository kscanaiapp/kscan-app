// B34-FE-FT-001 — the Free Tier utility stores must not cross accounts.
//
// WHY THIS FILE EXISTS. Every other user-scoped local store in this app is
// partitioned by the services/actorContext authority: services/library.js, the
// Closet, and every private Dressing Room store derive ownership from a
// captured actor request and refuse to hand one actor another's records. The
// Free Tier utility stores were the exception. Their keys were flat
// (`kscan.freeTier.wishlistIntent.v1` and eleven siblings), the envelope's
// `userId` field was written but NEVER COMPARED on read, and
// `clearAllFreeTierStores` -- whose own comment said "safe to call on sign-out
// if wired later" -- had zero callers in the repository.
//
// So on one installation: User A records shopping intent (which stores the
// product title), care notes, a wear log, outfit feedback and an activity log;
// User A signs out; User B signs in; every one of those stores is still there
// and is loaded into User B's session by useWardrobeUtility on the Closet and
// on every scan result. It also survived an account deletion, which this app
// otherwise treats as a primary release gate.
//
// The repair is structural, not lifecycle-driven, and that is the point: a
// boundary that fired on sign-out would be missed by a force-quit, a crash, a
// reinstall or a terminal session expiry. Partitioned keys cannot be missed.
//
// `.test.js`, not `.test.ts`: scripts/run-all-tests.js discovers on that literal
// suffix, so a `.test.ts` file would never run in certification.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/** An in-memory AsyncStorage double that records the PHYSICAL keys written. */
function createMemoryStorage() {
  const map = new Map();
  return {
    map,
    getItem: async (key) => (map.has(key) ? map.get(key) : null),
    setItem: async (key, value) => {
      map.set(key, value);
    },
    removeItem: async (key) => {
      map.delete(key);
    },
    multiRemove: async (keys) => {
      for (const key of keys) map.delete(key);
    },
  };
}

/** Loads freeTierStorage.ts against a fake AsyncStorage and a settable actor. */
function loadStorage() {
  const storage = createMemoryStorage();
  const actor = { actorId: null, epoch: 0 };
  const filename = path.join(ROOT, 'services/free-tier/freeTierStorage.ts');
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const mod = { exports: {} };
  const sandbox = {
    console,
    Date,
    JSON,
    Promise,
    Object,
    exports: mod.exports,
    module: mod,
    require: (specifier) => {
      if (specifier === '@react-native-async-storage/async-storage') {
        return { __esModule: true, default: storage };
      }
      if (specifier === '../actorContext') {
        return { getActorContext: () => ({ ...actor }) };
      }
      if (specifier === './wardrobeUtilityTypes') {
        return require(path.join(ROOT, '__tests__/fixtures/freeTierStorageKeys.js'));
      }
      throw new Error(`Unexpected import in freeTierStorage.ts: ${specifier}`);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename }).runInContext(sandbox);
  return { api: mod.exports, storage, actor };
}

const KEYS = require('./fixtures/freeTierStorageKeys.js').FREE_TIER_STORAGE_KEYS;
const WISHLIST = KEYS.wishlistIntent;

// ── The boundary itself ─────────────────────────────────────────────────────

test('THE DEFECT: User B cannot read what User A wrote on the same installation', async () => {
  const { api, actor } = loadStorage();

  actor.actorId = 'user-a';
  actor.epoch = 1;
  await api.writeStore(WISHLIST, { 'item-1': { intent: 'wishlist', titleSnapshot: 'Gucci loafers' } });
  assert.deepEqual(
    await api.readStore(WISHLIST, {}),
    { 'item-1': { intent: 'wishlist', titleSnapshot: 'Gucci loafers' } },
    'the writing actor must still read their own data',
  );

  // Sign out, then a different account signs in on the same device.
  actor.actorId = null;
  actor.epoch = 2;
  assert.deepEqual(await api.readStore(WISHLIST, {}), {}, 'the signed-out projection must not see it');

  actor.actorId = 'user-b';
  actor.epoch = 3;
  assert.deepEqual(await api.readStore(WISHLIST, {}), {}, 'the arriving actor must not inherit it');
});

test('A -> B -> A returns the first actor to their own data, and B never sees it', async () => {
  const { api, actor } = loadStorage();

  actor.actorId = 'user-a';
  await api.writeStore(WISHLIST, { a: 1 });
  actor.actorId = 'user-b';
  await api.writeStore(WISHLIST, { b: 2 });

  assert.deepEqual(await api.readStore(WISHLIST, {}), { b: 2 });
  actor.actorId = 'user-a';
  assert.deepEqual(await api.readStore(WISHLIST, {}), { a: 1 }, "B's write must not have clobbered A's partition");
});

test('the partitions are distinct PHYSICAL keys, not a filter over one key', async () => {
  const { api, storage, actor } = loadStorage();

  actor.actorId = null;
  await api.writeStore(WISHLIST, { device: true });
  actor.actorId = 'user-a';
  await api.writeStore(WISHLIST, { a: true });

  const keys = [...storage.map.keys()].sort();
  assert.deepEqual(keys, [WISHLIST, `${WISHLIST}::u:user-a`]);
});

test('pre-partition data becomes the signed-out partition and is never claimed by whoever signs in', async () => {
  // The Style Library rule, verbatim: an envelope with no owner does not say
  // who wrote it, so an authenticated actor may neither see nor claim it.
  const { api, storage, actor } = loadStorage();

  storage.map.set(
    WISHLIST,
    JSON.stringify({ version: 1, updatedAt: '2026-01-01T00:00:00.000Z', data: { legacy: true } }),
  );

  actor.actorId = 'user-a';
  assert.deepEqual(await api.readStore(WISHLIST, {}), {}, 'legacy data must not surface for an authenticated actor');
  assert.ok(storage.map.has(WISHLIST), 'and it must NOT be destroyed — only withheld');

  actor.actorId = null;
  assert.deepEqual(await api.readStore(WISHLIST, {}), { legacy: true });
});

// ── The partition cannot be overridden by a call site ───────────────────────

test('a caller-supplied userId cannot move data out of its partition', async () => {
  const { api, storage, actor } = loadStorage();

  actor.actorId = 'user-a';
  // freeTierSupabaseSync passes the id it synced for; a wrong one must be inert.
  await api.writeStore(WISHLIST, { a: 1 }, 'user-b');

  assert.ok(storage.map.has(`${WISHLIST}::u:user-a`), 'the live actor decides the partition');
  assert.ok(!storage.map.has(`${WISHLIST}::u:user-b`), 'the argument must not be able to name a partition');

  actor.actorId = 'user-b';
  assert.deepEqual(await api.readStore(WISHLIST, {}), {});
});

test('updateStore read-modify-writes inside one partition only', async () => {
  const { api, actor } = loadStorage();

  actor.actorId = 'user-a';
  await api.updateStore(WISHLIST, {}, (current) => ({ ...current, a: 1 }));
  actor.actorId = 'user-b';
  const next = await api.updateStore(WISHLIST, {}, (current) => ({ ...current, b: 2 }));

  assert.deepEqual(next, { b: 2 }, "B's update must start from B's empty partition, not A's data");
  actor.actorId = 'user-a';
  assert.deepEqual(await api.readStore(WISHLIST, {}), { a: 1 });
});

// ── Fail-closed behaviour ───────────────────────────────────────────────────

test('an actor authority that throws resolves to the ownerless partition, never to "any actor"', async () => {
  const filename = path.join(ROOT, 'services/free-tier/freeTierStorage.ts');
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const storage = createMemoryStorage();
  const mod = { exports: {} };
  const sandbox = {
    console, Date, JSON, Promise, Object,
    exports: mod.exports,
    module: mod,
    require: (specifier) => {
      if (specifier === '@react-native-async-storage/async-storage') return { __esModule: true, default: storage };
      if (specifier === '../actorContext') {
        return { getActorContext: () => { throw new Error('actor authority unavailable'); } };
      }
      if (specifier === './wardrobeUtilityTypes') return require(path.join(ROOT, '__tests__/fixtures/freeTierStorageKeys.js'));
      throw new Error(`Unexpected import: ${specifier}`);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename }).runInContext(sandbox);

  await mod.exports.writeStore(WISHLIST, { x: 1 });
  assert.deepEqual([...storage.map.keys()], [WISHLIST], 'the ownerless partition is the fail-closed direction');
});

test('clearAllFreeTierStores erases ONE actor and never reaches another', async () => {
  const { api, storage, actor } = loadStorage();

  actor.actorId = 'user-a';
  await api.writeStore(WISHLIST, { a: 1 });
  await api.writeStore(KEYS.careNotes, { a: 1 });
  actor.actorId = 'user-b';
  await api.writeStore(WISHLIST, { b: 2 });

  actor.actorId = 'user-a';
  await api.clearAllFreeTierStores();

  assert.ok(!storage.map.has(`${WISHLIST}::u:user-a`));
  assert.ok(!storage.map.has(`${KEYS.careNotes}::u:user-a`));
  assert.ok(storage.map.has(`${WISHLIST}::u:user-b`), "another actor's partition must survive");
});

test('every declared store key is swept, not just the ones a test remembered', async () => {
  const { api, storage, actor } = loadStorage();
  actor.actorId = 'user-a';
  for (const key of Object.values(KEYS)) {
    await api.writeStore(key, { seeded: true });
  }
  assert.equal(storage.map.size, Object.keys(KEYS).length);
  await api.clearAllFreeTierStores();
  assert.equal(storage.map.size, 0, 'a key added to FREE_TIER_STORAGE_KEYS is swept the day it is added');
});

// ── Source guards on the rule ──────────────────────────────────────────────

test('the fixture key map has not drifted from the real one', () => {
  // The VM sandbox cannot load the TypeScript module, so the keys are mirrored
  // in a fixture. Without this, a key added to the real map would silently stop
  // being covered by the sweep test above.
  const source = read('services/free-tier/wardrobeUtilityTypes.ts');
  const block = source.slice(
    source.indexOf('FREE_TIER_STORAGE_KEYS'),
    source.indexOf('}', source.indexOf('FREE_TIER_STORAGE_KEYS')),
  );
  const real = {};
  for (const [, name, value] of block.matchAll(/(\w+):\s*'([^']+)'/g)) real[name] = value;
  assert.ok(Object.keys(real).length > 0, 'the real key map must be parseable');
  assert.deepEqual(real, KEYS, '__tests__/fixtures/freeTierStorageKeys.js is out of date');
});


test('no free-tier module builds a storage key itself', () => {
  const dir = path.join(ROOT, 'services/free-tier');
  for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
    if (name === 'freeTierStorage.ts' || name === 'wardrobeUtilityTypes.ts') continue;
    const code = stripComments(read(path.join('services/free-tier', name)));
    assert.doesNotMatch(
      code,
      /AsyncStorage/,
      `${name} must go through freeTierStorage, which owns the partition`,
    );
  }
});

test('NEGATIVE CONTROL: the isolation assertions bite against a flat-key implementation', async () => {
  // Reproduces the pre-repair shape and proves the first test above would fail.
  const storage = createMemoryStorage();
  const flatWrite = async (key, data) => storage.setItem(key, JSON.stringify({ version: 1, data }));
  const flatRead = async (key, fallback) => {
    const raw = await storage.getItem(key);
    return raw ? JSON.parse(raw).data : fallback;
  };
  await flatWrite(WISHLIST, { 'item-1': 'Gucci loafers' });
  const leaked = await flatRead(WISHLIST, {});
  assert.throws(() => assert.deepEqual(leaked, {}), 'the flat-key shape must fail the isolation assertion');
});
