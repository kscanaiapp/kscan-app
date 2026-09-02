/**
 * Idle presence ticker — lifecycle firewall.
 *
 * This timer exists to make an otherwise-still photograph breathe. That makes
 * it a battery liability, so what is actually asserted here is not that it
 * runs, but that it STOPS: on unmount, on background, on blur, and under
 * Reduce Motion. A timer left alive because StyleChat still exists somewhere
 * in the navigation tree is the failure mode this suite is for.
 *
 * The hook is exercised through a miniature React runtime rather than a
 * renderer: the repository has no React test renderer, and the properties that
 * matter — how many intervals exist, when they are cleared — are properties of
 * the effect graph, not of the output tree.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');

// -- A minimal hooks runtime --------------------------------------------------

function createHost() {
  const timers = new Map();
  let nextTimerId = 1;
  const appStateListeners = new Set();

  const host = {
    liveTimers: () => timers.size,
    totalTimersCreated: 0,
    appStateListeners: () => appStateListeners.size,
    currentAppState: 'active',
    advance(times = 1) {
      for (let i = 0; i < times; i += 1) {
        for (const fn of [...timers.values()]) fn();
      }
    },
    emitAppState(status) {
      host.currentAppState = status;
      for (const fn of [...appStateListeners]) fn(status);
    },
    modules: {
      react: null, // filled below
      'react-native': {
        get AppState() {
          return {
            get currentState() {
              return host.currentAppState;
            },
            addEventListener(_event, handler) {
              appStateListeners.add(handler);
              return { remove: () => appStateListeners.delete(handler) };
            },
          };
        },
      },
      '@react-navigation/native': {
        useIsFocused: () => host.focused,
      },
    },
    focused: true,
    setInterval(fn, _ms) {
      const id = nextTimerId;
      nextTimerId += 1;
      host.totalTimersCreated += 1;
      timers.set(id, fn);
      return id;
    },
    clearInterval(id) {
      timers.delete(id);
    },
  };
  return host;
}

/**
 * Enough of React's hook semantics to observe effect setup/teardown ordering:
 * state, refs, and effects with dependency comparison and cleanup.
 */
function createReactShim(host) {
  let hooks = [];
  let cursor = 0;
  let renderFn = null;
  let scheduled = false;
  let mounted = false;

  const flush = () => {
    scheduled = false;
    if (mounted) run();
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(flush);
  };

  function run() {
    cursor = 0;
    const result = renderFn();
    // Effects run after the render pass, in declaration order.
    for (const hook of hooks) {
      if (hook.kind !== 'effect' || !hook.dirty) continue;
      hook.dirty = false;
      if (hook.cleanup) hook.cleanup();
      hook.cleanup = hook.setup() || null;
    }
    return result;
  }

  const React = {
    useState(initial) {
      const index = cursor;
      cursor += 1;
      if (!hooks[index]) {
        hooks[index] = {
          kind: 'state',
          value: typeof initial === 'function' ? initial() : initial,
        };
      }
      const hook = hooks[index];
      const set = (next) => {
        const value = typeof next === 'function' ? next(hook.value) : next;
        if (Object.is(value, hook.value)) return;
        hook.value = value;
        schedule();
      };
      return [hook.value, set];
    },
    useRef(initial) {
      const index = cursor;
      cursor += 1;
      if (!hooks[index]) hooks[index] = { kind: 'ref', value: { current: initial } };
      return hooks[index].value;
    },
    useEffect(setup, deps) {
      const index = cursor;
      cursor += 1;
      const prior = hooks[index];
      const changed =
        !prior ||
        !prior.deps ||
        !deps ||
        deps.length !== prior.deps.length ||
        deps.some((d, i) => !Object.is(d, prior.deps[i]));
      if (!prior) {
        hooks[index] = { kind: 'effect', setup, deps, cleanup: null, dirty: true };
      } else {
        prior.setup = setup;
        prior.deps = deps;
        if (changed) prior.dirty = true;
      }
    },
  };

  return {
    React,
    mount(fn) {
      renderFn = fn;
      hooks = [];
      mounted = true;
      return run();
    },
    rerender: () => run(),
    async settle() {
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    },
    unmount() {
      mounted = false;
      for (const hook of hooks) {
        if (hook.kind === 'effect' && hook.cleanup) hook.cleanup();
      }
      hooks = [];
    },
  };
}

function loadHook(host, React) {
  const file = path.join(ROOT, 'hooks', 'useAvatarIdlePresence.ts');
  const { outputText } = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: file,
  });
  const module = { exports: {} };
  const require_ = (specifier) => {
    if (specifier === 'react') return React;
    const found = host.modules[specifier];
    if (!found) throw new Error(`unexpected dependency: ${specifier}`);
    return found;
  };
  new Function('require', 'module', 'exports', 'setInterval', 'clearInterval', outputText)(
    require_,
    module,
    module.exports,
    host.setInterval,
    host.clearInterval,
  );
  return module.exports;
}

function harness(initialProps = { enabled: true }) {
  const host = createHost();
  const shim = createReactShim(host);
  host.modules.react = shim.React;
  const hook = loadHook(host, shim.React);
  let props = initialProps;
  let last = 0;
  shim.mount(() => {
    last = hook.useAvatarIdlePresence(props);
    return last;
  });
  return {
    host,
    shim,
    hook,
    tick: () => last,
    setProps(next) {
      props = next;
      shim.rerender();
    },
  };
}

// -- Tests --------------------------------------------------------------------

test('the ticker advances the clock while idle, focused and foregrounded', async () => {
  const h = harness();
  assert.equal(h.host.liveTimers(), 1, 'exactly one timer while running');
  const before = h.tick();
  h.host.advance(3);
  await h.shim.settle();
  assert.ok(h.tick() > before, 'the tick value must advance so the host clock moves');
});

test('the cadence is 2 Hz — presence, not animation', () => {
  const h = harness();
  assert.equal(h.hook.AVATAR_IDLE_TICK_MS, 500);
  // Explicitly far from the 80ms speech tick. Drifting toward it would turn a
  // presence heartbeat into a general-purpose animation loop.
  assert.ok(h.hook.AVATAR_IDLE_TICK_MS >= 250 && h.hook.AVATAR_IDLE_TICK_MS <= 500);
});

test('it stops on unmount and leaves nothing behind', () => {
  const h = harness();
  assert.equal(h.host.liveTimers(), 1);
  h.shim.unmount();
  assert.equal(h.host.liveTimers(), 0, 'a timer survived unmount');
  assert.equal(h.host.appStateListeners(), 0, 'an AppState subscription survived unmount');
});

test('it stops when the app backgrounds and resumes on return', async () => {
  const h = harness();
  assert.equal(h.host.liveTimers(), 1);
  h.host.emitAppState('background');
  await h.shim.settle();
  assert.equal(h.host.liveTimers(), 0, 'the timer kept running in the background');
  h.host.emitAppState('active');
  await h.shim.settle();
  assert.equal(h.host.liveTimers(), 1, 'the timer did not resume on foreground');
});

test("iOS 'inactive' counts as background", async () => {
  const h = harness();
  h.host.emitAppState('inactive');
  await h.shim.settle();
  assert.equal(h.host.liveTimers(), 0);
});

test('it stops when the route loses focus, even though StyleChat is still mounted', async () => {
  const h = harness();
  assert.equal(h.host.liveTimers(), 1);
  h.host.focused = false;
  h.shim.rerender();
  await h.shim.settle();
  assert.equal(h.host.liveTimers(), 0, 'an unfocused route kept waking the JS thread');
});

test('Reduce Motion stops the ticker outright', async () => {
  const h = harness({ enabled: true });
  assert.equal(h.host.liveTimers(), 1);
  h.setProps({ enabled: false });
  await h.shim.settle();
  assert.equal(h.host.liveTimers(), 0, 'Reduce Motion must not leave a motion timer running');
});

test('speech and idle never drive the clock at the same time', async () => {
  // The host disables the ticker while speaking, because playback progress is
  // already re-rendering the header. Two drivers on one channel is the
  // oscillation this separation exists to prevent.
  const h = harness({ enabled: true });
  h.setProps({ enabled: false }); // begins speaking
  await h.shim.settle();
  assert.equal(h.host.liveTimers(), 0);
  h.setProps({ enabled: true }); // speech ends
  await h.shim.settle();
  assert.equal(h.host.liveTimers(), 1);
});

test('NEGATIVE CONTROL: repeated focus, background and enable cycles create no duplicate timers', async () => {
  const h = harness();

  for (let i = 0; i < 6; i += 1) {
    h.host.focused = false;
    h.shim.rerender();
    await h.shim.settle();
    h.host.focused = true;
    h.shim.rerender();
    await h.shim.settle();

    h.host.emitAppState('background');
    await h.shim.settle();
    h.host.emitAppState('active');
    await h.shim.settle();

    h.setProps({ enabled: false });
    await h.shim.settle();
    h.setProps({ enabled: true });
    await h.shim.settle();

    assert.equal(h.host.liveTimers(), 1, `duplicate timer after cycle ${i + 1}`);
  }

  h.shim.unmount();
  assert.equal(h.host.liveTimers(), 0);
  assert.equal(h.host.appStateListeners(), 0);
});

test('NEGATIVE CONTROL: repeated mount/unmount leaks neither timers nor subscriptions', () => {
  for (let i = 0; i < 5; i += 1) {
    const h = harness();
    assert.equal(h.host.liveTimers(), 1);
    assert.equal(h.host.appStateListeners(), 1);
    h.shim.unmount();
    assert.equal(h.host.liveTimers(), 0);
    assert.equal(h.host.appStateListeners(), 0);
  }
});

test('an idle render does no work beyond advancing a counter', () => {
  const source = fs.readFileSync(path.join(ROOT, 'hooks', 'useAvatarIdlePresence.ts'), 'utf8');
  // No engine call, no store mutation, no network, no timeline work, no image
  // work — the tick must be the cheapest possible render trigger.
  assert.doesNotMatch(source, /computeFrame|compileSpeechTimeline|avatarSpeechStore|speakAvatarMessage/);
  assert.doesNotMatch(source, /fetch\(|supabase|functions\.invoke/);
  assert.doesNotMatch(source, /Image|require\(/);
  assert.doesNotMatch(source, /expo-audio/);
  // Only React, React Native and navigation focus.
  const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(imports, ['@react-navigation/native', 'react', 'react-native']);
});

test('the header disables the ticker while speaking and under Reduce Motion', () => {
  const header = fs.readFileSync(
    path.join(ROOT, 'components', 'style-chat', 'StyleChatHeader.tsx'),
    'utf8',
  );
  assert.match(header, /useAvatarIdlePresence\(\{\s*enabled:\s*!reducedMotion\s*&&\s*!isSpeaking\s*\}\)/);
  // The tick must actually reach the memo, or the clock still would not move.
  const deps = header.match(/\}, \[[\s\S]*?idleTick,[\s\S]*?\]\);/);
  assert.ok(deps, 'idleTick must be a dependency of the engine frame memo');
});
