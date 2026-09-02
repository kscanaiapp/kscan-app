const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function transpile(relativePath) {
  const filename = path.join(ROOT, relativePath);
  const source = fs.readFileSync(filename, 'utf8');
  return {
    filename,
    output: ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
      },
    }).outputText,
  };
}

function loadTsModule(relativePath, requireMap = {}) {
  const { filename, output } = transpile(relativePath);
  const module = { exports: {} };
  vm.runInNewContext(
    output,
    {
      exports: module.exports,
      module,
      require: (id) => {
        if (id in requireMap) return requireMap[id];
        throw new Error(`Unexpected require: ${id}`);
      },
    },
    { filename },
  );
  return module.exports;
}

// ELISE-002: the launch seam owns the actor boundary now, so it imports the
// actor authority. The REAL one is supplied (not a stub) — these tests never
// change actor, so every assertion below is unchanged by it.
function loadGuard() {
  return loadTsModule('services/style-chat/sessionLaunchGuard.ts', {
    '../actorScope': loadTsModule('services/actorScope.ts', {
      './actorContext': require('../services/actorContext.js'),
    }),
  });
}

test('guard blocks every rapid retry until navigation leaves the session list', () => {
  const guard = loadGuard().createStyleChatSessionLaunchGuard();

  assert.equal(guard.tryBegin(), true);
  guard.rememberSession('session-1');
  assert.equal(guard.tryBegin(), false);
  assert.equal(guard.tryBegin(), false);
  assert.equal(guard.getPendingSessionId(), 'session-1');
});

test('navigation failure retries the remembered session without creating another', () => {
  const guard = loadGuard().createStyleChatSessionLaunchGuard();

  assert.equal(guard.tryBegin(), true);
  guard.rememberSession('session-1');
  guard.releaseForRetry();

  assert.equal(guard.tryBegin(), true);
  assert.equal(guard.getPendingSessionId(), 'session-1');
});

test('returning focus clears the completed navigation guard for a new session', () => {
  const guard = loadGuard().createStyleChatSessionLaunchGuard();

  assert.equal(guard.tryBegin(), true);
  guard.rememberSession('session-1');
  guard.resetOnFocus();

  assert.equal(guard.getPendingSessionId(), null);
  assert.equal(guard.tryBegin(), true);
});

test('single Start Chat launch creates one session and navigates once', async () => {
  const { createStyleChatSessionLaunchGuard, launchStyleChatSession } = loadGuard();
  const guard = createStyleChatSessionLaunchGuard();
  let creates = 0;
  const navigations = [];

  const result = await launchStyleChatSession({
    guard,
    createSession: async () => ({ id: `session-${++creates}` }),
    navigate: (sessionId) => navigations.push(sessionId),
  });

  assert.equal(result.status, 'navigated');
  assert.equal(creates, 1);
  assert.deepEqual(navigations, ['session-1']);
});

test('rapid Start Chat launches share the guard and create only one session', async () => {
  const { createStyleChatSessionLaunchGuard, launchStyleChatSession } = loadGuard();
  const guard = createStyleChatSessionLaunchGuard();
  let creates = 0;
  let releaseCreate;
  const pendingCreate = new Promise((resolve) => { releaseCreate = resolve; });
  const navigations = [];
  const input = {
    guard,
    createSession: async () => {
      creates += 1;
      await pendingCreate;
      return { id: 'session-1' };
    },
    navigate: (sessionId) => navigations.push(sessionId),
  };

  const first = launchStyleChatSession(input);
  const second = await launchStyleChatSession(input);
  releaseCreate();
  const firstResult = await first;

  assert.equal(firstResult.status, 'navigated');
  assert.equal(second.status, 'ignored');
  assert.equal(creates, 1);
  assert.deepEqual(navigations, ['session-1']);
});

test('session creation failure is retryable and does not navigate', async () => {
  const { createStyleChatSessionLaunchGuard, launchStyleChatSession } = loadGuard();
  const guard = createStyleChatSessionLaunchGuard();
  let attempts = 0;
  const navigations = [];
  const createSession = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('offline');
    return { id: 'session-retry' };
  };

  const failed = await launchStyleChatSession({ guard, createSession, navigate: (id) => navigations.push(id) });
  const retried = await launchStyleChatSession({ guard, createSession, navigate: (id) => navigations.push(id) });

  assert.equal(failed.status, 'failed');
  assert.equal(retried.status, 'navigated');
  assert.equal(attempts, 2);
  assert.deepEqual(navigations, ['session-retry']);
});

test('navigation failure retries the remembered session without a second create', async () => {
  const { createStyleChatSessionLaunchGuard, launchStyleChatSession } = loadGuard();
  const guard = createStyleChatSessionLaunchGuard();
  let creates = 0;
  let navigationAttempts = 0;
  const input = {
    guard,
    createSession: async () => ({ id: `session-${++creates}` }),
    navigate: () => {
      navigationAttempts += 1;
      if (navigationAttempts === 1) throw new Error('route failed');
    },
  };

  const failed = await launchStyleChatSession(input);
  const retried = await launchStyleChatSession(input);

  assert.equal(failed.status, 'failed');
  assert.equal(retried.status, 'navigated');
  assert.equal(creates, 1);
  assert.equal(navigationAttempts, 2);
});

test('actor change or unmount after creation cancels route transition', async () => {
  const { createStyleChatSessionLaunchGuard, launchStyleChatSession } = loadGuard();
  const guard = createStyleChatSessionLaunchGuard();
  let current = true;
  const navigations = [];

  const result = await launchStyleChatSession({
    guard,
    createSession: async () => {
      current = false;
      return { id: 'session-1' };
    },
    navigate: (id) => navigations.push(id),
    isCurrent: () => current,
  });

  assert.equal(result.status, 'cancelled');
  assert.deepEqual(navigations, []);
  assert.equal(guard.getPendingSessionId(), null);
  assert.equal(guard.tryBegin(), true);
});

test('Home renders a visible retryable launch failure and resets the guard on refocus', () => {
  const home = fs.readFileSync(path.join(ROOT, 'components', 'home', 'HomeLuxuryTechV1.tsx'), 'utf8');
  assert.match(home, /launchStyleChatSession/);
  assert.match(home, /setSessionLaunchError\("We couldn't start a conversation\. Please try again\."\)/);
  assert.match(home, /sessionLaunchGuardRef\.current\?\.resetOnFocus\(\)/);
  assert.match(home, /startError=\{sessionLaunchError\}/);
});
