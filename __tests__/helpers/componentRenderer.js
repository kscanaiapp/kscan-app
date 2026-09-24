'use strict';

/**
 * Test infrastructure: EXECUTE real .tsx modules and inspect the element tree.
 *
 * Several defects in this app are about WHERE an element sits in the tree (which
 * native <Modal> it is mounted under), and a substring search cannot answer that.
 * This file lets a test transpile the real component, run it against a stubbed
 * module graph, and ask questions of the rendered tree.
 *
 * It is a helper, not a test: scripts/run-all-tests.js discovers `*.test.js`
 * only, so nothing here runs on its own.
 *
 * What it implements, deliberately small:
 *   - function components with useState / useRef / useMemo / useCallback /
 *     useEffect / useContext, re-rendered until the tree settles;
 *   - createContext with a real nearest-Provider rule (the reason it exists: a
 *     nested provider must win over an outer one, and that is the behaviour
 *     under test);
 *   - a STRICT require shim: an import the test did not stub throws, so a new
 *     dependency added to a component is visible instead of silently stubbed;
 *   - mutation controls that REFUSE to run vacuously.
 *
 * What it does not implement: host rendering, layout, class components, effect
 * cleanup on unmount. Anything that depends on those needs a device.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..', '..');

// React Native always defines __DEV__, and modules under test read it at call time
// (a bare `if (__DEV__)`), not only at load. Node does not define it.
if (typeof globalThis.__DEV__ === 'undefined') globalThis.__DEV__ = false;

// ── Renderer ────────────────────────────────────────────────────────────────

function sameDeps(left, right) {
  return Boolean(
    left &&
      right &&
      left.length === right.length &&
      left.every((value, index) => Object.is(value, right[index])),
  );
}

function toArray(rendered) {
  if (rendered === null || rendered === undefined) return [];
  return Array.isArray(rendered) ? rendered : [rendered];
}

function createRenderer() {
  const registry = new Map();
  let active = null;
  let dirty = false;

  function slotsFor(id) {
    let entry = registry.get(id);
    if (!entry) {
      entry = { slots: [], cursor: 0, queued: [] };
      registry.set(id, entry);
    }
    return entry;
  }

  function createContext(defaultValue) {
    const context = { stack: [defaultValue] };
    function Provider() {
      return null;
    }
    Provider.contextRef = context;
    context.Provider = Provider;
    return context;
  }

  const react = {
    useState(initial) {
      const entry = active;
      const index = entry.cursor++;
      if (!entry.slots[index]) {
        const slot = { value: typeof initial === 'function' ? initial() : initial };
        slot.set = (next) => {
          const resolved = typeof next === 'function' ? next(slot.value) : next;
          if (!Object.is(resolved, slot.value)) {
            slot.value = resolved;
            dirty = true;
          }
        };
        entry.slots[index] = slot;
      }
      return [entry.slots[index].value, entry.slots[index].set];
    },
    useRef(initial) {
      const entry = active;
      const index = entry.cursor++;
      if (!entry.slots[index]) entry.slots[index] = { value: { current: initial } };
      return entry.slots[index].value;
    },
    useMemo(factory, deps) {
      const entry = active;
      const index = entry.cursor++;
      const previous = entry.slots[index];
      if (!previous || !sameDeps(previous.deps, deps)) {
        entry.slots[index] = { value: factory(), deps };
      }
      return entry.slots[index].value;
    },
    useCallback(callback, deps) {
      const entry = active;
      const index = entry.cursor++;
      const previous = entry.slots[index];
      if (!previous || !sameDeps(previous.deps, deps)) {
        entry.slots[index] = { value: callback, deps };
      }
      return entry.slots[index].value;
    },
    useEffect(effect, deps) {
      const entry = active;
      const index = entry.cursor++;
      const previous = entry.slots[index];
      if (!previous || !sameDeps(previous.deps, deps)) {
        entry.queued.push({ index, effect, deps, cleanup: previous?.cleanup });
      }
    },
    useContext(context) {
      return context.stack[context.stack.length - 1];
    },
    createContext,
    Fragment: 'Fragment',
  };
  react.useLayoutEffect = react.useEffect;

  function renderNode(element, id) {
    if (element === null || element === undefined || typeof element === 'boolean') return null;
    if (Array.isArray(element)) {
      return element
        .map((child, index) => renderNode(child, `${id}[${index}]`))
        .flatMap((node) => toArray(node));
    }
    if (typeof element !== 'object') {
      return { type: '#text', name: '#text', props: {}, value: element, children: [] };
    }
    const { type, props, key } = element;

    if (typeof type === 'function' && type.contextRef) {
      const context = type.contextRef;
      context.stack.push(props.value);
      let rendered;
      try {
        rendered = renderNode(props.children, `${id}/Provider:${key ?? ''}`);
      } finally {
        context.stack.pop();
      }
      return { type, name: 'Context.Provider', props: props ?? {}, children: toArray(rendered) };
    }

    if (typeof type === 'function') {
      const childId = `${id}/${type.name || 'anon'}:${key ?? ''}`;
      const entry = slotsFor(childId);
      const previous = active;
      active = entry;
      entry.cursor = 0;
      entry.queued = [];
      const output = type(props ?? {});
      const pending = entry.queued;
      entry.queued = [];
      for (const effect of pending) {
        if (typeof effect.cleanup === 'function') effect.cleanup();
        const cleanup = effect.effect();
        entry.slots[effect.index] = {
          deps: effect.deps,
          cleanup: typeof cleanup === 'function' ? cleanup : undefined,
        };
      }
      active = previous;
      return {
        type,
        name: type.name,
        props: props ?? {},
        children: toArray(renderNode(output, childId)),
      };
    }

    return {
      type,
      name: typeof type === 'string' ? type : String(type),
      props: props ?? {},
      children: toArray(renderNode(props?.children, `${id}/${String(type)}:${key ?? ''}`)),
    };
  }

  return {
    react,
    jsx: (type, props, key) => ({ type, props: props ?? {}, key: key ?? null }),
    /** The two modules a `jsx: ReactJSX` transpile asks for, ready to spread into a require map. */
    get runtimeModules() {
      return {
        react: { ...react, default: react },
        'react/jsx-runtime': {
          Fragment: 'Fragment',
          jsx: (type, props, key) => ({ type, props: props ?? {}, key: key ?? null }),
          jsxs: (type, props, key) => ({ type, props: props ?? {}, key: key ?? null }),
        },
      };
    },
    /** Render until the tree settles. Call again after async work to re-render with the new state. */
    render(element) {
      let tree = null;
      let guard = 0;
      do {
        dirty = false;
        tree = renderNode(element, 'root');
        guard += 1;
      } while (dirty && guard < 25);
      if (guard >= 25) throw new Error('the tree never settled');
      return tree;
    },
  };
}

// ── Tree queries ────────────────────────────────────────────────────────────

function walk(node, visit) {
  if (!node) return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

function findAll(tree, predicate) {
  const found = [];
  walk(tree, (node) => {
    if (predicate(node)) found.push(node);
  });
  return found;
}

/** Descendants of `node`, excluding `node` itself. */
function descendantsOf(node, predicate) {
  return findAll(node.children ?? [], predicate);
}

function byTestId(tree, testID) {
  return findAll(tree, (node) => node.props?.testID === testID);
}

function byType(tree, type) {
  return findAll(tree, (node) => node.type === type);
}

function textContent(tree) {
  const out = [];
  walk(tree, (node) => {
    if (node.type === '#text') out.push(String(node.value));
  });
  return out.join(' ');
}

/** The element children of a node, in order (text nodes excluded). */
function elementChildren(node) {
  return (node.children ?? []).filter((child) => child.type !== '#text');
}

// ── Module loading ──────────────────────────────────────────────────────────

/**
 * Any property is itself, calling it returns itself, and it coerces to 0. A
 * stand-in for theme tokens, where the values do not matter to the assertion.
 */
function deepStub() {
  const target = function stub() {};
  const proxy = new Proxy(target, {
    get: (_t, prop) =>
      prop === Symbol.toPrimitive ? () => 0 : prop === '__esModule' ? false : proxy,
    apply: () => proxy,
  });
  return proxy;
}

function readSource(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/**
 * Transpile a repo file. `mutate(source)` rewrites the source first, and MUST
 * change it: a negative control that mutates nothing proves nothing, so a
 * vacuous mutation throws rather than passing quietly.
 */
function transpile(rel, { jsx = true, mutate } = {}) {
  let source = readSource(rel);
  if (mutate) {
    const mutated = mutate(source);
    if (mutated === source) {
      throw new Error(`mutation of ${rel} changed nothing - the negative control is vacuous`);
    }
    source = mutated;
  }
  return ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
      allowJs: true,
      jsx: jsx ? ts.JsxEmit.ReactJSX : undefined,
    },
    fileName: path.join(ROOT, rel),
  }).outputText;
}

/** A require shim that throws on any import the test did not provide. Getters are honoured (lazy modules). */
function strictRequire(modules, label) {
  return (spec) => {
    if (Object.prototype.hasOwnProperty.call(modules, spec)) return modules[spec];
    throw new Error(`Unexpected require in ${label}: ${spec}`);
  };
}

function runModule(rel, modules, options = {}) {
  const mod = { exports: {} };
  vm.runInThisContext(`(function (exports, module, require) {\n${transpile(rel, options)}\n})`, {
    filename: rel,
  })(mod.exports, mod, strictRequire(modules, rel));
  return mod.exports;
}

/** Let pending microtasks and immediates settle. */
async function settle(times = 6) {
  for (let i = 0; i < times; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    await Promise.resolve();
  }
}

/** A promise whose resolution the test controls (to interleave an actor change with an await). */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * The react-native surface these components use. Host components are their own
 * names, so `node.type === 'Modal'` reads naturally in an assertion.
 */
function createReactNativeStub({ platformOS = 'ios', announcements = [] } = {}) {
  class AnimatedValue {
    constructor(value) {
      this.value = value;
    }
    setValue(value) {
      this.value = value;
    }
  }
  const animation = () => ({ start() {} });
  const stub = {
    Platform: {
      OS: platformOS,
      select: (spec) => (platformOS in spec ? spec[platformOS] : spec.default),
    },
    StyleSheet: { create: (styles) => styles, absoluteFillObject: {}, hairlineWidth: 1 },
    Animated: {
      Value: AnimatedValue,
      timing: animation,
      parallel: animation,
      stagger: animation,
      View: 'Animated.View',
    },
    PanResponder: { create: () => ({ panHandlers: {} }) },
    Easing: { bezier: () => () => 0 },
    AccessibilityInfo: {
      announceForAccessibility: (message) => {
        announcements.push(message);
      },
    },
    Keyboard: { dismiss() {} },
    LayoutAnimation: { configureNext() {}, Presets: { easeInEaseOut: {} } },
    UIManager: {},
  };
  for (const name of [
    'ActivityIndicator',
    'Image',
    'KeyboardAvoidingView',
    'Modal',
    'Pressable',
    'ScrollView',
    'Text',
    'TextInput',
    'TouchableOpacity',
    'View',
  ]) {
    stub[name] = name;
  }
  return stub;
}

// ── AST queries ─────────────────────────────────────────────────────────────

function parseSource(text, fileName = 'source.tsx') {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2020, true, ts.ScriptKind.TSX);
}

function* walkAst(node) {
  yield node;
  for (const child of node.getChildren()) yield* walkAst(child);
}

function jsxTagNameOf(node) {
  if (ts.isJsxElement(node)) return node.openingElement.tagName.getText();
  if (ts.isJsxSelfClosingElement(node)) return node.tagName.getText();
  return null;
}

function jsxAttributesOf(node) {
  const opening = ts.isJsxElement(node) ? node.openingElement : node;
  return opening.attributes.properties.filter(ts.isJsxAttribute);
}

function jsxAttribute(node, name) {
  return jsxAttributesOf(node).find((attribute) => attribute.name.getText() === name) ?? null;
}

/** Every JSX element (open/close pair or self-closing) with the given tag name. */
function jsxElementsNamed(sourceFile, tagName) {
  const found = [];
  for (const node of walkAst(sourceFile)) {
    if (jsxTagNameOf(node) === tagName) found.push(node);
  }
  return found;
}

module.exports = {
  ROOT,
  byTestId,
  byType,
  createReactNativeStub,
  createRenderer,
  deepStub,
  deferred,
  descendantsOf,
  elementChildren,
  findAll,
  jsxAttribute,
  jsxAttributesOf,
  jsxElementsNamed,
  jsxTagNameOf,
  parseSource,
  readSource,
  runModule,
  settle,
  strictRequire,
  textContent,
  transpile,
  walk,
  walkAst,
};
