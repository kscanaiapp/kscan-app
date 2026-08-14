const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');

function transpileModule(file, mocks = {}, extraGlobals = {}) {
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
    ...extraGlobals,
    require: (specifier) => {
      if (specifier in mocks) return mocks[specifier];
      throw new Error(`Unexpected import in ${file}: ${specifier}`);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename: sourcePath }).runInContext(sandbox);
  return mod.exports;
}

// ── Hook harness with effects and useSyncExternalStore ──────────────────────

function depsEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((value, index) => Object.is(value, b[index]));
}

function createHarness() {
  const slots = [];
  let cursor = 0;
  let pendingEffects = [];
  const record = { storeSubscribes: 0 };
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
        record.storeSubscribes += 1;
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
    }
  }

  return { react, render, unmount, record };
}

function idleSnapshot(overrides = {}) {
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

function loadHook({ flagEnabled = true } = {}) {
  const harness = createHarness();
  const contract = transpileModule('services/avatarMotionState.ts', {});
  const controllerModule = transpileModule('services/avatarMotionController.ts', {
    './avatarMotionState': contract,
  });
  controllerModule.resetSharedAvatarMotionControllerForTests();
  const motionStoreBox = {
    snapshot: idleSnapshot(),
    listeners: new Set(),
    subscribeCalls: 0,
  };
  const motionStoreMock = {
    getAvatarMotionSnapshot: () => motionStoreBox.snapshot,
    subscribeToAvatarMotion: (listener) => {
      motionStoreBox.subscribeCalls += 1;
      motionStoreBox.listeners.add(listener);
      return () => motionStoreBox.listeners.delete(listener);
    },
  };
  // The hook registers a motion reset with the service-owned AppState
  // lifecycle; this double records the registration without touching AppState.
  const lifecycleBox = { handlers: new Set(), ensureCalls: 0 };
  const lifecycleMock = {
    ensureAvatarSpeechLifecycleListener: () => {
      lifecycleBox.ensureCalls += 1;
    },
    registerAvatarInterruptionHandler: (handler) => {
      lifecycleBox.handlers.add(handler);
      return () => lifecycleBox.handlers.delete(handler);
    },
  };
  const hookModule = transpileModule('hooks/useAvatarConversationMotion.ts', {
    react: harness.react,
    '../constants/featureFlags': { AVATAR_MOTION_V1_ENABLED: flagEnabled },
    '../services/avatarMotionController': controllerModule,
    '../services/avatarMotionState': contract,
    '../services/avatarSpeechLifecycle': lifecycleMock,
    '../stores/avatarMotionStore': motionStoreMock,
  });
  const controller = controllerModule.getSharedAvatarMotionController();
  return { harness, hookModule, controllerModule, controller, motionStoreBox, lifecycleBox };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test('meaningful input engages listening after the anti-flicker hysteresis', async () => {
  const { harness, hookModule, controller } = loadHook();
  harness.render(hookModule.useAvatarConversationMotion, {
    inputActive: false,
    isSending: false,
    hysteresisMs: 0,
  });
  assert.equal(controller.getSnapshot().mode, 'idle');
  harness.render(hookModule.useAvatarConversationMotion, {
    inputActive: true,
    isSending: false,
    hysteresisMs: 0,
  });
  assert.equal(controller.getSnapshot().mode, 'idle', 'listening waits for the hysteresis');
  await tick();
  assert.equal(controller.getSnapshot().mode, 'listening');
});

test('a cancelled keystroke never flickers into listening', async () => {
  const { harness, hookModule, controller } = loadHook();
  harness.render(hookModule.useAvatarConversationMotion, {
    inputActive: true,
    isSending: false,
    hysteresisMs: 30,
  });
  // Input cleared before the hysteresis elapses: the pending timer must be
  // cancelled and the avatar stays idle.
  harness.render(hookModule.useAvatarConversationMotion, {
    inputActive: false,
    isSending: false,
    hysteresisMs: 30,
  });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(controller.getSnapshot().mode, 'idle');
});

test('sending enters thinking immediately with no hysteresis', () => {
  const { harness, hookModule, controller } = loadHook();
  harness.render(hookModule.useAvatarConversationMotion, {
    inputActive: false,
    isSending: true,
    hysteresisMs: 10_000,
  });
  assert.equal(controller.getSnapshot().mode, 'thinking');
});

test('a persisted response preparing audio remains thinking until playback starts', async () => {
  const { harness, hookModule, controller, motionStoreBox } = loadHook();
  motionStoreBox.snapshot = idleSnapshot({ phase: 'requesting', generation: 4 });
  harness.render(hookModule.useAvatarConversationMotion, {
    inputActive: false,
    isSending: false,
    hysteresisMs: 0,
  });
  assert.equal(controller.getSnapshot().mode, 'thinking', 'requesting reads as preparing-to-speak');
  motionStoreBox.snapshot = idleSnapshot({ phase: 'ready', generation: 4 });
  harness.render(hookModule.useAvatarConversationMotion, {
    inputActive: false,
    isSending: false,
    hysteresisMs: 0,
  });
  assert.equal(controller.getSnapshot().mode, 'thinking', 'ready audio still is not speaking');
  motionStoreBox.snapshot = idleSnapshot({
    phase: 'playing', generation: 4, speaking: true, mouth: 'halfOpen',
  });
  harness.render(hookModule.useAvatarConversationMotion, {
    inputActive: false,
    isSending: false,
    hysteresisMs: 0,
  });
  assert.equal(controller.getSnapshot().mode, 'speaking', 'native playing begins speaking');
  assert.equal(controller.getSnapshot().speaking, true);
});

test('playback completion and failure release smoothly to idle', async () => {
  const { harness, hookModule, controller, motionStoreBox } = loadHook();
  const props = { inputActive: false, isSending: false, hysteresisMs: 0 };
  motionStoreBox.snapshot = idleSnapshot({ phase: 'playing', generation: 2, speaking: true });
  harness.render(hookModule.useAvatarConversationMotion, props);
  assert.equal(controller.getSnapshot().mode, 'speaking');
  motionStoreBox.snapshot = idleSnapshot({ phase: 'idle', generation: 2 });
  harness.render(hookModule.useAvatarConversationMotion, props);
  await tick();
  assert.equal(controller.getSnapshot().mode, 'idle');

  motionStoreBox.snapshot = idleSnapshot({ phase: 'playing', generation: 3, speaking: true });
  harness.render(hookModule.useAvatarConversationMotion, props);
  motionStoreBox.snapshot = idleSnapshot({ phase: 'error', generation: 3 });
  harness.render(hookModule.useAvatarConversationMotion, props);
  await tick();
  assert.equal(controller.getSnapshot().mode, 'idle');
  assert.equal(controller.getSnapshot().expression, 'neutral', 'no disappointed expression');
});

test('typing during speech: interruption path yields listening, not a stuck speaking mode', async () => {
  const { harness, hookModule, controller, motionStoreBox } = loadHook();
  motionStoreBox.snapshot = idleSnapshot({ phase: 'playing', generation: 6, speaking: true });
  harness.render(hookModule.useAvatarConversationMotion, {
    inputActive: false, isSending: false, hysteresisMs: 0,
  });
  assert.equal(controller.getSnapshot().mode, 'speaking');
  // Typing stops speech at the service layer (existing behavior); the store
  // leaves playing and the composer holds text.
  motionStoreBox.snapshot = idleSnapshot({ phase: 'idle', generation: 7 });
  harness.render(hookModule.useAvatarConversationMotion, {
    inputActive: true, isSending: false, hysteresisMs: 0,
  });
  await tick();
  assert.equal(controller.getSnapshot().mode, 'listening');
});

test('flag off: no store subscription, no controller listeners, no mode changes', async () => {
  const { harness, hookModule, controller, motionStoreBox } = loadHook({ flagEnabled: false });
  const mode = harness.render(hookModule.useAvatarMotionMode, undefined);
  assert.equal(mode, 'idle');
  harness.render(hookModule.useAvatarConversationMotion, {
    inputActive: true,
    isSending: true,
    hysteresisMs: 0,
  });
  await tick();
  assert.equal(motionStoreBox.subscribeCalls, 0, 'no new motion subscription when disabled');
  assert.equal(controller.getListenerCountForTests(), 0);
  assert.equal(controller.getSnapshot().mode, 'idle');
});

test('unmount clears pending listening timers', async () => {
  const { harness, hookModule, controller } = loadHook();
  harness.render(hookModule.useAvatarConversationMotion, {
    inputActive: true,
    isSending: false,
    hysteresisMs: 20,
  });
  harness.unmount();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(controller.getSnapshot().mode, 'idle', 'no timer survives unmount');
});

test('screen and header wiring: signals in, listening state out, typing never waits', () => {
  const screen = fs.readFileSync(path.join(ROOT, 'app', 'style-chat', '[sessionId].tsx'), 'utf8');
  assert.match(screen, /useAvatarConversationMotion\(\{/);
  assert.match(screen, /inputActive: composerText\.trim\(\)\.length > 0/);
  assert.match(screen, /isSending,/);
  // Typing interruption is synchronous and precedes any motion scheduling.
  assert.match(screen, /next\.trim\(\)\.length > 0[\s\S]*stopAvatarSpeechPlayback/);
  const header = fs.readFileSync(
    path.join(ROOT, 'components', 'style-chat', 'StyleChatHeader.tsx'),
    'utf8',
  );
  assert.match(header, /useAvatarMotionMode/);
  assert.match(header, /conversationMode === 'listening'/);
  assert.match(header, /conversationMode === 'thinking'/);
  // No hardcoded arbitrary delay: the hysteresis comes from the policy.
  const hook = fs.readFileSync(path.join(ROOT, 'hooks', 'useAvatarConversationMotion.ts'), 'utf8');
  assert.match(hook, /MOTION_TRANSITION_POLICY\.listeningHysteresisMs/);
  assert.doesNotMatch(hook, /500/);
});
