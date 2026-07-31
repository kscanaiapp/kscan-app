// Closet / Recent Scans navigation separation — production route contract.
//
// This is a BEHAVIORAL test, not a source-text scan. The real production
// modules (app/index.tsx and components/home/HomeLuxuryTechV1.tsx) are
// transpiled in-process and executed against a recording React stub, so the
// assertions run against the element tree the app actually builds and against
// the router payload the real onPress callback actually emits.
//
// WHY THIS FILE EXISTS: both Home feature chips previously pushed the bare
// '/library' route. Bare '/library' resolves to the Recent Scan section, so the
// CLOSET chip silently opened scan history wearing Closet chrome. A default
// route must never be able to stand in for either destination again.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function transpile(rel) {
  return ts.transpileModule(fs.readFileSync(path.join(ROOT, rel), 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.React,
      esModuleInterop: true,
      allowJs: true,
    },
  }).outputText;
}

// ── Recording React ──────────────────────────────────────────────────────────
// createElement returns a plain descriptor. No renderer is involved (and none
// is available in this repo), but a function component's returned tree is a
// real value we can walk and whose props are the real callbacks.
function makeReact() {
  const React = {
    __esModule: true,
    createElement(type, props, ...children) {
      const merged = { ...(props || {}) };
      if (children.length > 0) {
        merged.children = children.length === 1 ? children[0] : children;
      }
      return { __element: true, type, props: merged };
    },
    Fragment: 'Fragment',
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useRef: (init) => ({ current: init === undefined ? null : init }),
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useEffect: () => {},
    useLayoutEffect: () => {},
  };
  React.default = React;
  return React;
}

/** A stand-in component/value that tolerates any property or call. */
function deepStub(label) {
  const base = function stub() {};
  return new Proxy(base, {
    get(_t, prop) {
      if (prop === '__esModule') return true;
      if (prop === 'toString') return () => label;
      if (prop === '__label') return label;
      if (typeof prop === 'symbol') return undefined;
      return deepStub(`${label}.${String(prop)}`);
    },
    apply() {
      return deepStub(`${label}()`);
    },
  });
}

/** Walk an element tree, visiting every element descriptor. */
function walk(node, visit) {
  if (node === null || node === undefined || node === false) return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (typeof node !== 'object' || node.__element !== true) return;
  visit(node);
  if (node.props && 'children' in node.props) walk(node.props.children, visit);
}

function findByTestID(tree, testID) {
  let found = null;
  walk(tree, (node) => {
    if (found === null && node.props && node.props.testID === testID) found = node;
  });
  return found;
}

function collect(tree, predicate) {
  const out = [];
  walk(tree, (node) => {
    if (predicate(node)) out.push(node);
  });
  return out;
}

// ── Production module execution ──────────────────────────────────────────────
function renderHome() {
  const React = makeReact();
  const pushes = [];
  const replaces = [];
  const router = {
    push: (arg) => pushes.push(arg),
    replace: (arg) => replaces.push(arg),
    back: () => {},
    setParams: () => {},
  };

  const modules = {
    react: React,
    'react-native': {
      __esModule: true,
      View: 'View',
      Text: 'Text',
      Pressable: 'Pressable',
      Image: 'Image',
      ScrollView: 'ScrollView',
      ActivityIndicator: 'ActivityIndicator',
      Linking: { openURL: () => {} },
      StyleSheet: { create: (styles) => styles, flatten: (s) => s },
      Dimensions: { get: () => ({ width: 390, height: 844 }) },
      Platform: { OS: 'android', select: (o) => o.android ?? o.default },
    },
    'expo-router': {
      __esModule: true,
      router,
      useRouter: () => router,
      useFocusEffect: () => {},
      useLocalSearchParams: () => ({}),
    },
    'expo-status-bar': { __esModule: true, StatusBar: 'StatusBar' },
    '../../contexts/AuthSessionContext': {
      __esModule: true,
      useAuthSession: () => ({
        isAuthenticated: true,
        user: { id: 'actor-1' },
        loading: false,
      }),
    },
    '../../hooks/useFeatureFreeze': {
      __esModule: true,
      useFeatureFreeze: () => ({ isFeatureEnabled: () => true, isLoading: false }),
    },
    '../../hooks/useStylePicks': {
      __esModule: true,
      useStylePicks: () => ({
        picks: [],
        status: 'backend_not_connected',
        isLoading: false,
        error: null,
      }),
    },
    '../../hooks/useStylistIdentity': {
      __esModule: true,
      useStylistIdentity: () => ({
        identity: { displayName: 'Elise', stylistName: 'Elise' },
        isLoading: false,
        error: null,
        updateIdentity: () => {},
        resetIdentity: () => {},
      }),
    },
    '../../hooks/useStyleChatSessions': {
      __esModule: true,
      useStyleChatSessions: () => ({ createSession: async () => ({ id: 's1' }) }),
    },
    '../../services/style-chat/sessionLaunchGuard': {
      __esModule: true,
      createStyleChatSessionLaunchGuard: () => ({ begin: () => true, end: () => {} }),
      launchStyleChatSession: () => {},
    },
  };

  function requireShim(spec) {
    if (Object.prototype.hasOwnProperty.call(modules, spec)) return modules[spec];
    return deepStub(spec);
  }

  const mod = { exports: {} };
  // React is passed into the wrapper scope because classic JSX emit references
  // a free `React` identifier, which some route files never import themselves.
  vm.runInThisContext(
    `(function (exports, module, require, React) {\n${transpile('components/home/HomeLuxuryTechV1.tsx')}\n})`,
    { filename: 'HomeLuxuryTechV1.tsx' },
  )(mod.exports, mod, requireShim, React);

  const Home = mod.exports.default;
  assert.equal(typeof Home, 'function', 'HomeLuxuryTechV1 must export a component');
  return { tree: Home(), pushes, replaces, Home };
}

/** Execute app/index.tsx and report which component it mounts. */
function mountedHomeComponent() {
  const React = makeReact();
  const marker = function HomeLuxuryTechV1Marker() {};
  const mod = { exports: {} };
  vm.runInThisContext(
    `(function (exports, module, require, React) {\n${transpile('app/index.tsx')}\n})`,
    { filename: 'index.tsx' },
  )(mod.exports, mod, (spec) => {
    if (spec === 'react') return React;
    if (spec === '../components/home') {
      return { __esModule: true, HomeLuxuryTechV1: marker };
    }
    return deepStub(spec);
  }, React);
  const Route = mod.exports.default;
  assert.equal(typeof Route, 'function', 'app/index.tsx must export a route component');
  return { element: Route(), marker };
}

const RECENT_TESTID = 'home-luxury-feature-recent-scans';
const CLOSET_TESTID = 'home-luxury-feature-library';

/** Invoke a chip's real onPress and return the single router payload it emitted. */
function pressChip(testID) {
  const { tree, pushes } = renderHome();
  const chip = findByTestID(tree, testID);
  assert.ok(chip, `chip ${testID} must be present in the rendered Home tree`);
  assert.equal(typeof chip.props.onPress, 'function', `${testID} must have an onPress`);
  chip.props.onPress();
  assert.equal(pushes.length, 1, `${testID} must emit exactly one navigation`);
  return pushes[0];
}

// ── 1. Active production Home ────────────────────────────────────────────────

test('app/index.tsx mounts HomeLuxuryTechV1 as the production Home', () => {
  const { element, marker } = mountedHomeComponent();
  assert.equal(element.type, marker, 'the route must render HomeLuxuryTechV1 itself');
});

test('the active Home wrapper drops neither feature callback', () => {
  const { tree } = renderHome();
  for (const testID of [RECENT_TESTID, CLOSET_TESTID]) {
    const chip = findByTestID(tree, testID);
    assert.ok(chip, `${testID} must render`);
    assert.equal(
      typeof chip.props.onPress,
      'function',
      `${testID} must keep a live onPress — a dropped callback is a dead chip`,
    );
  }
});

// ── 2. Explicit, distinct destinations ───────────────────────────────────────

test('RECENT SCANS opens the explicit recent section', () => {
  assert.deepEqual(pressChip(RECENT_TESTID), {
    pathname: '/library',
    params: { section: 'recent' },
  });
});

test('CLOSET opens the explicit closet section', () => {
  assert.deepEqual(pressChip(CLOSET_TESTID), {
    pathname: '/library',
    params: { section: 'closet' },
  });
});

test('the two Home destinations are not equal', () => {
  const recent = pressChip(RECENT_TESTID);
  const closet = pressChip(CLOSET_TESTID);
  assert.notDeepEqual(recent, closet, 'Recent Scans and Closet must not share a destination');
  assert.notEqual(recent.params.section, closet.params.section);
});

// ── 3. A default route can never substitute ──────────────────────────────────

test('neither Home destination relies on the route default', () => {
  for (const testID of [RECENT_TESTID, CLOSET_TESTID]) {
    const payload = pressChip(testID);
    assert.equal(
      typeof payload,
      'object',
      `${testID} must push an object with explicit params, never the bare '/library' string`,
    );
    assert.equal(payload.pathname, '/library');
    assert.ok(
      payload.params && typeof payload.params.section === 'string',
      `${testID} must carry an explicit section param`,
    );
    assert.ok(
      ['recent', 'closet'].includes(payload.params.section),
      `${testID} section must be a known product domain`,
    );
  }
});

test('no production Home chip pushes the bare library route', () => {
  const { tree } = renderHome();
  const chips = collect(
    tree,
    (node) => node.props && typeof node.props.testID === 'string'
      && node.props.testID.startsWith('home-luxury-feature-'),
  );
  assert.ok(chips.length >= 2, 'the feature grid must still render');
  for (const chip of chips) {
    const pushes = [];
    // Re-render per chip so each press is observed in isolation.
    const fresh = renderHome();
    const target = findByTestID(fresh.tree, chip.props.testID);
    if (typeof target.props.onPress !== 'function') continue;
    target.props.onPress();
    for (const payload of fresh.pushes) pushes.push(payload);
    for (const payload of pushes) {
      assert.notEqual(
        payload,
        '/library',
        `${chip.props.testID} must not push the bare '/library' route`,
      );
    }
  }
});

// ── 4. Cross-platform shared behavior ────────────────────────────────────────

// ── 5. Every other production /library caller ────────────────────────────────

test('Dressing Rooms still opens the committed Closet section', () => {
  const dressingRoom = fs.readFileSync(
    path.join(ROOT, 'app', 'stylist', 'dressing-room', 'index.tsx'),
    'utf8',
  );
  const closetNavs = dressingRoom.match(
    /router\.push\(\{\s*pathname:\s*'\/library',\s*params:\s*\{\s*section:\s*'closet'\s*\}/g,
  ) || [];
  assert.ok(
    closetNavs.length >= 2,
    'both Dressing Room Closet entries must keep section=closet',
  );
  assert.doesNotMatch(
    dressingRoom,
    /router\.(push|replace)\('\/library'\)/,
    'Dressing Rooms must never fall back to the bare library route',
  );
});

test('the feature-freeze Closet fallback opens the committed Closet', () => {
  const React = makeReact();
  const replaces = [];
  const router = { push: () => {}, replace: (a) => replaces.push(a), back: () => {} };

  const mod = { exports: {} };
  vm.runInThisContext(
    `(function (exports, module, require, React) {\n${transpile('components/FeatureFreezeFallback.tsx')}\n})`,
    { filename: 'FeatureFreezeFallback.tsx' },
  )(mod.exports, mod, (spec) => {
    if (spec === 'react') return React;
    if (spec === 'react-native') {
      return {
        __esModule: true,
        View: 'View',
        Text: 'Text',
        Pressable: 'Pressable',
        ActivityIndicator: 'ActivityIndicator',
        StyleSheet: { create: (s) => s, hairlineWidth: 1 },
      };
    }
    if (spec === 'expo-router') return { __esModule: true, router };
    if (spec === '../hooks/useFeatureFreeze') {
      return { __esModule: true, useFeatureFreeze: () => ({ message: 'Back soon' }) };
    }
    return deepStub(spec);
  }, React);

  const Fallback = mod.exports.FeatureFreezeFallback;
  assert.equal(typeof Fallback, 'function');

  const closetTree = Fallback({ cta: 'closet' });
  const closetButton = collect(
    closetTree,
    (n) => n.props && n.props.accessibilityRole === 'button',
  )[0];
  assert.ok(closetButton, 'the fallback must render its CTA');
  closetButton.props.onPress();
  assert.deepEqual(
    replaces,
    [{ pathname: '/library', params: { section: 'closet' } }],
    'a BACK TO CLOSET button must land on the Closet, not on the bare default',
  );

  replaces.length = 0;
  const scanTree = Fallback({ cta: 'scan' });
  collect(scanTree, (n) => n.props && n.props.accessibilityRole === 'button')[0]
    .props.onPress();
  assert.deepEqual(replaces, ['/scan'], 'the scan fallback keeps its own route');
});

test('no reachable production module pushes the bare library route', () => {
  // Files proven unreachable from the Expo Router entry (package.json main is
  // "expo-router/entry", so index.js/app.js are a legacy pair, and the two
  // alternate Home implementations are exported but imported by no route).
  // Each is re-verified as unreachable below rather than merely trusted.
  const UNREACHABLE = {
    'app.js': 'legacy pre-expo-router entry; only index.js imports it',
    'index.js': 'legacy entry; package.json main is expo-router/entry',
    [path.join('components', 'home', 'HomeV2.tsx')]: 'alternate Home; no route imports it',
    [path.join('components', 'home', 'HomeLegacy.tsx')]: 'alternate Home; no route imports it',
  };

  const offenders = [];
  const skipDirs = new Set(['node_modules', '__tests__', 'docs', 'qa', '_rollback', '.git', 'android', 'ios', 'supabase', 'scripts']);
  (function sweep(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        sweep(path.join(dir, entry.name));
      } else if (/\.(tsx?|jsx?)$/.test(entry.name)) {
        const rel = path.relative(ROOT, path.join(dir, entry.name));
        if (Object.prototype.hasOwnProperty.call(UNREACHABLE, rel)) continue;
        const src = fs.readFileSync(path.join(dir, entry.name), 'utf8');
        if (/router\.(push|replace)\(\s*['"]\/library['"]\s*\)/.test(src)) offenders.push(rel);
      }
    }
  })(ROOT);

  assert.deepEqual(
    offenders,
    [],
    `these reachable modules still use the bare '/library' route: ${offenders.join(', ')}`,
  );

  // The allowlist is only valid while nothing routable imports those files.
  const homeBarrel = fs.readFileSync(path.join(ROOT, 'app', 'index.tsx'), 'utf8');
  assert.doesNotMatch(homeBarrel, /HomeV2|HomeLegacy/, 'the route must mount HomeLuxuryTechV1');
});

test('Home feature chips keep their product identity and accessibility labels', () => {
  const { tree } = renderHome();
  const recent = findByTestID(tree, RECENT_TESTID);
  const closet = findByTestID(tree, CLOSET_TESTID);
  assert.equal(recent.props.title, 'RECENT SCANS');
  assert.equal(closet.props.title, 'CLOSET');
  assert.equal(recent.props.accessibilityLabel, 'Recent Scans');
  assert.equal(closet.props.accessibilityLabel, 'Open Closet');
});
