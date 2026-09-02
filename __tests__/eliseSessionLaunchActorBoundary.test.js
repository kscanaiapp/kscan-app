// ELISE-002 — actor boundary on the Elise session launch seam.
//
// launchStyleChatSession awaits a session lookup / creation round trip and then
// navigates. Home passed an `isCurrent` predicate that included an actor check;
// the conversations list (app/style-chat/index.tsx) passed none, so an account
// switch during that await still navigated the ARRIVING actor into a route
// bearing the DEPARTED actor's session id.
//
// The guard now lives in the shared seam rather than in one call site, so it
// cannot be omitted by a caller. These tests execute the real module.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadTsModule(relativePath, requireMap = {}) {
  const filename = path.join(ROOT, relativePath);
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;

  const module = { exports: {} };
  const sandbox = {
    __DEV__: false,
    console,
    exports: module.exports,
    module,
    require: (id) => {
      if (id in requireMap) return requireMap[id];
      if (id.startsWith('node:')) return require(id);
      throw new Error(`Unexpected require: ${id}`);
    },
  };
  vm.runInNewContext(output, sandbox, { filename });
  return module.exports;
}

const ACTOR_A = '11111111-1111-1111-1111-111111111111';
const ACTOR_B = '22222222-2222-2222-2222-222222222222';
const A_SESSION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function createActorScopeStub() {
  let actorId = null;
  let epoch = 0;
  return {
    module: {
      captureActorScope: () => ({ actorId, epoch, requestId: actorId + '#' + epoch }),
      isActorScopeCurrent: (scope) =>
        Boolean(scope) && scope.actorId === actorId && scope.epoch === epoch,
      currentActorId: () => actorId,
      currentActorScopeKey: () => (actorId ?? 'anonymous') + '#' + epoch,
    },
    setActor(nextActorId) {
      actorId = nextActorId;
      epoch += 1;
    },
  };
}

function loadLaunch(actorScope) {
  return loadTsModule('services/style-chat/sessionLaunchGuard.ts', {
    '../actorScope': actorScope,
  });
}

test('ELISE-002: an account switch during session creation cancels the navigation', async () => {
  const scope = createActorScopeStub();
  scope.setActor(ACTOR_A);
  const { createStyleChatSessionLaunchGuard, launchStyleChatSession } = loadLaunch(scope.module);

  const navigated = [];
  const guard = createStyleChatSessionLaunchGuard();

  const result = await launchStyleChatSession({
    guard,
    // The account switch lands while the create round trip is in flight —
    // exactly the window the conversations list left unguarded.
    createSession: async () => {
      scope.setActor(ACTOR_B);
      return { id: A_SESSION_ID };
    },
    navigate: (sessionId) => navigated.push(sessionId),
    // No isCurrent: this reproduces app/style-chat/index.tsx's call shape.
  });

  assert.equal(result.status, 'cancelled', 'a cross-actor launch must not report success');
  assert.deepEqual(navigated, [], 'the arriving actor must not be routed into a foreign session id');
});

test('ELISE-002: an account switch during the resume lookup cancels the navigation', async () => {
  const scope = createActorScopeStub();
  scope.setActor(ACTOR_A);
  const { createStyleChatSessionLaunchGuard, launchStyleChatSession } = loadLaunch(scope.module);

  const navigated = [];
  const result = await launchStyleChatSession({
    guard: createStyleChatSessionLaunchGuard(),
    createSession: async () => {
      throw new Error('resume must not fall through to create');
    },
    resolveExistingSessionId: async () => {
      scope.setActor(ACTOR_B);
      return A_SESSION_ID;
    },
    navigate: (sessionId) => navigated.push(sessionId),
  });

  assert.equal(result.status, 'cancelled');
  assert.deepEqual(navigated, []);
});

test('ELISE-002: an A -> B -> A cycle is still cancelled, because the epoch moved', async () => {
  const scope = createActorScopeStub();
  scope.setActor(ACTOR_A);
  const { createStyleChatSessionLaunchGuard, launchStyleChatSession } = loadLaunch(scope.module);

  const navigated = [];
  const result = await launchStyleChatSession({
    guard: createStyleChatSessionLaunchGuard(),
    createSession: async () => {
      scope.setActor(ACTOR_B);
      scope.setActor(ACTOR_A);
      return { id: A_SESSION_ID };
    },
    navigate: (sessionId) => navigated.push(sessionId),
  });

  assert.equal(result.status, 'cancelled', 'the same id from a new generation is still stale');
  assert.deepEqual(navigated, []);
});

test('ELISE-002: a cancelled launch releases the guard so the next tap is not swallowed', async () => {
  const scope = createActorScopeStub();
  scope.setActor(ACTOR_A);
  const { createStyleChatSessionLaunchGuard, launchStyleChatSession } = loadLaunch(scope.module);
  const guard = createStyleChatSessionLaunchGuard();

  await launchStyleChatSession({
    guard,
    createSession: async () => {
      scope.setActor(ACTOR_B);
      return { id: A_SESSION_ID };
    },
    navigate: () => {},
  });

  // The departed actor's remembered id must not be reused by the new actor.
  assert.equal(guard.getPendingSessionId(), null);

  const navigated = [];
  const second = await launchStyleChatSession({
    guard,
    createSession: async () => ({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }),
    navigate: (sessionId) => navigated.push(sessionId),
  });
  assert.equal(second.status, 'navigated');
  assert.deepEqual(navigated, ['cccccccc-cccc-4ccc-8ccc-cccccccccccc']);
});

test('ELISE-002: an ordinary same-actor launch is unchanged', async () => {
  const scope = createActorScopeStub();
  scope.setActor(ACTOR_A);
  const { createStyleChatSessionLaunchGuard, launchStyleChatSession } = loadLaunch(scope.module);

  const navigated = [];
  const result = await launchStyleChatSession({
    guard: createStyleChatSessionLaunchGuard(),
    createSession: async () => ({ id: A_SESSION_ID }),
    navigate: (sessionId) => navigated.push(sessionId),
  });

  assert.equal(result.status, 'navigated');
  assert.equal(result.sessionId, A_SESSION_ID);
  assert.deepEqual(navigated, [A_SESSION_ID]);
});

test("ELISE-002: a caller's own isCurrent still applies on top of the actor check", async () => {
  const scope = createActorScopeStub();
  scope.setActor(ACTOR_A);
  const { createStyleChatSessionLaunchGuard, launchStyleChatSession } = loadLaunch(scope.module);

  const navigated = [];
  const result = await launchStyleChatSession({
    guard: createStyleChatSessionLaunchGuard(),
    createSession: async () => ({ id: A_SESSION_ID }),
    navigate: (sessionId) => navigated.push(sessionId),
    // Home also refuses when its screen is no longer active.
    isCurrent: () => false,
  });

  assert.equal(result.status, 'cancelled');
  assert.deepEqual(navigated, []);
});
