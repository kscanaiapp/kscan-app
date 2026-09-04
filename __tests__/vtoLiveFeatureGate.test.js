// P3-C: the Live VTO feature gate, the harness lock, and safe module absence.
//
// THE LAUNCH POSTURE THIS FILE PINS. Live defaults OFF, is set in no EAS
// profile, is a DIFFERENT switch from the generative VTO flag, and cannot be
// reached by a customer on any build that exists today. A build with no Live
// native module -- which is every build -- starts normally and shows exactly
// the AI Photo experience it showed before this lane existed.
//
// These are the assertions that make "this PR is safe to merge without
// exposing Live" a checked claim rather than an intention.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const code = (rel) => stripComments(read(rel));

function loadTsModule(relativePath, requireMap = {}, sandboxExtras = {}) {
  const filename = path.join(ROOT, relativePath);
  const output = ts.transpileModule(read(relativePath), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const mod = { exports: {} };
  const sandbox = {
    console,
    exports: mod.exports,
    module: mod,
    URL, Math, Number, Set, Map, Object, Array, JSON, Date, RangeError, String, Promise,
    __DEV__: false,
    process: { env: {} },
    ...sandboxExtras,
    require: (specifier) => {
      if (Object.prototype.hasOwnProperty.call(requireMap, specifier)) {
        return requireMap[specifier];
      }
      throw new Error(`Unexpected import in ${path.basename(filename)}: ${specifier}`);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename }).runInContext(sandbox);
  return mod.exports;
}

const flags = loadTsModule('constants/featureFlags.ts');
const easProfiles = JSON.parse(read('eas.json')).build;

// ── The flag itself ─────────────────────────────────────────────────────────

test('flag: only the exact string "true" opts in', () => {
  assert.equal(flags.resolveLiveVtoEnabled('true'), true);
  for (const value of [undefined, '', 'false', 'TRUE', '1', 'yes', 'True', ' true']) {
    assert.equal(flags.resolveLiveVtoEnabled(value), false, JSON.stringify(value));
  }
});

test('flag: it defaults OFF with nothing in the environment', () => {
  assert.equal(flags.LIVE_VTO_ENABLED, false);
});

test('flag: Live is a DIFFERENT switch from the generative VTO surface', () => {
  // Conflating them would mean turning Live off after a problem also takes AI
  // Photo down -- and turning Live on silently changes the generative
  // surface's rollout state.
  assert.notEqual(
    'EXPO_PUBLIC_LIVE_VTO_ENABLED',
    'EXPO_PUBLIC_VTO_UI_ENABLED',
  );
  const source = code('constants/featureFlags.ts');
  assert.ok(source.includes('EXPO_PUBLIC_LIVE_VTO_ENABLED'));
  assert.ok(source.includes('EXPO_PUBLIC_VTO_UI_ENABLED'));
  // The two resolvers are independent functions; neither reads the other's var.
  const liveResolver = source.match(/export function resolveLiveVtoEnabled[\s\S]*?\n\}/)[0];
  assert.ok(!liveResolver.includes('EXPO_PUBLIC_VTO_UI_ENABLED'));
  const vtoResolver = source.match(/export function resolveVtoUiEnabled[\s\S]*?\n\}/)[0];
  assert.ok(!vtoResolver.includes('EXPO_PUBLIC_LIVE_VTO_ENABLED'));
});

test('flag: no EAS profile sets it -- production and staging included', () => {
  const forbidden = ['EXPO_PUBLIC_LIVE_VTO_ENABLED', 'EXPO_PUBLIC_LIVE_VTO_HARNESS'];
  for (const [name, profile] of Object.entries(easProfiles)) {
    const env = profile.env ?? {};
    for (const key of forbidden) {
      assert.ok(
        !(key in env),
        `${name} must not define ${key} -- Live is not enabled anywhere by this lane`,
      );
    }
  }
});

test('flag: the generative VTO profile posture is unchanged by this lane', () => {
  // EXPO_PUBLIC_VTO_UI_ENABLED stays exactly where it was: staging-certification
  // only, production carrying no VTO UI at all.
  const withVtoUi = Object.entries(easProfiles)
    .filter(([, profile]) => (profile.env ?? {}).EXPO_PUBLIC_VTO_UI_ENABLED === 'true')
    .map(([name]) => name)
    .sort();
  assert.deepEqual(withVtoUi, ['staging-certification']);
  assert.ok(!('EXPO_PUBLIC_VTO_UI_ENABLED' in (easProfiles.production.env ?? {})));
});

// ── The harness cannot escape development ───────────────────────────────────

test('harness: the flag folds to false in a non-dev build regardless of env', () => {
  const productionish = loadTsModule('constants/featureFlags.ts', {}, {
    __DEV__: false,
    process: { env: { EXPO_PUBLIC_LIVE_VTO_HARNESS: 'true' } },
  });
  assert.equal(productionish.LIVE_VTO_HARNESS_ENABLED, false);
});

test('harness: even in development it stays off until explicitly armed', () => {
  const devFlags = loadTsModule('constants/featureFlags.ts', {}, {
    __DEV__: true,
    process: { env: { EXPO_PUBLIC_LIVE_VTO_HARNESS: 'true' } },
  });
  assert.equal(devFlags.LIVE_VTO_HARNESS_ENABLED, true);

  const harness = loadTsModule('services/vto/vtoLiveHarness.ts', {
    '../../constants/featureFlags': { LIVE_VTO_HARNESS_ENABLED: true },
    '../../types/vtoLive': {},
    './liveVtoNativeModule': {},
    './vtoLiveCapability': {},
  });
  // Armed variable, unarmed harness: setting the env var is not activation.
  assert.equal(harness.isLiveVtoHarnessActive(), false);
  assert.equal(harness.getLiveVtoHarnessState(), null);

  assert.equal(harness.activateLiveVtoHarness('LIVE_AVAILABLE'), true);
  assert.equal(harness.isLiveVtoHarnessActive(), true);
  harness.deactivateLiveVtoHarness();
  assert.equal(harness.isLiveVtoHarnessActive(), false);
});

test('harness: activation is refused outright when the flag is false', () => {
  const harness = loadTsModule('services/vto/vtoLiveHarness.ts', {
    '../../constants/featureFlags': { LIVE_VTO_HARNESS_ENABLED: false },
    '../../types/vtoLive': {},
    './liveVtoNativeModule': {},
    './vtoLiveCapability': {},
  });
  for (const scenario of harness.LIVE_VTO_HARNESS_SCENARIOS) {
    assert.equal(harness.activateLiveVtoHarness(scenario), false, scenario);
  }
  assert.equal(harness.getLiveVtoHarnessState(), null);
});

test('harness: an unknown scenario is refused rather than silently accepted', () => {
  const harness = loadTsModule('services/vto/vtoLiveHarness.ts', {
    '../../constants/featureFlags': { LIVE_VTO_HARNESS_ENABLED: true },
    '../../types/vtoLive': {},
    './liveVtoNativeModule': {},
    './vtoLiveCapability': {},
  });
  assert.equal(harness.activateLiveVtoHarness('DO_WHATEVER_I_WANT'), false);
  assert.equal(harness.isLiveVtoHarnessActive(), false);
});

test('harness: every scenario is simulated and provider-inert, and none claims to be native', () => {
  const harness = loadTsModule('services/vto/vtoLiveHarness.ts', {
    '../../constants/featureFlags': { LIVE_VTO_HARNESS_ENABLED: true },
    '../../types/vtoLive': {},
    './liveVtoNativeModule': {},
    './vtoLiveCapability': {},
  });
  for (const scenario of harness.LIVE_VTO_HARNESS_SCENARIOS) {
    harness.activateLiveVtoHarness(scenario);
    const state = harness.getLiveVtoHarnessState();
    assert.equal(state.scenario, scenario);
    assert.equal(state.providerInert, true, scenario);
    assert.equal(
      state.nativeCapability.provenance,
      'simulated',
      `${scenario} must never present itself as native evidence`,
    );
  }
  harness.deactivateLiveVtoHarness();
});

test('harness: it has no frame concept at all -- it cannot inject camera data', () => {
  const source = code('services/vto/vtoLiveHarness.ts');
  for (const pattern of [/frame/i, /pixel/i, /mask/i, /landmark/i, /camera(?!Permission)/i, /base64/i]) {
    assert.ok(!pattern.test(source), `the harness must not mention ${pattern}`);
  }
});

test('harness: the real native describer never emits simulated provenance', () => {
  const adapter = loadTsModule('services/vto/liveVtoNativeModule.ts', {
    'react-native': { Platform: { OS: 'ios' } },
    '../../constants/featureFlags': { LIVE_VTO_NATIVE_MODULE_NAME: 'KScanLiveVto' },
    '../../types/vtoLive': loadTsModule('types/vtoLive.ts'),
  });
  const answers = [
    adapter.describeLiveVtoNativeCapability({ module: null }),
    adapter.describeLiveVtoNativeCapability({ module: null, platformOS: 'web' }),
    adapter.describeLiveVtoNativeCapability({
      module: { getCapability: () => ({ capable: true, runtimeReady: true }) },
    }),
  ];
  for (const answer of answers) {
    assert.equal(answer.provenance, 'native');
  }
});

// ── Safe absence of the native module ───────────────────────────────────────

test('absent module: nothing native is touched at import time', () => {
  // A resolution problem must not be able to participate in app STARTUP. The
  // lookup is inside a function, so importing this module is inert.
  const source = code('services/vto/liveVtoNativeModule.ts');
  const moduleScope = source.split(/export function|function /)[0];
  assert.ok(!moduleScope.includes('requireOptionalNativeModule'));
  assert.ok(!moduleScope.includes("require('expo-modules-core')"));
  // And it uses the OPTIONAL variant, which returns null instead of throwing.
  assert.ok(source.includes('requireOptionalNativeModule'));
  assert.ok(!/[^l]requireNativeModule\b/.test(source));
});

test('absent module: a missing module reports module_missing, never throws', () => {
  const adapter = loadTsModule('services/vto/liveVtoNativeModule.ts', {
    'react-native': { Platform: { OS: 'android' } },
    '../../constants/featureFlags': { LIVE_VTO_NATIVE_MODULE_NAME: 'KScanLiveVto' },
    '../../types/vtoLive': loadTsModule('types/vtoLive.ts'),
    'expo-modules-core': { requireOptionalNativeModule: () => null },
  });
  const capability = adapter.describeLiveVtoNativeCapability();
  assert.equal(capability.present, false);
  assert.equal(capability.reason, 'module_missing');
  assert.equal(adapter.isLiveVtoNativeCapable(capability), false);
});

test('absent module: an expo-modules-core that throws is absence, not a crash', () => {
  const adapter = loadTsModule('services/vto/liveVtoNativeModule.ts', {
    'react-native': { Platform: { OS: 'ios' } },
    '../../constants/featureFlags': { LIVE_VTO_NATIVE_MODULE_NAME: 'KScanLiveVto' },
    '../../types/vtoLive': loadTsModule('types/vtoLive.ts'),
    'expo-modules-core': {
      requireOptionalNativeModule: () => {
        throw new Error('bridge not initialized');
      },
    },
  });
  assert.doesNotThrow(() => adapter.describeLiveVtoNativeCapability());
  assert.equal(adapter.describeLiveVtoNativeCapability().present, false);
});

test('absent module: an unsupported platform is reported as such', () => {
  const adapter = loadTsModule('services/vto/liveVtoNativeModule.ts', {
    'react-native': { Platform: { OS: 'web' } },
    '../../constants/featureFlags': { LIVE_VTO_NATIVE_MODULE_NAME: 'KScanLiveVto' },
    '../../types/vtoLive': loadTsModule('types/vtoLive.ts'),
  });
  assert.equal(adapter.describeLiveVtoNativeCapability().reason, 'unsupported_platform');
  assert.equal(adapter.getLiveVtoNativeModule(), null);
});

// ── Registration is not capability ──────────────────────────────────────────

test('capability: a registered module is NOT capable on its own say-so', () => {
  const adapter = loadTsModule('services/vto/liveVtoNativeModule.ts', {
    'react-native': { Platform: { OS: 'ios' } },
    '../../constants/featureFlags': { LIVE_VTO_NATIVE_MODULE_NAME: 'KScanLiveVto' },
    '../../types/vtoLive': loadTsModule('types/vtoLive.ts'),
  });
  const cases = [
    [{}, false],
    [{ getCapability: () => ({}) }, false],
    [{ getCapability: () => ({ capable: true }) }, false],
    [{ getCapability: () => ({ capable: true, runtimeReady: false }) }, false],
    // Truthy-but-not-true must not read as an affirmation.
    [{ getCapability: () => ({ capable: 'yes', runtimeReady: 'yes' }) }, false],
    [{ getCapability: () => ({ capable: 1, runtimeReady: 1 }) }, false],
    [{ getCapability: () => null }, false],
    [{ getCapability: () => { throw new Error('nope'); } }, false],
    [{ getCapability: () => ({ capable: true, runtimeReady: true }) }, true],
  ];
  for (const [moduleStub, expected] of cases) {
    const capability = adapter.describeLiveVtoNativeCapability({ module: moduleStub });
    assert.equal(
      adapter.isLiveVtoNativeCapable(capability),
      expected,
      JSON.stringify(Object.keys(moduleStub)),
    );
  }
});

test('capability: the describer is synchronous and total', () => {
  // A capability question that can hang is a VTO sheet that can hang.
  const source = code('services/vto/liveVtoNativeModule.ts');
  const describer = source.match(/export function describeLiveVtoNativeCapability[\s\S]*?\n\}/)[0];
  assert.ok(!describer.includes('await'));
  assert.ok(!describer.includes('async'));
  assert.ok(!describer.includes('setTimeout'));
});

// ── The remote kill switch defaults to off ──────────────────────────────────

test('remote config: a row with no live block leaves Live off', () => {
  const control = loadTsModule('services/vto/vtoFeatureControl.ts', {
    '../supabaseClient': { supabase: {} },
    '../../constants/featureFlags': { VTO_CONFIG_KEY: 'vto_generation' },
    './vtoEligibility': { DEFAULT_VTO_SUPPORTED_CATEGORIES: ['top', 'outerwear'] },
    './vtoLiveGarment': { DEFAULT_LIVE_VTO_SUPPORTED_CATEGORIES: ['top'] },
  });
  // Every row that exists in every environment today looks like this.
  const legacy = control.normalizeVtoRemoteConfig({ enabled: true, supportedCategories: ['top'] });
  assert.equal(legacy.enabled, true, 'the generative surface is unaffected');
  assert.equal(legacy.liveEnabled, false, 'a pre-Live row must not enable Live');
});

test('remote config: only an explicit nested live.enabled === true turns Live on', () => {
  const control = loadTsModule('services/vto/vtoFeatureControl.ts', {
    '../supabaseClient': { supabase: {} },
    '../../constants/featureFlags': { VTO_CONFIG_KEY: 'vto_generation' },
    './vtoEligibility': { DEFAULT_VTO_SUPPORTED_CATEGORIES: ['top', 'outerwear'] },
    './vtoLiveGarment': { DEFAULT_LIVE_VTO_SUPPORTED_CATEGORIES: ['top'] },
  });
  assert.equal(control.normalizeVtoRemoteConfig({ live: { enabled: true } }).liveEnabled, true);
  for (const payload of [
    { live: { enabled: 'true' } },
    { live: { enabled: 1 } },
    { live: true },
    { live: [] },
    { liveEnabled: true },
    { enabled: true },
    null,
    'nope',
  ]) {
    assert.equal(
      control.normalizeVtoRemoteConfig(payload).liveEnabled,
      false,
      JSON.stringify(payload),
    );
  }
});

test('remote config: the two switches are independent in both directions', () => {
  const control = loadTsModule('services/vto/vtoFeatureControl.ts', {
    '../supabaseClient': { supabase: {} },
    '../../constants/featureFlags': { VTO_CONFIG_KEY: 'vto_generation' },
    './vtoEligibility': { DEFAULT_VTO_SUPPORTED_CATEGORIES: ['top', 'outerwear'] },
    './vtoLiveGarment': { DEFAULT_LIVE_VTO_SUPPORTED_CATEGORIES: ['top'] },
  });
  const liveOnly = control.normalizeVtoRemoteConfig({ enabled: false, live: { enabled: true } });
  assert.equal(liveOnly.enabled, false);
  assert.equal(liveOnly.liveEnabled, true);

  const generativeOnly = control.normalizeVtoRemoteConfig({ enabled: true, live: { enabled: false } });
  assert.equal(generativeOnly.enabled, true);
  assert.equal(generativeOnly.liveEnabled, false);
});

test('remote config: a partially-malformed category list falls back whole', () => {
  const control = loadTsModule('services/vto/vtoFeatureControl.ts', {
    '../supabaseClient': { supabase: {} },
    '../../constants/featureFlags': { VTO_CONFIG_KEY: 'vto_generation' },
    './vtoEligibility': { DEFAULT_VTO_SUPPORTED_CATEGORIES: ['top', 'outerwear'] },
    './vtoLiveGarment': { DEFAULT_LIVE_VTO_SUPPORTED_CATEGORIES: ['top'] },
  });
  const result = control.normalizeVtoRemoteConfig({
    supportedCategories: ['top', 42],
    live: { enabled: true, supportedCategories: ['top', null] },
  });
  assert.deepEqual([...result.supportedCategories], ['top', 'outerwear']);
  assert.deepEqual([...result.liveSupportedCategories], ['top']);
});
