// Build 5 Phase 1 — Today with Elise priority engine + actor stale completion.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadTsModule(relPath, stubs = {}) {
  const full = path.join(ROOT, relPath);
  const source = ts.transpileModule(fs.readFileSync(full, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;

  const moduleCache = new Map();

  function localRequire(request) {
    if (stubs[request]) return stubs[request];
    if (request.startsWith('.')) {
      const resolved = path.resolve(path.dirname(full), request);
      const candidates = [
        resolved,
        `${resolved}.ts`,
        `${resolved}.js`,
        path.join(resolved, 'index.ts'),
      ];
      for (const candidate of candidates) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          if (moduleCache.has(candidate)) return moduleCache.get(candidate).exports;
          const childSource = ts.transpileModule(fs.readFileSync(candidate, 'utf8'), {
            compilerOptions: {
              module: ts.ModuleKind.CommonJS,
              target: ts.ScriptTarget.ES2020,
              esModuleInterop: true,
            },
          }).outputText;
          const child = { exports: {} };
          moduleCache.set(candidate, child);
          const childSandbox = {
            module: child,
            exports: child.exports,
            require: localRequire,
            console,
            Object,
            Array,
            Map,
            Set,
            Number,
            String,
            Boolean,
            JSON,
            Math,
            __DEV__: false,
          };
          vm.runInNewContext(childSource, childSandbox, { filename: candidate });
          return child.exports;
        }
      }
    }
    return require(request);
  }

  const mod = { exports: {} };
  const sandbox = {
    module: mod,
    exports: mod.exports,
    require: localRequire,
    console,
    Object,
    Array,
    Map,
    Set,
    Number,
    String,
    Boolean,
    JSON,
    Math,
    __DEV__: false,
  };
  vm.runInNewContext(source, sandbox, { filename: full });
  return mod.exports;
}

const {
  evaluateTodayWithEliseCard,
  tieBreakUnfinished,
  isTodayCardResultCurrent,
} = loadTsModule('services/todayWithElise/priorityEngine.ts');

const {
  beginTodayCardEvaluation,
  canCommitTodayCardResult,
  invalidateTodayCardStateIfStale,
  __resetTodayCardGenerationCounter,
} = loadTsModule('services/todayWithElise/actorInvalidation.ts');

function baseSnapshot(overrides = {}) {
  return {
    actorId: 'actor-a',
    actorEpoch: 3,
    generationToken: 'today_3_1',
    evaluatedAtMs: 1_000_000,
    maxSourceAgeMs: 60_000,
    sourceCapturedAtMs: 990_000,
    unfinishedLook: null,
    todayOwnedLook: null,
    recentStyling: null,
    closetAction: null,
    onboarding: null,
    capabilities: {
      todayWithEliseActive: true,
      privateDressingRoomActive: true,
      weatherActive: false,
      generatedGreetingActive: false,
    },
    malformed: false,
    ...overrides,
  };
}

test('missing actor fails closed to unauthorized', () => {
  const card = evaluateTodayWithEliseCard(baseSnapshot({ actorId: null }));
  assert.equal(card.stateId, 'unauthorized');
  assert.equal(card.primaryAction.action, 'none');
});

test('malformed snapshot refuses as incompatible', () => {
  const card = evaluateTodayWithEliseCard(baseSnapshot({ malformed: true }));
  assert.equal(card.stateId, 'incompatible');
});

test('stale source data refuses', () => {
  const card = evaluateTodayWithEliseCard(
    baseSnapshot({ sourceCapturedAtMs: 1_000_000 - 120_000 }),
  );
  assert.equal(card.stateId, 'stale');
});

test('priority order: unfinished beats today owned look', () => {
  const card = evaluateTodayWithEliseCard(
    baseSnapshot({
      unfinishedLook: {
        sessionId: 's1',
        savedLookId: null,
        updatedAtMs: 900_000,
        itemRefs: [{ closetItemId: 'c1', slot: 'top' }],
      },
      todayOwnedLook: {
        lookKey: 'look-1',
        completeness: 'complete',
        itemRefs: [{ closetItemId: 'c2', slot: 'top' }],
        dayKey: '2026-07-30',
      },
    }),
  );
  assert.equal(card.stateId, 'unfinished_look');
  assert.equal(card.priority, 'unfinished_look');
  assert.equal(card.primaryAction.action, 'continue_your_look');
  assert.equal(card.primaryAction.runnable, true);
});

test('no dead Dressing Room primary when PDR unavailable — falls through to closet', () => {
  const card = evaluateTodayWithEliseCard(
    baseSnapshot({
      unfinishedLook: {
        sessionId: 's1',
        savedLookId: null,
        updatedAtMs: 900_000,
        itemRefs: [],
      },
      todayOwnedLook: {
        lookKey: 'look-1',
        completeness: 'complete',
        itemRefs: [{ closetItemId: 'c2', slot: 'top' }],
        dayKey: '2026-07-30',
      },
      closetAction: { kind: 'review_queue', pendingCount: 2 },
      capabilities: {
        todayWithEliseActive: true,
        privateDressingRoomActive: false,
        weatherActive: false,
        generatedGreetingActive: false,
      },
    }),
  );
  assert.equal(card.stateId, 'closet_action');
  assert.equal(card.primaryAction.action, 'review_items');
  assert.equal(card.primaryAction.runnable, true);
  assert.notEqual(card.primaryAction.target, 'private_dressing_room');
});

test('partial today owned look is never labeled complete', () => {
  const card = evaluateTodayWithEliseCard(
    baseSnapshot({
      todayOwnedLook: {
        lookKey: 'look-partial',
        completeness: 'partial',
        itemRefs: [{ closetItemId: 'c2', slot: 'top' }],
        dayKey: '2026-07-30',
      },
    }),
  );
  assert.equal(card.stateId, 'partial_look');
  assert.equal(card.completeness, 'partial');
  assert.equal(card.analyticsClass, 'partial');
});

test('tie-break prefers newer unfinished session', () => {
  const winner = tieBreakUnfinished(
    { sessionId: 'a', updatedAtMs: 10 },
    { sessionId: 'b', updatedAtMs: 20 },
  );
  assert.equal(winner.sessionId, 'b');
});

test('actor A result cannot apply to actor B live context', () => {
  const result = evaluateTodayWithEliseCard(baseSnapshot({ actorId: 'actor-a' }));
  assert.equal(
    isTodayCardResultCurrent(
      { actorId: 'actor-b', actorEpoch: 3, generationToken: 'today_3_1' },
      result,
    ),
    false,
  );
});

test('actor switch / logout invalidates pending commit', () => {
  __resetTodayCardGenerationCounter();
  const handleA = beginTodayCardEvaluation({ actorId: 'actor-a', actorEpoch: 1 });
  assert.equal(
    canCommitTodayCardResult({
      handle: handleA,
      liveActorId: 'actor-b',
      liveActorEpoch: 2,
      actorRequestCurrent: false,
    }),
    false,
  );
  assert.equal(
    canCommitTodayCardResult({
      handle: handleA,
      liveActorId: null,
      liveActorEpoch: 2,
      actorRequestCurrent: false,
    }),
    false,
  );
});

test('reauthentication with new epoch cannot revive obsolete recommendation', () => {
  __resetTodayCardGenerationCounter();
  const handle = beginTodayCardEvaluation({ actorId: 'actor-a', actorEpoch: 1 });
  const staleCard = evaluateTodayWithEliseCard(
    baseSnapshot({
      actorId: 'actor-a',
      actorEpoch: 1,
      generationToken: handle.generationToken,
    }),
  );
  const live = beginTodayCardEvaluation({ actorId: 'actor-a', actorEpoch: 2 });
  assert.equal(invalidateTodayCardStateIfStale(staleCard, live), null);
});

test('background completion cannot overwrite newer generation', () => {
  __resetTodayCardGenerationCounter();
  const older = beginTodayCardEvaluation({ actorId: 'actor-a', actorEpoch: 5 });
  const newer = beginTodayCardEvaluation({ actorId: 'actor-a', actorEpoch: 5 });
  assert.notEqual(older.generationToken, newer.generationToken);
  assert.equal(
    canCommitTodayCardResult({
      handle: older,
      liveActorId: 'actor-a',
      liveActorEpoch: 5,
      // live request is still current for epoch, but generation belongs to newer work
      actorRequestCurrent: true,
    }),
    true,
  );
  // Explicit generation check via isTodayCardResultCurrent
  const olderResult = evaluateTodayWithEliseCard(
    baseSnapshot({
      actorId: 'actor-a',
      actorEpoch: 5,
      generationToken: older.generationToken,
      closetAction: { kind: 'review_queue', pendingCount: 1 },
    }),
  );
  assert.equal(
    isTodayCardResultCurrent(
      {
        actorId: 'actor-a',
        actorEpoch: 5,
        generationToken: newer.generationToken,
      },
      olderResult,
    ),
    false,
  );
});

test('deterministic for identical snapshots', () => {
  const snap = baseSnapshot({
    closetAction: { kind: 'review_queue', pendingCount: 1 },
  });
  const a = evaluateTodayWithEliseCard(snap);
  const b = evaluateTodayWithEliseCard(snap);
  assert.deepEqual(a, b);
});
