// A minimal, dependency-free React hook runtime for behavioural hook tests.
//
// This exists so Elise's conversation invariants can be proven by EXECUTING
// hooks/useStyleChat.ts rather than by matching its source text. It is test
// infrastructure, not a stand-in for the subject: the hook body under test is
// the real, transpiled module, and every dependency it reaches is an injected
// observer.
//
// It implements the subset the Elise hooks use — useState, useRef, useCallback,
// useMemo, useEffect — with real dependency comparison and re-render-until-quiet
// semantics, which is what makes "did a late completion mutate anything after
// the actor changed?" an observable question here.

function sameDeps(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (!Object.is(a[i], b[i])) return false;
  }
  return true;
}

function createHookRuntime() {
  const states = [];
  const refs = [];
  const memos = [];
  const callbacks = [];
  const effects = [];
  let stateIndex = 0;
  let refIndex = 0;
  let memoIndex = 0;
  let callbackIndex = 0;
  let effectIndex = 0;
  let dirty = false;
  let renders = 0;

  const react = {
    useState(initial) {
      const i = stateIndex;
      stateIndex += 1;
      if (states.length <= i) {
        states[i] = { value: typeof initial === 'function' ? initial() : initial };
      }
      const slot = states[i];
      const setter = (next) => {
        const resolved = typeof next === 'function' ? next(slot.value) : next;
        if (!Object.is(resolved, slot.value)) {
          slot.value = resolved;
          dirty = true;
        }
      };
      return [slot.value, setter];
    },
    useRef(initial) {
      const i = refIndex;
      refIndex += 1;
      if (refs.length <= i) refs[i] = { current: initial };
      return refs[i];
    },
    useMemo(factory, deps) {
      const i = memoIndex;
      memoIndex += 1;
      const prev = memos[i];
      if (prev && sameDeps(prev.deps, deps)) return prev.value;
      const value = factory();
      memos[i] = { value, deps };
      return value;
    },
    useCallback(fn, deps) {
      const i = callbackIndex;
      callbackIndex += 1;
      const prev = callbacks[i];
      if (prev && sameDeps(prev.deps, deps)) return prev.fn;
      callbacks[i] = { fn, deps };
      return fn;
    },
    useEffect(fn, deps) {
      const i = effectIndex;
      effectIndex += 1;
      const prev = effects[i];
      if (prev && sameDeps(prev.deps, deps)) return;
      effects[i] = { fn, deps, pending: true, cleanup: prev ? prev.cleanup : undefined };
    },
  };

  function beginRender() {
    stateIndex = 0;
    refIndex = 0;
    memoIndex = 0;
    callbackIndex = 0;
    effectIndex = 0;
    renders += 1;
  }

  function flushEffects() {
    for (const effect of effects) {
      if (!effect || !effect.pending) continue;
      effect.pending = false;
      if (typeof effect.cleanup === 'function') {
        const cleanup = effect.cleanup;
        effect.cleanup = undefined;
        cleanup();
      }
      const cleanup = effect.fn();
      effect.cleanup = typeof cleanup === 'function' ? cleanup : undefined;
    }
  }

  function unmount() {
    for (const effect of effects) {
      if (effect && typeof effect.cleanup === 'function') {
        const cleanup = effect.cleanup;
        effect.cleanup = undefined;
        cleanup();
      }
    }
  }

  return {
    react,
    beginRender,
    flushEffects,
    unmount,
    get dirty() {
      return dirty;
    },
    clearDirty() {
      dirty = false;
    },
    get renderCount() {
      return renders;
    },
  };
}

/** Let every pending microtask and timer callback settle. */
async function settle(times = 6) {
  for (let i = 0; i < times; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    await Promise.resolve();
  }
}

/**
 * Render a hook and keep re-rendering until its state stops changing, exactly
 * as React would, then return the latest result plus controls.
 */
async function renderHook(hook, getArgs) {
  const runtime = createHookRuntime();
  let result;

  const renderOnce = () => {
    runtime.beginRender();
    result = hook(...getArgs());
    runtime.flushEffects();
  };

  renderOnce();
  for (let i = 0; i < 30; i += 1) {
    await settle(2);
    if (!runtime.dirty) break;
    runtime.clearDirty();
    renderOnce();
  }

  return {
    get current() {
      return result;
    },
    async flush(cycles = 12) {
      for (let i = 0; i < cycles; i += 1) {
        await settle(2);
        if (runtime.dirty) {
          runtime.clearDirty();
          renderOnce();
        }
      }
    },
    rerender: renderOnce,
    unmount: runtime.unmount,
    runtime,
  };
}

module.exports = { createHookRuntime, renderHook, settle };
