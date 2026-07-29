// Cold-start deep-link hydration.
//
// THE DEFECT THIS PINS
//
// A cold deep link into /stylist/dressing-room mounts the route before auth has
// resolved, so `hydrate` early-returns. When auth settles, `actorKey` changes
// from `device-local` to `user:<id>` and `hydrate` changes identity on the SAME
// commit. React runs effects in declaration order, so with the actor-transition
// effect declared AFTER `useFocusEffect(hydrate)` the sequence was:
//
//   hydrate:start                 generation = 2
//   actorTransition:invalidate    generation -> 3
//   lifecycle: abandoned          closetOk = true, nothing published
//
// The Closet loaded fine; its result was discarded by a stale-generation guard
// the hook had just invalidated itself, and nothing re-triggered hydrate because
// actorId, actorKey and actorLoading were all settled. The route hung on
// "Loading your Closet…" with no terminal state.
//
// This is NOT a Phase 3.5 regression: the pre-3.5 hook had the same declaration
// order and the same non-publishing abandon path.
//
// Two things are asserted: the production orchestration genuinely publishes
// nothing when it is abandoned (so an abandoned hydrate can never reach a
// terminal state), and the hook declares the actor-transition effect BEFORE the
// focus effect so it can never abandon its own in-flight read.
//
// `.test.js` so scripts/run-all-tests.js discovers it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ── In-memory filesystem, as used by the Phase 3 lifecycle suite ─────────────

const files = new Map();
const FileSystemMock = {
  documentDirectory: 'file:///doc/',
  EncodingType: { UTF8: 'utf8' },
  async makeDirectoryAsync() {},
  async writeAsStringAsync(uri, contents) { files.set(uri, contents); },
  async readAsStringAsync(uri) {
    if (!files.has(uri)) throw new Error(`ENOENT ${uri}`);
    return files.get(uri);
  },
  async getInfoAsync(uri) { return { exists: files.has(uri) }; },
  async deleteAsync(uri) { files.delete(uri); },
  async moveAsync({ from, to }) {
    if (!files.has(from)) throw new Error(`ENOENT ${from}`);
    files.set(to, files.get(from));
    files.delete(from);
  },
};

const MOCKS = {
  'expo-file-system/legacy': FileSystemMock,
  'expo-image-manipulator': { SaveFormat: { JPEG: 'jpeg' }, manipulateAsync: async () => ({ uri: '/c.jpg' }) },
  'react-native': { Platform: { OS: 'ios' } },
  'expo-crypto': { getRandomBytes: (n) => Uint8Array.from({ length: n }, (_, i) => (i * 19) % 256) },
};
const LIBRARY_STUB = {
  createMediaAssetId: () => 'asset_1',
  canonicalizeMediaPath: (uri) => (typeof uri === 'string' ? uri.toLowerCase() : null),
  unlinkUnreferencedMedia: async () => [],
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
    if (specifier === './library') return LIBRARY_STUB;
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
    mod.exports, mod, localRequire,
  );
  moduleCache.set(relPath, mod.exports);
  return mod.exports;
}

const actorContext = loadModule('services/actorContext.js');
const lifecycle = loadModule('services/privateDressingRoomLifecycle.ts');

const CLOSET_MANIFEST = 'file:///doc/kscan_closet/kscan_closet.json';

function closetRecord(id, subtype) {
  return {
    schemaVersion: 2, id, ownerId: 'user-a', title: id, subtype,
    category: null, clothingType: null, primaryColor: 'black', secondaryColors: [],
    material: [], imageUri: `file:///doc/kscan_closet/images/${id}.jpg`, thumbnailUri: null,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function reset() {
  files.clear();
  actorContext.__resetActorContextForTests();
  actorContext.advanceActorEpoch('user-a');
  files.set(CLOSET_MANIFEST, JSON.stringify([
    closetRecord('blazer', 'blazer'),
    closetRecord('shirt', 'shirt'),
    closetRecord('trousers', 'trousers'),
    closetRecord('loafers', 'loafers'),
  ]));
}

/**
 * The hook's freshness predicate, modelled exactly.
 *
 * `hydrate` claims a generation; anything that bumps the shared counter
 * afterwards makes that read permanently stale.
 */
function generationGuard() {
  const state = { counter: 0 };
  return {
    state,
    claim() {
      const mine = ++state.counter;
      return () => state.counter === mine;
    },
    invalidate() { state.counter += 1; },
  };
}

// ── The failure mode ─────────────────────────────────────────────────────────

test('COLD DEEP LINK: an abandoned hydration publishes nothing and has no terminal state', async () => {
  reset();
  const guard = generationGuard();
  const published = { closet: [], session: [], composition: [], interaction: [] };

  // hydrate claims its generation...
  const isCurrent = guard.claim();
  // ...and the actor-transition effect then bumps past it on the same commit.
  guard.invalidate();

  const result = await lifecycle.hydratePrivateDressingRoom({
    actorId: 'user-a',
    actorRequest: actorContext.createActorRequest(),
    interactionsEnabled: true,
    isCurrent,
    publish: {
      closet: (s) => published.closet.push(s),
      session: (s) => published.session.push(s),
      composition: (s) => published.composition.push(s),
      interaction: (s) => published.interaction.push(s),
    },
  });

  assert.equal(result.abandoned, true, 'the read is abandoned');
  // THE HANG: nothing is published, so a caller sitting on `status: loading`
  // never receives a terminal state.
  assert.equal(published.closet.length, 0, 'no Closet snapshot published');
  assert.equal(published.session.length, 0);
  assert.equal(published.composition.length, 0);
  assert.equal(published.interaction.length, 0);
});

// ── The repaired ordering ────────────────────────────────────────────────────

test('COLD DEEP LINK: invalidating BEFORE hydration lets the load reach a terminal state', async () => {
  reset();
  const guard = generationGuard();
  const published = { closet: [], session: [] };

  // Repaired order: the actor transition invalidates first...
  guard.invalidate();
  // ...then hydrate claims a generation nothing has bumped past.
  const isCurrent = guard.claim();

  const result = await lifecycle.hydratePrivateDressingRoom({
    actorId: 'user-a',
    actorRequest: actorContext.createActorRequest(),
    interactionsEnabled: true,
    isCurrent,
    publish: {
      closet: (s) => published.closet.push(s),
      session: (s) => published.session.push(s),
    },
  });

  assert.equal(result.abandoned, false, 'the read completes');
  assert.equal(published.closet.length, 1, 'exactly one Closet snapshot published');
  assert.equal(published.closet[0].status, 'loaded', 'and it is TERMINAL, not loading');
  assert.equal(published.closet[0].ok, true);
  assert.equal(published.closet[0].items.length, 4);
  // No session exists yet on a cold deep link, which is a stable resting state.
  assert.equal(result.session?.ok, true);
  assert.equal(result.composition.status, 'idle');
});

test('a late actor resolution still reaches a terminal state, without a second load', async () => {
  reset();
  const guard = generationGuard();
  let closetReads = 0;
  const originalRead = FileSystemMock.readAsStringAsync;
  FileSystemMock.readAsStringAsync = async (uri) => {
    if (uri === CLOSET_MANIFEST) closetReads += 1;
    return originalRead(uri);
  };
  try {
    // Mount with no actor: the hook early-returns, so nothing is claimed and
    // nothing is read.
    assert.equal(closetReads, 0, 'no Closet read before the actor resolves');

    // Auth resolves: invalidate (actor transition) then hydrate, once.
    guard.invalidate();
    const isCurrent = guard.claim();
    const published = [];
    const result = await lifecycle.hydratePrivateDressingRoom({
      actorId: 'user-a',
      actorRequest: actorContext.createActorRequest(),
      interactionsEnabled: true,
      isCurrent,
      publish: { closet: (s) => published.push(s) },
    });

    assert.equal(result.abandoned, false);
    assert.equal(published.length, 1, 'a single terminal publish');
    assert.equal(published[0].status, 'loaded');
    assert.equal(closetReads, 1, 'exactly one Closet load - no duplicate');
  } finally {
    FileSystemMock.readAsStringAsync = originalRead;
  }
});

test('a genuine actor change still cancels the previous actor read', async () => {
  reset();
  const guard = generationGuard();
  const claimed = guard.claim();
  const request = actorContext.createActorRequest();
  // The hook's predicate is generation AND actor epoch; the epoch is what makes
  // a same-id sign-out/sign-in cycle rejectable, so both halves are modelled.
  const isCurrent = () => claimed() && actorContext.isActorRequestCurrent(request);
  // A real actor switch advances the epoch.
  actorContext.advanceActorEpoch('user-b');

  const published = [];
  const result = await lifecycle.hydratePrivateDressingRoom({
    actorId: 'user-a',
    actorRequest: request,
    interactionsEnabled: true,
    isCurrent,
    publish: { closet: (s) => published.push(s) },
  });

  assert.equal(result.abandoned, true, 'the superseded actor read is dropped');
  assert.equal(published.length, 0, "and never reaches the new actor's screen");
});

// ── The ordering contract in the hook ────────────────────────────────────────

test('HOOK: the actor-transition effect is declared BEFORE the focus effect', () => {
  const hook = read('hooks/usePrivateDressingRoom.ts');
  const actorEffect = hook.indexOf('An actor transition invalidates every snapshot');
  const focusEffect = hook.indexOf('\n  useFocusEffect(hydrate);');
  assert.ok(actorEffect > -1, 'missing the actor-transition effect');
  assert.ok(focusEffect > -1, 'missing the focus effect');
  assert.ok(
    actorEffect < focusEffect,
    'React runs effects in declaration order: invalidation must precede hydration, ' +
      'or a cold deep link abandons its own in-flight Closet read and hangs',
  );
});

test('HOOK: the ordering requirement is documented where it can be broken', () => {
  const hook = read('hooks/usePrivateDressingRoom.ts');
  const block = hook.slice(
    hook.indexOf('An actor transition invalidates every snapshot'),
    hook.indexOf('\n  useFocusEffect(hydrate);'),
  );
  assert.match(block, /DECLARED BEFORE `useFocusEffect\(hydrate\)`/);
  assert.match(block, /order is load-bearing/i);
});

test('HOOK: hydrate still early-returns while the actor is unresolved', () => {
  const hook = read('hooks/usePrivateDressingRoom.ts');
  const body = hook.slice(hook.indexOf('const hydrate = useCallback'), hook.indexOf('\n  useFocusEffect(hydrate);'));
  assert.match(body, /if \(!PRIVATE_DRESSING_ROOM_V1 \|\| actorLoading\) return undefined;/);
  // And the identity change when it resolves is what re-runs the focus effect.
  assert.match(body, /\}, \[actorId, actorKey, actorLoading\]\);/);
});

test('HOOK: no deep-link-only Closet loader was introduced', () => {
  const hook = read('hooks/usePrivateDressingRoom.ts');
  for (const forbidden of ['setTimeout', 'setInterval', 'retryCount', 'deepLink']) {
    assert.equal(hook.includes(forbidden), false, `the repair must not introduce ${forbidden}`);
  }
});
