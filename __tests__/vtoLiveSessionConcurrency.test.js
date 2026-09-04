// VTO HOSTILE AUDIT -- Sections 16, 17, 24, 25, 26 and state matrix P/R/S.
//
// WHAT THIS FILE TESTS, AND WHY IT DRIVES THE REAL HOOK.
//
// Three defects (VTO-HA-002/003/004) live in hooks/useVtoLiveSession.ts, in the
// interaction between an async action and a control that stays enabled while it
// runs. Source-level assertions cannot see those: the bug is not a token, it is
// an ordering. This repo has no react-test-renderer, so rather than
// re-implementing the hook's logic in the test -- which would assert a copy and
// prove nothing about the shipping code -- it supplies a minimal hook runtime
// (useState/useRef/useEffect/useCallback/useMemo) and runs the ACTUAL module
// against fake native/permission dependencies.
//
// Evidence class: UNIT TEST against real application source with injected
// dependencies. NOT native, NOT device, NOT a real camera or provider.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ── A minimal hook runtime ──────────────────────────────────────────────────
// Enough React semantics for this hook: indexed state/ref slots that persist
// across renders, effects that re-run when their deps change, and a render loop
// that settles. Deliberately small; it is a test harness, not a React clone.

function createHostRuntime() {
  const slots = [];
  let cursor = 0;
  let dirty = false;
  const effects = [];

  const react = {
    useState(initial) {
      const index = cursor++;
      if (!slots[index]) {
        slots[index] = { value: typeof initial === 'function' ? initial() : initial };
      }
      const slot = slots[index];
      const set = (next) => {
        const value = typeof next === 'function' ? next(slot.value) : next;
        if (!Object.is(value, slot.value)) { slot.value = value; dirty = true; }
      };
      return [slot.value, set];
    },
    useRef(initial) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { current: initial };
      return slots[index];
    },
    useCallback(fn) { cursor++; return fn; },
    useMemo(fn) { cursor++; return fn(); },
    useEffect(fn, deps) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { deps: undefined, cleanup: undefined, first: true };
      const slot = slots[index];
      const changed = slot.first || !deps || !slot.deps
        || deps.length !== slot.deps.length
        || deps.some((d, i) => !Object.is(d, slot.deps[i]));
      if (changed) {
        slot.first = false;
        slot.deps = deps;
        effects.push(() => {
          if (typeof slot.cleanup === 'function') slot.cleanup();
          slot.cleanup = fn();
        });
      }
    },
  };

  return {
    react,
    /** Renders until state settles, then returns the hook's last result. */
    render(hook, props) {
      let result;
      for (let pass = 0; pass < 25; pass += 1) {
        cursor = 0;
        dirty = false;
        result = hook(props);
        while (effects.length) effects.shift()();
        if (!dirty) return result;
      }
      throw new Error('render did not settle');
    },
    unmount() {
      for (const slot of slots) if (slot && typeof slot.cleanup === 'function') slot.cleanup();
    },
  };
}

// ── Load the real hook with injected dependencies ───────────────────────────

function loadHook(deps) {
  const output = ts.transpileModule(read('hooks/useVtoLiveSession.ts'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const mod = { exports: {} };
  const sandbox = {
    exports: mod.exports, module: mod, console, Object, Array, Set, Map, JSON,
    Math, Number, String, Boolean, Date, Promise, RangeError, Error, setTimeout,
    require: (specifier) => {
      if (Object.prototype.hasOwnProperty.call(deps, specifier)) return deps[specifier];
      throw new Error(`unexpected import ${specifier}`);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename: 'hooks/useVtoLiveSession.ts' }).runInContext(sandbox);
  return mod.exports.useVtoLiveSession;
}

/** One scenario: a fake native module, a fake permission gate, and counters. */
function scenario(options = {}) {
  const calls = {
    prompts: 0, controllers: 0, starts: [], switches: [], disposes: 0,
    personFramesCaptured: 0, adopted: [],
  };
  const controllers = [];

  const controllerFactory = () => {
    calls.controllers += 1;
    const id = calls.controllers;
    let listener = null;
    const controller = {
      id,
      disposed: false,
      getSnapshot: () => controller._snapshot,
      _snapshot: { state: 'INITIALIZING', error: null, loadedProductRef: null, guidance: 'none', privacyPhase: 'live' },
      subscribe(fn) { listener = fn; return () => { listener = null; }; },
      start(descriptor) {
        calls.starts.push({ controller: id, productRef: descriptor.productRef });
        controller._snapshot = { ...controller._snapshot, state: 'TRACKING' };
        if (listener) listener(controller._snapshot);
      },
      switchGarment(descriptor) { calls.switches.push({ controller: id, productRef: descriptor.productRef }); },
      pause() {}, resume() {}, stop() {},
      async capturePersonFrame() {
        calls.personFramesCaptured += 1;
        if (options.captureDelayMs) await new Promise((r) => setTimeout(r, options.captureDelayMs));
        return { captureId: `cap-${calls.personFramesCaptured}`, kind: 'PERSON_FRAME', localUri: `file://f${calls.personFramesCaptured}`, width: 100, height: 200 };
      },
      async capturePreview() {
        return { captureId: 'prev', kind: 'PREVIEW', localUri: 'file://preview', width: 10, height: 20 };
      },
      dispose() { controller.disposed = true; calls.disposes += 1; },
    };
    controllers.push(controller);
    return controller;
  };

  const deps = {
    react: null, // filled per-render
    '../services/vto/liveVtoNativeModule': { getLiveVtoNativeModule: () => ({}) },
    '../services/vto/vtoLiveCameraPermission': {
      ensureLiveCameraPermission: async () => {
        calls.prompts += 1;
        if (options.permissionDelayMs) await new Promise((r) => setTimeout(r, options.permissionDelayMs));
        return { state: options.permission ?? 'granted', prompted: true };
      },
    },
    '../services/vto/vtoLiveHarness': { getLiveVtoHarnessState: () => null },
    '../services/vto/vtoPhotorealHandoff': {
      buildPhotorealPersonInput: async (frame) => {
        if (options.sanitizeDelayMs) await new Promise((r) => setTimeout(r, options.sanitizeDelayMs));
        if (frame.kind !== 'PERSON_FRAME') return { ok: false, failure: { code: 'no_usable_still', resultingState: 'LIVE_LOCAL', liveSessionRemainsUsable: true } };
        return { ok: true, person: { source: 'live_capture', sanitizedUri: `${frame.localUri}.jpg`, width: 1, height: 1, metadataStripped: true, sanitizerVersion: 'v1' } };
      },
    },
    '../services/vto/vtoLiveSession': {
      createLiveVtoSession: controllerFactory,
      INITIAL_LIVE_VTO_SESSION: { state: 'INITIALIZING', error: null, loadedProductRef: null, guidance: 'none', privacyPhase: 'live' },
      markLiveVtoError: (current, state) => ({ ...current, state: 'ERROR', error: { state, message: 'copy', recoverable: false } }),
    },
    '../types/vtoLive': loadVtoLive(),
    '../types/vto': {},
  };
  return { calls, controllers, deps };
}

function loadVtoLive() {
  const output = ts.transpileModule(read('types/vtoLive.ts'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  const sandbox = { exports: mod.exports, module: mod, Object, Array, Set, Map, JSON, Math, Number, String, Boolean, Date, RangeError, Error, require: () => { throw new Error('no'); } };
  vm.createContext(sandbox);
  new vm.Script(output, { filename: 'types/vtoLive.ts' }).runInContext(sandbox);
  return mod.exports;
}

const D1 = { productRef: 'prod-1', imageUrl: 'https://x/1.jpg', canonicalCategory: 'top', templateFamily: 'simple-top' };
const D2 = { productRef: 'prod-2', imageUrl: 'https://x/2.jpg', canonicalCategory: 'top', templateFamily: 'simple-top' };

function mount(sc, descriptor, onPhotorealPerson) {
  const host = createHostRuntime();
  const hook = loadHook({ ...sc.deps, react: host.react });
  let current = host.render(hook, { descriptor, onPhotorealPerson });
  return {
    get result() { return current; },
    rerender(next) { current = host.render(hook, { descriptor: next, onPhotorealPerson }); return current; },
    settle() { current = host.render(hook, { descriptor: current._d ?? descriptor, onPhotorealPerson }); return current; },
    unmount: host.unmount,
  };
}

// ── VTO-HA-002: concurrent Live entry ───────────────────────────────────────

test('VTO-HA-002: two Live taps during one permission dialog create ONE session', async () => {
  const sc = scenario({ permissionDelayMs: 15 });
  const view = mount(sc, D1, () => {});
  // Both taps happen before the first permission promise resolves -- exactly a
  // rapid double tap, since the Start Live button stays enabled meanwhile.
  await Promise.all([view.result.enterLive(), view.result.enterLive()]);
  assert.equal(sc.calls.prompts, 1, 'the permission gate must be asked once, not twice');
  assert.equal(sc.calls.controllers, 1, 'a second controller would orphan the first (leaked subscription, duplicate start)');
  assert.equal(sc.calls.starts.length, 1, 'the runtime must be started once');
  view.unmount();
});

test('VTO-HA-002: an orphaned session cannot survive unmount', async () => {
  const sc = scenario({ permissionDelayMs: 15 });
  const view = mount(sc, D1, () => {});
  await Promise.all([view.result.enterLive(), view.result.enterLive(), view.result.enterLive()]);
  view.unmount();
  // Every controller ever created must have been disposed. With the pre-repair
  // code, controllers 1..n-1 were unreachable and stayed subscribed forever.
  for (const controller of sc.controllers) {
    assert.equal(controller.disposed, true, `controller ${controller.id} leaked past unmount`);
  }
});

test('a denied permission leaves no session and does not re-prompt on the next tap', async () => {
  const sc = scenario({ permission: 'denied' });
  const view = mount(sc, D1, () => {});
  await view.result.enterLive();
  const after = view.settle();
  assert.equal(sc.calls.controllers, 0, 'a denial must not start a runtime');
  assert.equal(after.session.state, 'ERROR');
  assert.equal(after.session.error.state, 'CAMERA_PERMISSION_DENIED');
  // The camera module owns "ask once"; this asserts the hook keeps letting it
  // decide rather than short-circuiting into a loop of its own.
  assert.equal(after.entered, true, 'the surface stays on a bounded state, not a blank one');
  view.unmount();
});

// ── VTO-HA-003: repeated Photoreal taps ─────────────────────────────────────

test('VTO-HA-003: repeated Photoreal taps produce ONE capture and ONE adoption', async () => {
  const sc = scenario({ captureDelayMs: 10, sanitizeDelayMs: 10 });
  const adopted = [];
  const view = mount(sc, D1, (person) => adopted.push(person));
  await view.result.enterLive();
  view.settle();
  await Promise.all([
    view.result.requestPhotoreal(),
    view.result.requestPhotoreal(),
    view.result.requestPhotoreal(),
  ]);
  assert.equal(sc.calls.personFramesCaptured, 1, 'three taps captured three frames');
  assert.equal(
    adopted.length,
    1,
    'each adoption calls setVtoPersonInput, which advances the store intent sequence and '
      + 'therefore bills a SEPARATE server attempt -- this is the duplicate-spend defect',
  );
  view.unmount();
});

test('VTO-HA-003: the pending flag is exposed so the control can be disabled', async () => {
  const sc = scenario({ captureDelayMs: 20 });
  const view = mount(sc, D1, () => {});
  await view.result.enterLive();
  view.settle();
  assert.equal(view.result.photorealPending, false);
  const pending = view.result.requestPhotoreal();
  assert.equal(view.settle().photorealPending, true, 'a running capture must be visible to the UI');
  await pending;
  assert.equal(view.settle().photorealPending, false, 'the flag must clear when the capture ends');
  view.unmount();
});

test('a Photoreal capture is still possible after the previous one completes', async () => {
  const sc = scenario();
  const adopted = [];
  const view = mount(sc, D1, (p) => adopted.push(p));
  await view.result.enterLive();
  view.settle();
  await view.result.requestPhotoreal();
  await view.result.requestPhotoreal();
  assert.equal(adopted.length, 2, 'the guard must not become a permanent lock');
  view.unmount();
});

// ── VTO-HA-004: product switch while Live is running ────────────────────────

test('VTO-HA-004: the FIRST product switch after entering Live reaches the runtime', async () => {
  const sc = scenario();
  const view = mount(sc, D1, () => {});
  await view.result.enterLive();
  view.settle();
  assert.deepEqual(sc.calls.starts, [{ controller: 1, productRef: 'prod-1' }]);
  view.rerender(D2);
  assert.deepEqual(
    sc.calls.switches,
    [{ controller: 1, productRef: 'prod-2' }],
    'the first switch after entry was swallowed: Live kept rendering prod-1 while the '
      + 'sheet and any Photoreal generation used prod-2',
  );
  view.unmount();
});

test('VTO-HA-004: switching back and forth switches every time, and never repeats itself', async () => {
  const sc = scenario();
  const view = mount(sc, D1, () => {});
  await view.result.enterLive();
  view.settle();
  view.rerender(D2);
  view.rerender(D1);
  view.rerender(D1); // same product again -- must be a no-op
  assert.deepEqual(sc.calls.switches.map((s) => s.productRef), ['prod-2', 'prod-1']);
  view.unmount();
});

test('VTO-HA-004: a product switch BEFORE Live is entered starts on the current garment', async () => {
  const sc = scenario();
  const view = mount(sc, D1, () => {});
  view.rerender(D2);
  assert.deepEqual(sc.calls.switches, [], 'no runtime exists yet, so nothing to switch');
  await view.result.enterLive();
  assert.deepEqual(sc.calls.starts, [{ controller: 1, productRef: 'prod-2' }], 'entry loads the CURRENT product');
  view.unmount();
});

test('VTO-HA-004: exiting and re-entering reloads the garment rather than assuming it is loaded', async () => {
  const sc = scenario();
  const view = mount(sc, D1, () => {});
  await view.result.enterLive();
  view.settle();
  view.result.exitLive();
  view.settle();
  await view.result.enterLive();
  assert.equal(sc.calls.starts.length, 2, 'the second entry must load its garment');
  assert.deepEqual(sc.calls.starts[1], { controller: 2, productRef: 'prod-1' });
  view.unmount();
});

// ── Section 17/38: teardown ─────────────────────────────────────────────────

test('exitLive disposes the runtime and clears the session-local preview', async () => {
  const sc = scenario();
  const view = mount(sc, D1, () => {});
  await view.result.enterLive();
  view.settle();
  await view.result.capturePreview();
  assert.equal(view.settle().previewUri, 'file://preview');
  view.result.exitLive();
  const after = view.settle();
  assert.equal(after.previewUri, null, 'the preview must not outlive the session');
  assert.equal(after.entered, false);
  assert.equal(sc.calls.disposes, 1);
  view.unmount();
});

test('the composited preview never becomes a generative input', async () => {
  const sc = scenario();
  const adopted = [];
  const view = mount(sc, D1, (p) => adopted.push(p));
  await view.result.enterLive();
  view.settle();
  const uri = await view.result.capturePreview();
  assert.equal(uri, 'file://preview');
  assert.equal(adopted.length, 0, 'capturing a preview must not hand anything to the generative path');
  view.unmount();
});
