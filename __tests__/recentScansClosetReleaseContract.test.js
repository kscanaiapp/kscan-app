// Recent Scans / Closet / Mirror Selfie — RELEASE CONTRACT.
//
// WHY THIS FILE EXISTS
//
// A release candidate was reported as showing the pre-separation Closet: the
// header read "Your Closet / SAVED LOOKS & INSPIRATION", the tabs read
// "MY CLOSET" and "MY LOOKS", the empty state read "Start Your Closet", and no
// Mirror Selfie entry was reachable. Every one of those strings is
// LEGACY_CHROME in app/library.tsx — the state the screen renders when
// CLOSET_SEPARATION_V1 is false. The source was correct; the environment the
// bundle was built against simply did not carry the five-flag chain.
//
// The existing suites did not catch that, for two specific reasons this file
// fixes:
//
//   1. __tests__/closetCandidateFeatureFlags.test.js asserts the five-flag
//      chain over a HARDCODED profile list — ['production','preview',
//      'development'] — while eas.json also defines `staging`. Dropping
//      EXPO_PUBLIC_CLOSET_SEPARATION_V1 from an unlisted profile darkens BOTH
//      Recent Scans and Mirror Selfie in that profile and every existing test
//      still passes. PART A iterates whatever profiles actually exist, so a
//      new or drifting profile cannot ship dark.
//
//   2. Nothing pinned that the Mirror Selfie entry survives an EMPTY Closet.
//      It is rendered before the loading/empty/grid ternary, so it is visible
//      with zero owned items — which is the approved behaviour, since an empty
//      Closet is exactly when a user needs a bulk intake route. A refactor
//      moving it inside the non-empty branch would reproduce the reported
//      "no Mirror Selfie" symptom against correct flags. PART C renders both
//      states and fails if emptiness hides it.
//
// PART B is the negative control: it renders the REAL app/library.tsx with the
// flag both on and off and asserts the two chromes are distinguishable, so the
// assertions here discriminate rather than merely pass.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const eas = JSON.parse(fs.readFileSync(path.join(ROOT, 'eas.json'), 'utf8'));
const flagsSource = fs.readFileSync(path.join(ROOT, 'constants', 'featureFlags.ts'), 'utf8');

function transpile(rel, jsx = false) {
  return ts.transpileModule(fs.readFileSync(path.join(ROOT, rel), 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
      allowJs: true,
      ...(jsx ? { jsx: ts.JsxEmit.React } : {}),
    },
  }).outputText;
}

/** Evaluate the REAL constants/featureFlags.ts against an explicit env. */
function loadFlags(env = {}) {
  const sandbox = {
    module: { exports: {} },
    exports: {},
    require: () => ({}),
    process: { env },
    __DEV__: false,
    console,
  };
  sandbox.module.exports = sandbox.exports;
  vm.runInNewContext(
    ts.transpileModule(flagsSource, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
      },
    }).outputText,
    sandbox,
    { filename: 'constants/featureFlags.ts' },
  );
  return sandbox.module.exports;
}

// The complete chain both surfaces depend on. Recent Scans needs only the
// first; Mirror Selfie needs all five, because MIRROR_SELFIE_V1_ACTIVE is
// composed from every one of them.
const RELEASE_CHAIN = [
  'EXPO_PUBLIC_CLOSET_SEPARATION_V1',
  'EXPO_PUBLIC_CLOSET_DIRECT_INTAKE_V1',
  'EXPO_PUBLIC_CLOSET_CANDIDATE_STAGING_V1',
  'EXPO_PUBLIC_CLOSET_BATCH_REVIEW_V2',
  'EXPO_PUBLIC_MIRROR_SELFIE_V1',
];

// ══ PART A — release configuration, over EVERY profile that exists ══════════

test('EVERY-BUILD-PROFILE carries the complete Recent Scans / Mirror chain', () => {
  const profiles = Object.keys(eas.build ?? {});
  assert.ok(profiles.length > 0, 'eas.json declares no build profiles');

  for (const name of profiles) {
    const env = eas.build[name].env ?? {};
    for (const key of RELEASE_CHAIN) {
      assert.equal(
        env[key],
        'true',
        `profile "${name}" does not set ${key}="true" — Recent Scans and/or ` +
          'Mirror Selfie ship dark in that profile',
      );
    }
  }
});

test('EVERY-BUILD-PROFILE resolves both surfaces active through the real resolver', () => {
  for (const [name, profile] of Object.entries(eas.build ?? {})) {
    const flags = loadFlags(profile.env ?? {});
    assert.equal(
      flags.CLOSET_SEPARATION_V1,
      true,
      `profile "${name}": Recent Scans would render the legacy Closet`,
    );
    assert.equal(
      flags.MIRROR_SELFIE_V1_ACTIVE,
      true,
      `profile "${name}": the Mirror Selfie entry would not render`,
    );
  }
});

// Negative control for PART A: the assertions above must actually depend on
// each link. Removing any single key has to darken the surface, or the loop
// above is asserting nothing.
test('NEGATIVE-CONTROL: dropping any one link darkens the Mirror entry', () => {
  const complete = Object.fromEntries(RELEASE_CHAIN.map((k) => [k, 'true']));
  assert.equal(loadFlags(complete).MIRROR_SELFIE_V1_ACTIVE, true, 'baseline must be active');

  for (const key of RELEASE_CHAIN) {
    const partial = { ...complete };
    delete partial[key];
    assert.equal(
      loadFlags(partial).MIRROR_SELFIE_V1_ACTIVE,
      false,
      `removing ${key} left Mirror active — the composition is not fail-closed`,
    );
  }
});

test('NEGATIVE-CONTROL: an absent separation flag reproduces the legacy Closet', () => {
  // This is precisely the reported runtime state: no env at all.
  assert.equal(loadFlags({}).CLOSET_SEPARATION_V1, false);
  assert.equal(loadFlags({}).MIRROR_SELFIE_V1_ACTIVE, false);
});

// ══ PART B/C — the REAL app/library.tsx element tree ════════════════════════

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

function deepStub(label) {
  return new Proxy(function stub() {}, {
    get(_t, prop) {
      if (prop === '__esModule') return true;
      if (prop === 'toString') return () => label;
      if (typeof prop === 'symbol') return undefined;
      return deepStub(`${label}.${String(prop)}`);
    },
    apply() {
      return deepStub(`${label}()`);
    },
  });
}

function named(name) {
  const fn = function marker() {};
  Object.defineProperty(fn, 'name', { value: name });
  fn.displayName = name;
  return fn;
}

const LUXURY_NAMES = [
  'LuxuryScreen', 'KScanHeader', 'SectionHeader', 'SavedLookCard',
  'EmptyStateCard', 'InlineNotice', 'SecondaryButton', 'PrivacyFooter',
];

function walk(node, visit) {
  if (node === null || node === undefined || node === false || node === true) return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (typeof node !== 'object' || node.__element !== true) return;
  visit(node);
  if (node.props && 'children' in node.props) walk(node.props.children, visit);
}

function collect(tree, predicate) {
  const out = [];
  walk(tree, (n) => { if (predicate(n)) out.push(n); });
  return out;
}

function byTestID(tree, testID) {
  return collect(tree, (n) => n.props && n.props.testID === testID);
}

/** Every string reachable in the tree — visible copy and string props alike. */
function allText(tree) {
  const parts = [];
  walk(tree, (n) => {
    for (const [key, value] of Object.entries(n.props || {})) {
      if (key === 'children') continue;
      if (typeof value === 'string') parts.push(value);
      else if (value && typeof value === 'object' && typeof value.label === 'string') {
        parts.push(value.label);
      }
    }
    const kids = n.props && n.props.children;
    const list = Array.isArray(kids) ? kids : [kids];
    for (const kid of list) if (typeof kid === 'string') parts.push(kid);
  });
  return parts.join('\n');
}

const CLOSET_ITEM = {
  id: 'closet-owned-1',
  createdAt: '2026-07-02T10:00:00.000Z',
  imageUri: '/doc/closet.jpg',
  thumbnailUri: '/doc/closet-thumb.jpg',
  title: 'OWNED_ITEM_TITLE',
  category: 'OWNED_ITEM_CATEGORY',
};

function renderLibrary({
  section = 'recent',
  scans = [],
  closetItems = [],
  separation = true,
  mirror = true,
} = {}) {
  const React = makeReact();
  const router = { push: () => {}, replace: () => {}, back: () => {}, setParams: () => {} };

  const luxury = { __esModule: true };
  for (const n of LUXURY_NAMES) luxury[n] = named(n);

  const modules = {
    react: React,
    'react-native': {
      __esModule: true,
      View: 'View',
      Text: 'Text',
      TouchableOpacity: 'TouchableOpacity',
      ScrollView: 'ScrollView',
      ActivityIndicator: 'ActivityIndicator',
      Alert: { alert: () => {} },
      Linking: { openURL: () => {}, openSettings: () => {} },
      StyleSheet: { create: (s) => s, flatten: (s) => s, hairlineWidth: 1 },
      Dimensions: { get: () => ({ width: 390, height: 844 }) },
      Platform: { OS: 'android', select: (o) => o.android ?? o.default },
    },
    'expo-router': {
      __esModule: true,
      router,
      useRouter: () => router,
      useFocusEffect: () => {},
      useLocalSearchParams: () => ({ section }),
    },
    'expo-status-bar': { __esModule: true, StatusBar: 'StatusBar' },
    '../hooks/useLibrary': {
      __esModule: true,
      useLibrary: () => ({ scans, loading: false, remove: async () => {}, actorKey: 'device-local' }),
    },
    '../hooks/useCloset': {
      __esModule: true,
      useCloset: () => ({
        items: closetItems,
        loading: false,
        error: null,
        remove: async () => true,
        addFromScan: async () => ({ ok: true }),
        addFromUri: async () => ({ ok: true }),
        refresh: async () => {},
      }),
    },
    '../hooks/useClosetCandidates': {
      __esModule: true,
      useClosetCandidates: () => ({
        candidates: [],
        loading: false,
        mirrorIntegration: null,
        stage: async () => ({ ok: true }),
        addFromUri: async () => ({ ok: true }),
        addFromAssets: async () => ({ ok: true }),
        stageMirrorSelection: async () => ({ ok: true }),
        refresh: async () => {},
      }),
    },
    '../hooks/useFeatureFreeze': {
      __esModule: true,
      useFeatureFreeze: () => ({ isFeatureEnabled: () => true, isLoading: false }),
    },
    '../contexts/AuthSessionContext': {
      __esModule: true,
      useAuthSession: () => ({ isAuthenticated: true, user: { id: 'actor-1' }, loading: false }),
    },
    '../components/luxury': luxury,
    '../constants/featureFlags': {
      __esModule: true,
      AI_STYLIST_UI_ENABLED: true,
      STYLECHAT_ATTACHMENTS_ENABLED: true,
      CLOSET_SEPARATION_V1: separation,
      CLOSET_DIRECT_INTAKE_ACTIVE: separation,
      CLOSET_CANDIDATE_STAGING_ACTIVE: separation && mirror,
      CLOSET_BATCH_REVIEW_V2_ACTIVE: separation && mirror,
      MIRROR_SELFIE_V1_ACTIVE: separation && mirror,
      PRIVATE_DRESSING_ROOM_V1: true,
    },
  };

  function requireShim(spec) {
    if (Object.prototype.hasOwnProperty.call(modules, spec)) return modules[spec];
    return deepStub(spec);
  }

  const mod = { exports: {} };
  vm.runInThisContext(
    `(function (exports, module, require, React) {\n${transpile('app/library.tsx', true)}\n})`,
    { filename: 'library.tsx' },
  )(mod.exports, mod, requireShim, React);

  const Screen = mod.exports.default;
  assert.equal(typeof Screen, 'function', 'app/library.tsx must export a screen');
  const tree = Screen();
  return {
    tree,
    header: collect(tree, (n) => n.type === luxury.KScanHeader)[0],
    text: allText(tree),
  };
}

// The exact strings the reported build showed. If any of these reach the
// screen while separation is ON, the incident has recurred.
const LEGACY_MARKERS = [
  'SAVED LOOKS & INSPIRATION',
  'Start Your Closet',
  'Save a scan and your looks will live here.',
];

// ══ PART B — Recent Scans renders Recent Scans, never the legacy Closet ═════

test('RECENT-SCANS-DESTINATION presents scan-history identity', () => {
  const { header } = renderLibrary({ section: 'recent' });
  assert.equal(header.props.title, 'Recent Scans');
  assert.equal(header.props.subtitle, 'SCAN HISTORY & DISCOVERY');
});

test('RECENT-SCANS-DESTINATION never renders the legacy Closet chrome', () => {
  const { text } = renderLibrary({ section: 'recent' });
  for (const marker of LEGACY_MARKERS) {
    assert.ok(
      !text.includes(marker),
      `the Recent Scans destination rendered legacy chrome: ${marker}`,
    );
  }
});

test('RECENT-SCANS-EMPTY-STATE stays scan language for a user with zero scans', () => {
  const { text } = renderLibrary({ section: 'recent', scans: [] });
  assert.ok(text.includes('No Recent Scans Yet'), 'the approved empty title is missing');
  assert.ok(!text.includes('Start Your Closet'), 'the legacy empty state leaked in');
});

test('NEGATIVE-CONTROL: with separation off the screen IS the reported build', () => {
  // Proves the assertions above discriminate, and ties the reported screenshot
  // to the flag rather than to any missing commit.
  const { header, text } = renderLibrary({ section: 'recent', separation: false, mirror: false });
  assert.equal(header.props.title, 'Your Closet');
  assert.equal(header.props.subtitle, 'SAVED LOOKS & INSPIRATION');
  assert.ok(text.includes('Start Your Closet'));
  assert.equal(byTestID(renderLibrary({
    section: 'closet', separation: false, mirror: false,
  }).tree, 'closet-mirror-selfie-button').length, 0);
});

// ══ PART C — Mirror Selfie visibility on the Closet section ═════════════════

test('MIRROR-ENTRY is present on an EMPTY Closet', () => {
  const { tree, text } = renderLibrary({ section: 'closet', closetItems: [] });
  assert.ok(text.includes('Your Closet is empty'), 'the empty Closet state must be the one rendered');
  assert.equal(
    byTestID(tree, 'closet-mirror-selfie-button').length,
    1,
    'an empty Closet hid the Mirror Selfie entry — bulk intake is exactly what an ' +
      'empty Closet needs, so it must not be gated on owning something first',
  );
});

test('MIRROR-ENTRY is present on a POPULATED Closet', () => {
  const { tree } = renderLibrary({ section: 'closet', closetItems: [CLOSET_ITEM] });
  assert.equal(
    byTestID(tree, 'closet-mirror-selfie-button').length,
    1,
    'the Mirror Selfie entry disappeared once the Closet had items',
  );
});

test('MIRROR-ENTRY keeps its approved label and intent', () => {
  const { tree } = renderLibrary({ section: 'closet' });
  const [button] = byTestID(tree, 'closet-mirror-selfie-button');
  assert.equal(button.props.title, 'Mirror Selfie');
  assert.equal(
    button.props.accessibilityLabel,
    'Add several items from one mirror selfie',
  );
  assert.equal(typeof button.props.onPress, 'function');
});

test('MIRROR-ENTRY belongs to the Closet section only, never Recent Scans', () => {
  const { tree } = renderLibrary({ section: 'recent' });
  assert.equal(
    byTestID(tree, 'closet-mirror-selfie-button').length,
    0,
    'the Mirror Selfie entry leaked into scan history',
  );
});

test('MIRROR-ENTRY is absent when the composed capability is off', () => {
  const { tree } = renderLibrary({ section: 'closet', mirror: false });
  assert.equal(byTestID(tree, 'closet-mirror-selfie-button').length, 0);
});
