// Mirror Selfie — Android production-exposure repair (K SCAN AI Android
// Repair 01).
//
// THE DEFECT: eas.json's production profile sets
// EXPO_PUBLIC_MIRROR_SELFIE_V1=true for every platform, but the native
// person-extraction runtime it depends on
// (modules/kscan-pii-native/expo-module.config.json) declares
// "platforms": ["apple"] only — there is no Android half of that module on
// this release line. Before this repair, MIRROR_SELFIE_V1_ACTIVE
// (constants/featureFlags.ts) — the flag every entry point gated on — never
// consulted the platform at all, so Android production advertised and
// rendered an active Mirror Selfie entry it could not execute.
//
// THE REPAIR: services/mirror/mirrorSelfieAvailability.ts is now the single
// canonical availability decision — flag AND platform — and every entry point
// (app/library.tsx's three mount sites, hooks/useMirrorExtraction.ts's
// `active`) reads through it instead of the flag alone.
//
// This file proves the actual invariant behaviourally, not by snapshotting
// text: the real resolver module and the real app/library.tsx element tree,
// executed with a controlled platform and a controlled flag.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

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

// ══ PART A — the resolver itself, real code, controlled inputs ═════════════

/** Loads the REAL services/mirror/mirrorSelfieAvailability.ts. */
function loadAvailabilityModule({ platformOS, flagActive }) {
  const shim = (spec) => {
    if (spec === 'react-native') return { Platform: { OS: platformOS } };
    if (spec === '../../constants/featureFlags') return { MIRROR_SELFIE_V1_ACTIVE: flagActive };
    throw new Error(`unexpected mirrorSelfieAvailability import: ${spec}`);
  };
  const mod = { exports: {} };
  vm.runInThisContext(
    `(function (exports, module, require) {\n${transpile('services/mirror/mirrorSelfieAvailability.ts')}\n})`,
    { filename: 'services/mirror/mirrorSelfieAvailability.ts' },
  )(mod.exports, mod, shim);
  return mod.exports;
}

test('ANDROID-AVAILABILITY: production flag ON, Android platform -> unavailable', () => {
  const { resolveMirrorSelfieAvailable } = loadAvailabilityModule({
    platformOS: 'android',
    flagActive: true,
  });
  assert.equal(resolveMirrorSelfieAvailable(), false);
});

test('IOS-AVAILABILITY: production flag ON, iOS platform -> available', () => {
  const { resolveMirrorSelfieAvailable } = loadAvailabilityModule({
    platformOS: 'ios',
    flagActive: true,
  });
  assert.equal(resolveMirrorSelfieAvailable(), true);
});

test('the flag alone is never sufficient, on any platform', () => {
  for (const platformOS of ['android', 'ios', 'web', 'windows']) {
    const { resolveMirrorSelfieAvailable } = loadAvailabilityModule({ platformOS, flagActive: false });
    assert.equal(
      resolveMirrorSelfieAvailable(),
      false,
      `${platformOS}: flag off must resolve unavailable regardless of platform`,
    );
  }
});

test('platform support is an explicit allowlist, not an Android denylist', () => {
  // The distinction matters: a denylist ("everything but android") silently
  // authorizes the next platform this app ships on (web, a future desktop
  // target) with no runtime review. An allowlist requires that decision to be
  // made on purpose.
  const { isMirrorSelfiePlatformSupported } = loadAvailabilityModule({
    platformOS: 'ios',
    flagActive: true,
  });
  for (const platformOS of ['android', 'web', 'windows', 'macos', '']) {
    assert.equal(isMirrorSelfiePlatformSupported(platformOS), false, `${platformOS} must not be supported`);
  }
  assert.equal(isMirrorSelfiePlatformSupported('ios'), true);
});

test('NEGATIVE CONTROL: this suite would fail if Android availability were accidentally restored', () => {
  const { resolveMirrorSelfieAvailable } = loadAvailabilityModule({
    platformOS: 'android',
    flagActive: true,
  });
  // The pre-repair defect, restated as a function: availability derived from
  // the flag alone. If a future change collapsed the canonical resolver back
  // to this, Android would again resolve available.
  const preRepairAvailable = (flagActive) => flagActive === true;

  assert.equal(
    preRepairAvailable(true),
    true,
    'sanity: the pre-repair, flag-only logic considers Android available whenever the flag is on',
  );
  assert.equal(
    resolveMirrorSelfieAvailable(),
    false,
    'the repaired resolver must refuse Android even though the flag is on',
  );
  assert.notEqual(
    resolveMirrorSelfieAvailable(),
    preRepairAvailable(true),
    'ANDROID-AVAILABILITY above is not vacuous: it disagrees with the exact defect it closes',
  );
});

// ══ PART B — the REAL app/library.tsx element tree, per platform ═══════════

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

/**
 * Renders the REAL app/library.tsx, with the REAL
 * services/mirror/mirrorSelfieAvailability.ts behind it (not a stub) so the
 * platform check genuinely executes. Only leaf UI/hook dependencies are
 * doubled, exactly as __tests__/recentScansClosetReleaseContract.test.js
 * already does for this screen.
 */
function renderLibrary({ platformOS, closetItems = [] } = {}) {
  const React = makeReact();
  const router = { push: () => {}, replace: () => {}, back: () => {}, setParams: () => {} };

  const luxury = { __esModule: true };
  for (const n of LUXURY_NAMES) luxury[n] = named(n);

  // Every EAS build profile on this release line sets the flag chain to
  // "true" (Build 2.5 Step 6 activation) — that is the actual production
  // configuration under repair, so it is the fixture here rather than a
  // parameter: the platform is what this suite varies.
  const featureFlags = {
    __esModule: true,
    AI_STYLIST_UI_ENABLED: true,
    STYLECHAT_ATTACHMENTS_ENABLED: true,
    CLOSET_SEPARATION_V1: true,
    CLOSET_DIRECT_INTAKE_ACTIVE: true,
    CLOSET_CANDIDATE_STAGING_ACTIVE: true,
    CLOSET_BATCH_REVIEW_V2_ACTIVE: true,
    MIRROR_SELFIE_V1_ACTIVE: true,
    PRIVATE_DRESSING_ROOM_V1: true,
  };

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
      Platform: { OS: platformOS, select: (o) => o[platformOS] ?? o.default },
    },
    'expo-router': {
      __esModule: true,
      router,
      useRouter: () => router,
      useFocusEffect: () => {},
      useLocalSearchParams: () => ({ section: 'closet' }),
    },
    'expo-status-bar': { __esModule: true, StatusBar: 'StatusBar' },
    '../hooks/useLibrary': {
      __esModule: true,
      useLibrary: () => ({ scans: [], loading: false, remove: async () => {}, actorKey: 'device-local' }),
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
    '../hooks/useResponsiveLayout': {
      __esModule: true,
      useResponsiveLayout: () => ({
        width: 390,
        height: 844,
        widthClass: 'compact',
        isRegular: false,
        isLandscape: false,
        contentWidth: 390,
        contentMaxWidth: 1024,
        formMaxWidth: 480,
        conversationMaxWidth: 720,
        modalMaxWidth: 560,
        gridColumns: 2,
        gridCellWidth: () => 160,
      }),
    },
    '../components/luxury': luxury,
    '../constants/featureFlags': featureFlags,
    // THE REAL resolver, loaded fresh against this render's platform, not a
    // deepStub — this is what makes PART B a genuine end-to-end proof rather
    // than a structural one.
    '../services/mirror/mirrorSelfieAvailability': loadAvailabilityModule({
      platformOS,
      flagActive: featureFlags.MIRROR_SELFIE_V1_ACTIVE,
    }),
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
  return { tree };
}

test('ANDROID-UI: production flags ON, Android platform -> no active Mirror Selfie entry', () => {
  const { tree } = renderLibrary({ platformOS: 'android', closetItems: [] });
  assert.equal(
    byTestID(tree, 'closet-mirror-selfie-button').length,
    0,
    'Android must not render the Mirror Selfie CTA even with every flag on',
  );
  // The sheet itself must not mount either — belt-and-suspenders against any
  // future caller that could otherwise flip a `visible` boolean without
  // going through the button (stale state, a future deep link).
  const modalMounts = collect(
    tree,
    (n) => typeof n.type === 'function' && n.type.toString().includes('MirrorSelfieExtractionModal'),
  );
  assert.equal(modalMounts.length, 0, 'Android must not mount the Mirror Selfie sheet at all');
});

test('IOS-UI: production flags ON, iOS platform -> the Mirror Selfie entry is reachable', () => {
  const { tree } = renderLibrary({ platformOS: 'ios', closetItems: [] });
  const [button] = byTestID(tree, 'closet-mirror-selfie-button');
  assert.ok(button, 'iOS must render the Mirror Selfie CTA when every flag is on');
  assert.equal(button.props.title, 'Mirror Selfie');
});

test('NEGATIVE CONTROL: the Android UI assertion actually discriminates on platform', () => {
  // Same flags, only the platform differs. If the platform gate were
  // dropped (a regression back to gating on the flag alone),
  // ANDROID-UI above would start failing to distinguish Android from iOS —
  // this pins that the two renders currently DO disagree, so that failure
  // mode is exactly what would go red.
  const android = renderLibrary({ platformOS: 'android', closetItems: [] });
  const ios = renderLibrary({ platformOS: 'ios', closetItems: [] });
  assert.notEqual(
    byTestID(android.tree, 'closet-mirror-selfie-button').length,
    byTestID(ios.tree, 'closet-mirror-selfie-button').length,
    'Android and iOS must not agree on Mirror Selfie reachability under identical flags',
  );
});
