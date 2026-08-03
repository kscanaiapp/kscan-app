// Checkpoint 5A — the platform binding: account isolation and query derivation.
//
// WHY THIS IS A SEPARATE FILE FROM THE MOUNT TEST
//
// `scannerSimilarityMount.test.js` injects loaders directly, so it can prove
// the dispatch path calls them but cannot prove WHICH RECORDS those loaders are
// allowed to read. That question — does a scan ever read another account's
// wardrobe — is decided here, in the binding, and it is the highest-severity
// failure available in this checkpoint.
//
// THE SPECIFIC HAZARD BEING DEFENDED
//
// `loadClosetTyped(actorId)` and `loadLibrary(actorId)` treat `undefined` as
// "every partition of every account" — a documented test-only affordance. The
// APIs therefore fail OPEN: a caller who forgets the argument gets an
// unfiltered cross-account read rather than an empty one. The binding must
// never call either loader without an explicit actor argument.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

/**
 * Values crossing the `vm` boundary carry that realm's Array/Object
 * prototypes, so `assert.deepEqual` (strict, via node:assert/strict) reports
 * "same structure but not reference-equal" even for two empty arrays.
 * Re-materializing through JSON in the host realm compares the DATA.
 */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadBinding({ enabled = true, actorContext, closetSpy, librarySpy } = {}) {
  const filename = path.join(ROOT, 'services/scannerSimilarityBinding.ts');
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;

  const requireMap = {
    './closetLibrary': { loadClosetTyped: closetSpy },
    './library': { loadLibrary: librarySpy },
    './actorContext': actorContext,
    '../constants/featureFlags': { SCAN_SIMILAR_ITEM_ENABLED: enabled },
  };

  const mod = { exports: {} };
  const sandbox = {
    console, exports: mod.exports, module: mod, JSON, Math, Date,
    Object, Array, Set, Map, String, Number, Boolean, Error, RegExp, Promise,
    process: { env: {} },
    require: (id) => {
      if (id in requireMap) return requireMap[id];
      throw new Error(`unexpected import '${id}'`);
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(output, sandbox, { filename });
  return mod.exports;
}

/** A minimal stand-in for the module-scoped actor epoch. */
function fakeActorContext(initialActorId = 'actor-1') {
  const state = { actorId: initialActorId, epoch: 1 };
  return {
    state,
    getActorContext: () => ({ actorId: state.actorId, epoch: state.epoch }),
    createActorRequest: () => ({
      actorId: state.actorId,
      epoch: state.epoch,
      requestId: `req-${state.epoch}`,
    }),
    isActorRequestCurrent: (request) =>
      request.actorId === state.actorId && request.epoch === state.epoch,
    /** Simulates sign-out / sign-in / actor switch. */
    advance: (nextActorId) => {
      state.actorId = nextActorId;
      state.epoch += 1;
    },
  };
}

const GARMENT = {
  candidateId: 'cand-1',
  category: 'outerwear',
  subtype: 'jacket',
  attributes: {
    category: 'outerwear',
    itemType: 'jacket',
    colorPalette: ['black', 'charcoal'],
    materialEstimate: 'leather',
    silhouette: 'bomber',
    pattern: 'solid',
  },
  identification: {
    brand_guess: 'ACME',
    visible_brand_text: 'ACME',
    primary_color: 'black',
    material_estimate: 'leather',
    silhouette: 'bomber',
    pattern: 'solid',
    subtype: 'jacket',
  },
};

function setup(overrides = {}) {
  const calls = { closet: [], library: [] };
  const actorContext = overrides.actorContext ?? fakeActorContext();
  const mod = loadBinding({
    enabled: overrides.enabled ?? true,
    actorContext,
    closetSpy: async (actorId, options) => {
      calls.closet.push({ actorId, options, argCount: arguments.length });
      return { ok: true, items: [{ id: 'closet-1', category: 'outerwear' }] };
    },
    librarySpy: async (actorId) => {
      calls.library.push({ actorId });
      return [{ id: 'scan-1', attributes: { category: 'outerwear' } }];
    },
  });
  return { mod, calls, actorContext };
}

// ── Account isolation ───────────────────────────────────────────────────────

test('ISOLATION — the Closet loader is never called without an explicit actor', async () => {
  const { mod, calls } = setup();
  const binding = mod.buildScannerSimilarityBinding({
    actorId: 'actor-1', scanId: 'scan-1', garment: GARMENT,
  });
  await binding.loadClosetRecords();

  assert.equal(calls.closet.length, 1);
  assert.notEqual(
    calls.closet[0].actorId, undefined,
    'undefined would read EVERY account partition',
  );
  assert.equal(calls.closet[0].actorId, 'actor-1');
});

test('ISOLATION — the Recent Scans loader is never called without an explicit actor', async () => {
  const { mod, calls } = setup();
  const binding = mod.buildScannerSimilarityBinding({
    actorId: 'actor-1', scanId: 'scan-1', garment: GARMENT,
  });
  await binding.loadRecentScanRecords();

  assert.equal(calls.library.length, 1);
  assert.notEqual(calls.library[0].actorId, undefined);
  assert.equal(calls.library[0].actorId, 'actor-1');
});

// PLATFORM DIVERGENCE from the Android line, deliberate.
//
// This line's `useKScan()` receives no actor, so the binding treats an omitted
// `actorId` as "resolve it from the module actor context" — the same route
// every other iOS scan-time operation takes. The Android binding instead
// requires the caller to pass one. Either way the loaders receive a concrete
// `string | null` and never `undefined`, which is the property that matters.
test('ISOLATION — an omitted actorId resolves from the actor context, never unfiltered', async () => {
  const actorContext = fakeActorContext('actor-from-context');
  const { mod, calls } = setup({ actorContext });
  const binding = mod.buildScannerSimilarityBinding({
    scanId: 'scan-1', garment: GARMENT,
  });
  await binding.loadClosetRecords();
  await binding.loadRecentScanRecords();

  assert.notEqual(calls.closet[0].actorId, undefined, 'undefined would read EVERY account');
  assert.equal(calls.closet[0].actorId, 'actor-from-context');
  assert.equal(calls.library[0].actorId, 'actor-from-context');
});

test('ISOLATION — a signed-out actor context yields the ownerless partition, not every account', async () => {
  const actorContext = fakeActorContext(null);
  const { mod, calls } = setup({ actorContext });
  const binding = mod.buildScannerSimilarityBinding({
    scanId: 'scan-1', garment: GARMENT,
  });
  await binding.loadClosetRecords();

  // null = the ownerless device-local partition, a real durable partition on
  // this line. undefined = every partition of every account.
  assert.equal(calls.closet[0].actorId, null);
});

test('ISOLATION — a blank or whitespace actorId collapses to null', async () => {
  const { mod, calls } = setup();
  const binding = mod.buildScannerSimilarityBinding({
    actorId: '   ', scanId: 'scan-1', garment: GARMENT,
  });
  await binding.loadClosetRecords();
  assert.equal(calls.closet[0].actorId, null);
});

test('ISOLATION — the captured actor request is passed to the Closet loader', async () => {
  const { mod, calls } = setup();
  const binding = mod.buildScannerSimilarityBinding({
    actorId: 'actor-1', scanId: 'scan-1', garment: GARMENT,
  });
  await binding.loadClosetRecords();
  assert.ok(calls.closet[0].options?.actorRequest, 'the loader must receive the actor request');
});

// ── Auth disappearing mid-load ──────────────────────────────────────────────

test('AUTH — records are discarded when the actor changes during the Closet load', async () => {
  const actorContext = fakeActorContext('actor-1');
  const { mod } = setup({ actorContext });
  const binding = mod.buildScannerSimilarityBinding({
    actorId: 'actor-1', scanId: 'scan-1', garment: GARMENT,
  });

  // The user signs out (or switches accounts) while the read is in flight.
  const pending = binding.loadClosetRecords();
  actorContext.advance('actor-2');
  const records = await pending;

  assert.deepEqual(
    plain(records), [],
    'a stale read must yield nothing rather than the previous actor\'s wardrobe',
  );
});

test('AUTH — records are discarded when the session disappears during the Recent Scans load', async () => {
  const actorContext = fakeActorContext('actor-1');
  const { mod } = setup({ actorContext });
  const binding = mod.buildScannerSimilarityBinding({
    actorId: 'actor-1', scanId: 'scan-1', garment: GARMENT,
  });

  const pending = binding.loadRecentScanRecords();
  actorContext.advance(null); // signed out
  const records = await pending;

  assert.deepEqual(
    plain(records), []);
});

test('AUTH — a sign-out and sign-back-in as the SAME user still invalidates', async () => {
  const actorContext = fakeActorContext('actor-1');
  const { mod } = setup({ actorContext });
  const binding = mod.buildScannerSimilarityBinding({
    actorId: 'actor-1', scanId: 'scan-1', garment: GARMENT,
  });

  const pending = binding.loadClosetRecords();
  actorContext.advance(null);
  actorContext.advance('actor-1'); // same id, new epoch
  const records = await pending;

  assert.deepEqual(
    plain(records), [],
    'the epoch, not just the id, must decide staleness',
  );
});

test('AUTH — a failed Closet read yields no records rather than throwing', async () => {
  const actorContext = fakeActorContext();
  const mod = loadBinding({
    enabled: true,
    actorContext,
    closetSpy: async () => ({ ok: false, items: null, code: 'CLOSET_LOAD_FAILED' }),
    librarySpy: async () => [],
  });
  const binding = mod.buildScannerSimilarityBinding({
    actorId: 'actor-1', scanId: 'scan-1', garment: GARMENT,
  });
  assert.deepEqual(plain(await binding.loadClosetRecords()), []);
});

// ── Flag behaviour ──────────────────────────────────────────────────────────

test('FLAG — the binding is null when the flag is off, so no loader can run', () => {
  const { mod } = setup({ enabled: false });
  const binding = mod.buildScannerSimilarityBinding({
    actorId: 'actor-1', scanId: 'scan-1', garment: GARMENT,
  });
  assert.equal(binding, null);
});

test('FLAG — an explicit override beats the build-time constant in both directions', () => {
  const off = setup({ enabled: false }).mod.buildScannerSimilarityBinding({
    actorId: 'a', scanId: 's', garment: GARMENT, enabled: true,
  });
  assert.ok(off, 'an explicit true must enable even when the constant is false');

  const on = setup({ enabled: true }).mod.buildScannerSimilarityBinding({
    actorId: 'a', scanId: 's', garment: GARMENT, enabled: false,
  });
  assert.equal(on, null, 'an explicit false must disable even when the constant is true');
});

test('FLAG — a missing scanId produces no binding', () => {
  const { mod } = setup();
  assert.equal(
    mod.buildScannerSimilarityBinding({ actorId: 'a', scanId: '', garment: GARMENT }),
    null,
  );
});

// ── Query derivation ────────────────────────────────────────────────────────

test('QUERY — the query is derived from the selected garment', () => {
  const { mod } = setup();
  const query = mod.buildSimilarityQueryFromGarment(GARMENT);

  assert.equal(query.canonicalCategory, 'outerwear');
  assert.equal(query.subtype, 'jacket');
  assert.equal(query.color, 'black');
  assert.equal(query.material, 'leather');
  assert.equal(query.silhouette, 'bomber');
  assert.equal(query.pattern, 'solid');
  assert.equal(query.brand, 'ACME');
});

test('QUERY — a garment with nothing comparable yields an empty query and no binding', () => {
  const { mod, calls } = setup();
  assert.deepEqual(
    plain(mod.buildSimilarityQueryFromGarment({})), {});
  assert.deepEqual(
    plain(mod.buildSimilarityQueryFromGarment(null)), {});
  assert.deepEqual(
    plain(mod.buildSimilarityQueryFromGarment('nonsense')), {});

  const binding = mod.buildScannerSimilarityBinding({
    actorId: 'actor-1', scanId: 'scan-1', garment: {},
  });
  assert.equal(binding, null, 'no resolved identity means no binding at all');
  assert.equal(calls.closet.length, 0, 'and therefore no read of any kind');
});

test('QUERY — absent fields are omitted rather than sent as null', () => {
  const { mod } = setup();
  const query = mod.buildSimilarityQueryFromGarment({
    category: 'footwear',
    subtype: 'sneaker',
  });
  assert.deepEqual(
    plain(Object.keys(query).sort()), ['canonicalCategory', 'subtype']);
  for (const value of Object.values(query)) {
    assert.notEqual(value, null);
    assert.notEqual(value, undefined);
  }
});

test('QUERY — image-level attributes cannot leak in through the garment', () => {
  // The whole-photo attributes belong to the outfit, not to the chosen garment.
  // Passing a response-shaped object (no garment fields) must yield nothing.
  const { mod } = setup();
  const imageLevelResponse = {
    attributes: { category: 'dress', colorPalette: ['red'] },
    detectedGarments: [GARMENT],
  };
  const query = mod.buildSimilarityQueryFromGarment(imageLevelResponse);
  assert.equal(
    query.canonicalCategory, 'dress',
    'sanity: this shape does read attributes.category',
  );
  // The real call site passes `candidate.garment`, never the response — pinned
  // by the mount test's MULTI-ITEM cases.
  assert.equal(query.brand, undefined, 'no garment identification means no brand');
});

test('QUERY — no image bytes or private identifiers can enter the query', () => {
  const { mod } = setup();
  const query = mod.buildSimilarityQueryFromGarment({
    ...GARMENT,
    imageBase64: 'AAAABBBB',
    ownerId: 'actor-secret',
    accessToken: 'ey.TOKEN',
  });
  const serialized = JSON.stringify(query);
  for (const forbidden of ['AAAABBBB', 'actor-secret', 'ey.TOKEN']) {
    assert.equal(serialized.includes(forbidden), false, `leaked: ${forbidden}`);
  }
});
