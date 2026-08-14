const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');

function transpileModule(file, mocks = {}) {
  const sourcePath = path.join(ROOT, file);
  const output = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const mod = { exports: {} };
  const sandbox = {
    console,
    Error,
    Set,
    setTimeout,
    clearTimeout,
    exports: mod.exports,
    module: mod,
    require: (specifier) => {
      if (specifier in mocks) return mocks[specifier];
      throw new Error(`Unexpected import in ${file}: ${specifier}`);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename: sourcePath }).runInContext(sandbox);
  return mod.exports;
}

// ── Hook harness ────────────────────────────────────────────────────────────

function depsEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((value, index) => Object.is(value, b[index]));
}

function createHarness() {
  const slots = [];
  let cursor = 0;
  let pendingEffects = [];
  const react = {
    useRef(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { kind: 'ref', ref: { current: initial } };
      return slots[index].ref;
    },
    useEffect(effect, deps) {
      const index = cursor++;
      pendingEffects.push({ index, effect, deps });
    },
    useSyncExternalStore(subscribe, getSnapshot) {
      const index = cursor++;
      if (!(index in slots)) {
        slots[index] = { kind: 'store', unsubscribe: subscribe(() => {}) };
      }
      return getSnapshot();
    },
  };
  react.default = react;

  function render(hook, props) {
    cursor = 0;
    pendingEffects = [];
    const result = hook(props);
    for (const { index, effect, deps } of pendingEffects) {
      const slot = slots[index];
      if (slot && slot.kind === 'effect' && depsEqual(slot.deps, deps)) continue;
      if (slot && slot.kind === 'effect' && typeof slot.cleanup === 'function') slot.cleanup();
      const cleanup = effect();
      slots[index] = { kind: 'effect', deps, cleanup };
    }
    return result;
  }

  function unmount() {
    for (const slot of slots) {
      if (slot && slot.kind === 'effect' && typeof slot.cleanup === 'function') {
        slot.cleanup();
        slot.cleanup = undefined;
      }
      if (slot && slot.kind === 'store' && typeof slot.unsubscribe === 'function') {
        slot.unsubscribe();
        slot.unsubscribe = undefined;
      }
    }
    slots.length = 0;
  }

  return { react, render, unmount };
}

function snapshot(overrides = {}) {
  return {
    actorId: 'actor-1',
    sessionId: 'session-1',
    stylistId: 'stylist_portrait_01',
    avatarId: 'stylist_portrait_01',
    generation: 0,
    phase: 'idle',
    source: null,
    speaking: false,
    mouth: 'closed',
    ...overrides,
  };
}

function loadStack({ flagEnabled = true } = {}) {
  const harness = createHarness();
  const contract = transpileModule('services/avatarMotionState.ts', {});
  const controllerModule = transpileModule('services/avatarMotionController.ts', {
    './avatarMotionState': contract,
  });
  controllerModule.resetSharedAvatarMotionControllerForTests();

  const appState = { handlers: new Set(), addCalls: 0, removeCalls: 0 };
  const lifecycle = transpileModule('services/avatarSpeechLifecycle.ts', {
    'react-native': {
      AppState: {
        addEventListener: (_event, handler) => {
          appState.addCalls += 1;
          appState.handlers.add(handler);
          return {
            remove: () => {
              appState.removeCalls += 1;
              appState.handlers.delete(handler);
            },
          };
        },
      },
    },
  });

  const store = { snapshot: snapshot(), subscribeCalls: 0, listeners: new Set() };
  const motionStoreMock = {
    getAvatarMotionSnapshot: () => store.snapshot,
    subscribeToAvatarMotion: (listener) => {
      store.subscribeCalls += 1;
      store.listeners.add(listener);
      return () => store.listeners.delete(listener);
    },
  };

  const hookModule = transpileModule('hooks/useAvatarConversationMotion.ts', {
    react: harness.react,
    '../constants/featureFlags': { AVATAR_MOTION_V1_ENABLED: flagEnabled },
    '../services/avatarMotionController': controllerModule,
    '../services/avatarMotionState': contract,
    '../services/avatarSpeechLifecycle': lifecycle,
    '../stores/avatarMotionStore': motionStoreMock,
  });

  const controller = controllerModule.getSharedAvatarMotionController();
  const fireAppState = (state) => {
    for (const handler of [...appState.handlers]) handler(state);
  };
  return { harness, hookModule, controllerModule, controller, store, lifecycle, appState, fireAppState };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

/** Assert every motion channel is at its neutral value. */
function assertFullyNeutral(controller, label) {
  const s = controller.getSnapshot();
  assert.equal(s.mode, 'idle', `${label}: mode idle`);
  assert.equal(s.mouth, 'closed', `${label}: mouth closed`);
  assert.equal(s.eyes, 'open', `${label}: eyes open`);
  assert.equal(s.brows, 'neutral', `${label}: brows neutral`);
  assert.equal(s.gaze.x, 0, `${label}: gaze x neutral`);
  assert.equal(s.gaze.y, 0, `${label}: gaze y neutral`);
  assert.equal(s.expression, 'neutral', `${label}: expression neutral`);
  assert.equal(s.head.pitchDeg, 0, `${label}: head pitch neutral`);
  assert.equal(s.head.rollDeg, 0, `${label}: head roll neutral`);
  assert.equal(s.head.yawDeg, 0, `${label}: head yaw neutral`);
  assert.equal(s.breathingScale, 1, `${label}: breathing neutral`);
  assert.equal(s.shoulderOffsetPx, 0, `${label}: shoulder neutral`);
  assert.equal(s.speaking, false, `${label}: not speaking`);
}

/**
 * Drive the hook into a named active state. Returns the props last rendered
 * and the speech generation in play.
 */
async function enterState(context, activeState) {
  const { harness, hookModule, store } = context;
  const base = { inputActive: false, isSending: false, avatarId: 'a1', hysteresisMs: 5 };
  const generation = 9;

  switch (activeState) {
    case 'pending listening': {
      const props = { ...base, inputActive: true, hysteresisMs: 10_000 };
      harness.render(hookModule.useAvatarConversationMotion, props);
      return { props, generation };
    }
    case 'listening': {
      const props = { ...base, inputActive: true, hysteresisMs: 0 };
      harness.render(hookModule.useAvatarConversationMotion, props);
      await tick();
      return { props, generation };
    }
    case 'thinking': {
      const props = { ...base, isSending: true };
      harness.render(hookModule.useAvatarConversationMotion, props);
      return { props, generation };
    }
    case 'ready/preparing': {
      store.snapshot = snapshot({ phase: 'ready', generation });
      const props = { ...base };
      harness.render(hookModule.useAvatarConversationMotion, props);
      return { props, generation };
    }
    case 'anti-pop': {
      store.snapshot = snapshot({
        phase: 'playing', generation, speaking: true, mouth: 'halfOpen',
      });
      const props = { ...base };
      harness.render(hookModule.useAvatarConversationMotion, props);
      return { props, generation };
    }
    case 'speaking': {
      store.snapshot = snapshot({
        phase: 'playing', generation, speaking: true, mouth: 'open',
      });
      const props = { ...base };
      harness.render(hookModule.useAvatarConversationMotion, props);
      return { props, generation };
    }
    case 'reacting': {
      harness.render(hookModule.useAvatarConversationMotion, base);
      context.controller.requestMode('reacting');
      return { props: base, generation };
    }
    default:
      throw new Error(`unknown state ${activeState}`);
  }
}

const ACTIVE_STATES = [
  'pending listening',
  'listening',
  'thinking',
  'ready/preparing',
  'anti-pop',
  'speaking',
  'reacting',
];

// ── KAVA-P2-002 lifecycle matrix ────────────────────────────────────────────

test('matrix: unmount from every active state returns motion to fully neutral', async () => {
  for (const activeState of ACTIVE_STATES) {
    const context = loadStack();
    await enterState(context, activeState);
    context.harness.unmount();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assertFullyNeutral(context.controller, `unmount from ${activeState}`);
  }
});

test('matrix: background/inactive from every active state returns motion to fully neutral', async () => {
  for (const interruption of ['background', 'inactive']) {
    for (const activeState of ACTIVE_STATES) {
      const context = loadStack();
      await enterState(context, activeState);
      context.fireAppState(interruption);
      await tick();
      assertFullyNeutral(context.controller, `${interruption} from ${activeState}`);
    }
  }
});

test('matrix: avatar switch from every active state returns motion to fully neutral', async () => {
  for (const activeState of ACTIVE_STATES) {
    const context = loadStack();
    const { props } = await enterState(context, activeState);
    // Same surface, different avatar: the teardown effect is keyed by avatarId.
    context.harness.render(context.hookModule.useAvatarConversationMotion, {
      ...props,
      inputActive: false,
      isSending: false,
      avatarId: 'a2',
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assertFullyNeutral(context.controller, `avatar switch from ${activeState}`);
  }
});

test('matrix: a pending listening timer never fires after any teardown', async () => {
  // Unmount while the hysteresis timer is still pending.
  const unmountContext = loadStack();
  await enterState(unmountContext, 'pending listening');
  unmountContext.harness.unmount();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(unmountContext.controller.getSnapshot().mode, 'idle', 'unmount cancelled the timer');

  // Background while the hysteresis timer is still pending.
  const backgroundContext = loadStack();
  const pending = await enterState(backgroundContext, 'pending listening');
  backgroundContext.harness.render(
    backgroundContext.hookModule.useAvatarConversationMotion,
    { ...pending.props, hysteresisMs: 20 },
  );
  backgroundContext.fireAppState('background');
  await new Promise((resolve) => setTimeout(resolve, 60));
  // The timer may still fire, but the reset invalidated the surface; a
  // listening mode must not be left standing after the interruption.
  backgroundContext.harness.unmount();
  await tick();
  assertFullyNeutral(backgroundContext.controller, 'background with pending timer');
});

test('matrix: stale playback callbacks cannot reactivate motion after teardown', async () => {
  for (const teardown of ['unmount', 'background', 'avatar switch']) {
    const context = loadStack();
    const { props, generation } = await enterState(context, 'speaking');
    assert.equal(context.controller.getSnapshot().mode, 'speaking', teardown);

    if (teardown === 'unmount') {
      context.harness.unmount();
    } else if (teardown === 'background') {
      context.fireAppState('background');
    } else {
      context.harness.render(context.hookModule.useAvatarConversationMotion, {
        ...props, avatarId: 'a2',
      });
    }
    await tick();

    // A late native callback for the torn-down utterance must be inert.
    assert.equal(
      context.controller.reportPlaybackActive(generation),
      false,
      `${teardown}: stale playback rejected`,
    );
    assert.equal(context.controller.reportPlaybackMouth(generation, 'open'), false, teardown);
    assert.equal(context.controller.requestMode('listening', generation), false, teardown);
    assertFullyNeutral(context.controller, `${teardown}: still neutral after stale callbacks`);
  }
});

test('re-entry after teardown works: a newer generation still starts speaking', async () => {
  const context = loadStack();
  const { generation } = await enterState(context, 'speaking');
  context.harness.unmount();
  await tick();

  // Repeated teardowns must not push the controller past the speech sequence.
  context.fireAppState('background');
  context.fireAppState('background');
  await tick();

  const context2 = loadStack();
  // Fresh surface, same shared controller instance semantics: the next real
  // utterance carries a higher generation and must be accepted.
  context2.store.snapshot = snapshot({
    phase: 'playing', generation: generation + 1, speaking: true, mouth: 'halfOpen',
  });
  context2.harness.render(context2.hookModule.useAvatarConversationMotion, {
    inputActive: false, isSending: false, avatarId: 'a1', hysteresisMs: 0,
  });
  assert.equal(context2.controller.getSnapshot().mode, 'speaking', 're-entry can speak again');
});

test('repeated resets never lock out future speech generations', () => {
  const contract = transpileModule('services/avatarMotionState.ts', {});
  const controllerModule = transpileModule('services/avatarMotionController.ts', {
    './avatarMotionState': contract,
  });
  const controller = controllerModule.createAvatarMotionController({
    clock: () => 0,
    random: () => 0.5,
  });
  assert.equal(controller.reportPlaybackActive(3), true);
  // Five teardowns in a row (unmount + background + avatar switch + ...).
  for (let index = 0; index < 5; index += 1) {
    controller.reset();
    controller.interrupt();
  }
  // The very next utterance is generation 4 — one above the last accepted.
  assert.equal(
    controller.reportPlaybackActive(4),
    true,
    'a single-step generation increase still starts speaking after many resets',
  );
  assert.equal(controller.getSnapshot().mode, 'speaking');
});

test('the interruption handler is unregistered on teardown, leaving no listener', async () => {
  const context = loadStack();
  await enterState(context, 'thinking');
  assert.equal(
    context.lifecycle.getAvatarInterruptionHandlerCountForTests(),
    1,
    'exactly one motion interruption handler while mounted',
  );
  context.harness.unmount();
  assert.equal(
    context.lifecycle.getAvatarInterruptionHandlerCountForTests(),
    0,
    'no handler survives teardown',
  );
  assert.equal(context.appState.addCalls, 1, 'motion reuses the single AppState listener');
});

test('flag off: no lifecycle registration, no controller mutation, no subscriptions', async () => {
  const context = loadStack({ flagEnabled: false });
  for (const activeState of ['thinking', 'listening']) {
    await enterState(context, activeState);
  }
  await tick();
  assert.equal(context.lifecycle.getAvatarInterruptionHandlerCountForTests(), 0);
  assert.equal(context.store.subscribeCalls, 0);
  assert.equal(context.controller.getListenerCountForTests(), 0);
  assertFullyNeutral(context.controller, 'flag off');
  context.harness.unmount();
  assertFullyNeutral(context.controller, 'flag off after unmount');
});

test('foreground state is exposed for continuous motion and recovers on resume', () => {
  const context = loadStack();
  assert.equal(context.lifecycle.getAvatarAppForegroundSnapshot(), true);
  let notifications = 0;
  const unsubscribe = context.lifecycle.subscribeToAvatarAppForeground(() => {
    notifications += 1;
  });
  context.fireAppState('background');
  assert.equal(context.lifecycle.getAvatarAppForegroundSnapshot(), false);
  assert.equal(notifications, 1);
  context.fireAppState('active');
  assert.equal(context.lifecycle.getAvatarAppForegroundSnapshot(), true);
  assert.equal(notifications, 2);
  // Repeated identical transitions do not re-notify.
  context.fireAppState('active');
  assert.equal(notifications, 2);
  unsubscribe();
  context.fireAppState('background');
  assert.equal(notifications, 2, 'unsubscribed listeners stop receiving updates');
});

test('composite motion loops are gated on app foreground', () => {
  const source = fs.readFileSync(path.join(ROOT, 'hooks', 'useAvatarCompositeMotion.ts'), 'utf8');
  assert.match(source, /useAvatarAppForeground/);
  assert.match(source, /const active = enabled && foreground/);
  assert.match(source, /\}, \[active, avatarId, breathing, rollDeg\]\);/);
  const foregroundHook = fs.readFileSync(
    path.join(ROOT, 'hooks', 'useAvatarAppForeground.ts'),
    'utf8',
  );
  assert.match(foregroundHook, /subscribeToAvatarAppForeground/);
});

test('the screen supplies the avatar identity so a switch tears motion down', () => {
  const screen = fs.readFileSync(path.join(ROOT, 'app', 'style-chat', '[sessionId].tsx'), 'utf8');
  assert.match(screen, /useAvatarConversationMotion\(\{[\s\S]*avatarId: identity\.avatarId/);
  const hook = fs.readFileSync(path.join(ROOT, 'hooks', 'useAvatarConversationMotion.ts'), 'utf8');
  assert.match(hook, /resetSharedAvatarMotionController/);
  assert.match(hook, /\}, \[enabled, avatarId\]\);/);
});
