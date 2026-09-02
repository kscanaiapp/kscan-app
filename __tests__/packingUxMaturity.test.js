'use strict';

// K+ Packing Intelligence — UX maturity certification.
//
// The offline cache and the checklist are the two additions that can actually
// hurt someone: one writes a durable record of a person's wardrobe and travel
// to the device, the other is a control sitting on top of ownership state.
// Both are exercised here as REAL MODULES through the repo's transpile harness
// with a stubbed AsyncStorage, so these prove behaviour rather than asserting
// that the source contains a reassuring string.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const REPO_ROOT = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8');

function loadPackingTsModule(relativePath, requireMap = {}) {
  const filename = path.join(REPO_ROOT, relativePath);
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const mod = { exports: {} };
  const sandbox = {
    __DEV__: false,
    console,
    Date,
    JSON,
    Set,
    Map,
    Array,
    Object,
    Number,
    String,
    Boolean,
    Promise,
    exports: mod.exports,
    module: mod,
    require: (specifier) => {
      if (specifier in requireMap) return requireMap[specifier];
      throw new Error(`Unexpected import in ${relativePath}: ${specifier}`);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename }).runInContext(sandbox);
  return mod.exports;
}

/** A minimal in-memory AsyncStorage with the surface the cache actually uses. */
function memoryAsyncStorage(seed = {}) {
  const data = new Map(Object.entries(seed));
  return {
    store: data,
    // __esModule matters: without it TypeScript's __importDefault helper wraps
    // this object again, `AsyncStorage.setItem` is undefined, every write is
    // swallowed by the cache's own try/catch, and the tests pass VACUOUSLY
    // against a cache that never stored anything.
    __esModule: true,
    default: {
      getItem: async (k) => (data.has(k) ? data.get(k) : null),
      setItem: async (k, v) => void data.set(k, v),
      removeItem: async (k) => void data.delete(k),
      getAllKeys: async () => [...data.keys()],
      multiRemove: async (keys) => keys.forEach((k) => data.delete(k)),
    },
  };
}

const loadCache = (storage) =>
  loadPackingTsModule('services/packing/packingPlanCache.ts', {
    '@react-native-async-storage/async-storage': storage,
    '../../types/packing': {},
  });

const loadStore = (storage) =>
  loadPackingTsModule('services/packing/packingPlanStore.ts', {
    '../../types/packing': {},
    './packingPlanCache': loadCache(storage),
  });

const ACTOR_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACTOR_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/**
 * Modules under test run in a vm context, so arrays they create do not share a
 * prototype with this realm and deepStrictEqual refuses them. Copy into a host
 * array before comparing -- the VALUES are what these tests are about.
 */
const arr = (value) => [...value];

/**
 * Strip comments before asserting. These checks are about what the code DOES;
 * the files legitimately discuss the failures they prevent in prose, and a
 * counter-example in a comment is not a claim the UI makes.
 */
const codeOf = (relative) =>
  read(relative)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

function fakePlan(overrides = {}) {
  return {
    planId: 'plan-1',
    packedItems: [
      { itemId: 'item-1', title: 'Rain Jacket', layeringRole: 'outer' },
      { itemId: 'item-2', title: 'Dark Jeans', layeringRole: 'bottom' },
    ],
    outfits: [{ outfitId: 'o1', itemIds: ['item-1', 'item-2'] }],
    constraints: { excludedItemIds: [], packLight: false, notes: [] },
    ...overrides,
  };
}

// ── UX-4 offline cache: actor isolation and honesty ──────────────────────────

test('UX-4 cache: a plan is stored under a key naming the actor it belongs to', async () => {
  const storage = memoryAsyncStorage();
  const cache = loadCache(storage);
  await cache.writeCachedPackingPlan({ actorId: ACTOR_A, plan: fakePlan(), message: 'hi' });
  const keys = [...storage.store.keys()];
  assert.equal(keys.length, 1);
  assert.ok(keys[0].includes(ACTOR_A), `key must scope by actor, got ${keys[0]}`);
});

test('UX-4 cache: actor B can never read actor A cached plan', async () => {
  const storage = memoryAsyncStorage();
  const cache = loadCache(storage);
  await cache.writeCachedPackingPlan({ actorId: ACTOR_A, plan: fakePlan(), message: 'hi' });
  // The key is unaddressable for B, so isolation does not depend on the delete
  // having run -- which matters because clearing is async and an app can be
  // killed mid-clear.
  assert.equal(await cache.readCachedPackingPlan(ACTOR_B), null);
  assert.notEqual(await cache.readCachedPackingPlan(ACTOR_A), null);
});

test('UX-4 cache: a record whose stored actor was tampered with is refused', async () => {
  // Belt and braces over the key, exactly as retrieval re-checks user_id over RLS.
  const storage = memoryAsyncStorage();
  const cache = loadCache(storage);
  await cache.writeCachedPackingPlan({ actorId: ACTOR_A, plan: fakePlan(), message: 'hi' });
  const key = [...storage.store.keys()][0];
  const tampered = JSON.parse(storage.store.get(key));
  tampered.actorId = ACTOR_B;
  storage.store.set(key, JSON.stringify(tampered));
  assert.equal(await cache.readCachedPackingPlan(ACTOR_A), null);
});

test('UX-4 cache: an actor reset sweeps every cached plan, and nothing else', async () => {
  const storage = memoryAsyncStorage({ 'unrelated/key': 'keep me' });
  const cache = loadCache(storage);
  await cache.writeCachedPackingPlan({ actorId: ACTOR_A, plan: fakePlan(), message: null });
  await cache.writeCachedPackingPlan({ actorId: ACTOR_B, plan: fakePlan(), message: null });
  await cache.clearAllCachedPackingPlans();
  assert.equal(await cache.readCachedPackingPlan(ACTOR_A), null);
  assert.equal(await cache.readCachedPackingPlan(ACTOR_B), null);
  assert.equal(storage.store.get('unrelated/key'), 'keep me', 'not a device-wide wipe');
});

test('UX-4 cache: a stale plan expires rather than being shown as current', async () => {
  const storage = memoryAsyncStorage();
  const cache = loadCache(storage);
  await cache.writeCachedPackingPlan({
    actorId: ACTOR_A,
    plan: fakePlan(),
    message: null,
    now: () => 1000,
  });
  const muchLater = () => 1000 + 31 * 24 * 60 * 60 * 1000;
  assert.equal(await cache.readCachedPackingPlan(ACTOR_A, muchLater), null);
});

test('UX-4 cache: ticking a box does not make the plan look newly generated', async () => {
  const storage = memoryAsyncStorage();
  const cache = loadCache(storage);
  // A realistic epoch: the freshness window is real, so a 1970 timestamp would
  // legitimately expire before the tick could be recorded.
  const generatedAt = Date.now();
  await cache.writeCachedPackingPlan({
    actorId: ACTOR_A,
    plan: fakePlan(),
    message: null,
    now: () => generatedAt,
  });
  const anHourLater = () => generatedAt + 3600_000;
  await cache.writeCachedPackedOff(ACTOR_A, ['item-1'], anHourLater);
  const restored = await cache.readCachedPackingPlan(ACTOR_A, anHourLater);
  assert.deepEqual(arr(restored.packedOff), ['item-1']);
  assert.equal(
    restored.cachedAt,
    generatedAt,
    'generation time must not move when a box is ticked',
  );
});

// ── UX-2 checklist: a control on top of ownership, not a mutation of it ──────

test('UX-2 checklist: only an item the CURRENT plan packs can be ticked', () => {
  const store = loadStore(memoryAsyncStorage());
  store.applyPackingPlan({ actorId: ACTOR_A, plan: fakePlan(), message: 'ok' });
  assert.deepEqual(arr(store.togglePackedOff(ACTOR_A, 'item-1')), ['item-1']);
  // A forged or stale id cannot accumulate in the ticked set.
  assert.deepEqual(arr(store.togglePackedOff(ACTOR_A, 'not-in-this-plan')), ['item-1']);
  assert.deepEqual(arr(store.togglePackedOff(ACTOR_A, 'item-1')), []);
});

test('UX-2 checklist: a regenerated plan starts with an empty checklist', () => {
  const store = loadStore(memoryAsyncStorage());
  store.applyPackingPlan({ actorId: ACTOR_A, plan: fakePlan(), message: 'ok' });
  store.togglePackedOff(ACTOR_A, 'item-1');
  // Ticks belonged to the plan they were made against; a regeneration is a
  // different plan with different items.
  store.applyPackingPlan({ actorId: ACTOR_A, plan: fakePlan({ planId: 'plan-2' }), message: 'ok' });
  assert.deepEqual(arr(store.getPackingSnapshotFor(ACTOR_A).packedOff), []);
  assert.equal(store.getPackingSnapshotFor(ACTOR_A).restoredFrom, null);
});

test('UX-2 checklist: ticks never survive an actor boundary', () => {
  const store = loadStore(memoryAsyncStorage());
  store.applyPackingPlan({ actorId: ACTOR_A, plan: fakePlan(), message: 'ok' });
  store.togglePackedOff(ACTOR_A, 'item-1');
  store.resetPackingPlanState();
  assert.deepEqual(arr(store.getPackingSnapshotFor(ACTOR_A).packedOff), []);
  assert.equal(store.getPackingSnapshotFor(ACTOR_A).plan, null);
});

test('UX-2 checklist: a tick reaches no server, no Closet and no network', () => {
  // The store module is loaded with ONLY the cache and the type module
  // resolvable. Had togglePackedOff reached supabase, the Closet library or any
  // network module, loadStore would have thrown on the unexpected import -- so
  // the tests above passing is itself part of this proof.
  // Comments are stripped first: this is a claim about what the module DOES,
  // and the header legitimately discusses user_closet_items in prose.
  const storeCode = read('services/packing/packingPlanStore.ts')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(storeCode, /supabase|user_closet_items|functions\.invoke|fetch\(/i);
  const hookSource = read('hooks/usePackingPlan.ts');
  const from = hookSource.indexOf('const toggleItemPacked');
  const body = hookSource.slice(from, hookSource.indexOf('const generate', from));
  assert.match(body, /togglePackedOff\(actorId, itemId\)/);
  assert.match(body, /writeCachedPackedOff\(actorId, next\)/);
  // No regeneration and no request on a tick.
  assert.doesNotMatch(body, /requestPackingPlan|refineWith|removeItem/);
});

// ── UX-4 restore: fills an empty screen, never competes for a live one ───────

test('UX-4 restore: a cached plan never overwrites a live or in-flight one', () => {
  const store = loadStore(memoryAsyncStorage());
  // In flight: a slow disk read must not replace a newer result.
  store.beginPackingRequest({ actorId: ACTOR_A, sessionId: 's1', trip: { destination: 'Paris' } });
  assert.equal(
    store.restoreCachedPackingPlan({
      actorId: ACTOR_A, plan: fakePlan(), message: null, cachedAt: 1, packedOff: [],
    }),
    false,
  );
  // Already showing a live plan: likewise refused.
  store.applyPackingPlan({ actorId: ACTOR_A, plan: fakePlan({ planId: 'live' }), message: 'ok' });
  assert.equal(
    store.restoreCachedPackingPlan({
      actorId: ACTOR_A, plan: fakePlan({ planId: 'stale' }), message: null, cachedAt: 1, packedOff: [],
    }),
    false,
  );
  assert.equal(store.getPackingSnapshotFor(ACTOR_A).plan.planId, 'live');
});

test('UX-4 restore: an empty screen is filled, and marked as restored', () => {
  const store = loadStore(memoryAsyncStorage());
  assert.equal(
    store.restoreCachedPackingPlan({
      actorId: ACTOR_A, plan: fakePlan(), message: 'from cache', cachedAt: 4242, packedOff: ['item-2'],
    }),
    true,
  );
  const snapshot = store.getPackingSnapshotFor(ACTOR_A);
  assert.equal(snapshot.status, 'ready');
  // Provenance is carried so the screen can say so plainly rather than
  // presenting a stored plan as a fresh one.
  assert.equal(snapshot.restoredFrom, 4242);
  assert.deepEqual(arr(snapshot.packedOff), ['item-2']);
});

// ── UX-1 progress indicator: honest about what it cannot observe ─────────────

test('UX-1 stages: the sequence matches the real server order', () => {
  const screen = read('app/packing/index.tsx');
  const closet = screen.indexOf('Reviewing your Closet');
  const weather = screen.indexOf('Checking the forecast for');
  const looks = screen.indexOf('Building your looks');
  const gate = screen.indexOf('Checking every piece is yours');
  assert.ok(closet > 0, 'the Closet stage must exist');
  // packingHandler.ts reads the Closet BEFORE resolving weather. Showing a
  // weather step first would be a tidier story and a false one.
  assert.ok(weather > closet, 'the Closet read precedes weather, as the server does');
  assert.ok(looks > weather, 'reasoning follows weather');
  assert.ok(gate > looks, 'the ownership gate is last');
});

test('UX-1 stages: no stage announces an outcome the client cannot observe', () => {
  const screen = codeOf('app/packing/index.tsx');
  // The server resolves weather internally and reports provenance only in the
  // finished plan, so the client can never truthfully say it was found. Every
  // label is an attempt in progress.
  assert.doesNotMatch(screen, /Found your forecast|Weather found|Forecast ready|Plan ready|All done/i);
  // No numeric progress surface: a percentage is a claim about internals.
  assert.doesNotMatch(screen, /ProgressBar|progress=\{|progressPercent|\$\{[^}]*\}%/);
});

test('UX-1 stages: the final stage holds and cannot complete on a timer', () => {
  const screen = read('app/packing/index.tsx');
  assert.match(screen, /ms: Number\.POSITIVE_INFINITY/);
  assert.match(screen, /if \(!stage \|\| !Number\.isFinite\(stage\.ms\)\) return;/);
});

test('UX-1 stages: the indicator is announced to assistive technology', () => {
  const screen = read('app/packing/index.tsx');
  assert.match(screen, /accessibilityRole="progressbar"/);
  assert.match(screen, /accessibilityLiveRegion="polite"/);
});

// ── UX-3 provenance badges: evidence, not decoration ────────────────────────

test('UX-3 badges: owned styling is server-driven and gaps can never receive it', () => {
  const view = read('components/packing/PackingPlanView.tsx');
  assert.match(view, /IN YOUR CLOSET/);
  // The gap section keeps its unowned treatment: no checkbox, no owned badge,
  // no photograph, nothing to tap. A thing the traveller does not have must
  // never be able to read as a thing they do.
  // Anchor on the SECTION HEADER, not the summary-stat label of the same name,
  // which appears earlier and would swallow the whole checklist.
  const gapStart = view.indexOf('<SectionHeader title="POSSIBLE GAPS" />');
  const gapBlock = view.slice(gapStart, view.indexOf('<SectionHeader title="ASSUMPTIONS" />'));
  assert.ok(gapStart > 0 && gapBlock.length > 0, 'the gap section must still exist');
  assert.doesNotMatch(gapBlock, /IN YOUR CLOSET|checkBox|PackingChecklistRow|resolveImage/);
  // Scarcity stays the server-derived signal, never a model claim.
  assert.match(view, /item\.scarcitySignal/);
});

test('UX-3 badges: Packing still routes no commerce of any kind', () => {
  // Packing V1 helps someone pack; it does not sell. A "Find Similar" CTA on a
  // gap would be a NEW commerce integration binding a generic requirement label
  // to a product search, which is exactly the gap/product mis-binding risk the
  // gap engine is shaped to avoid. Recorded as an owner decision, not shipped.
  const view = read('components/packing/PackingPlanView.tsx');
  assert.doesNotMatch(view, /Find Similar|Shop |Buy now|addToCart|openProduct/i);
  const client = read('services/packing/packingClient.ts');
  // The wire parser still drops anything commerce-shaped rather than showing it.
  assert.match(client, /raw\.price != null \|\| raw\.url != null \|\| raw\.productId != null/);
});

test('UX-2 checklist: the row is memoized so one tick does not re-render the list', () => {
  const view = read('components/packing/PackingPlanView.tsx');
  assert.match(view, /const PackingChecklistRow = React\.memo\(/);
  assert.match(view, /prev\.checked === next\.checked/);
  // A minimum touch target, because this is used one-handed over a suitcase.
  assert.match(view, /minHeight: 56/);
});
