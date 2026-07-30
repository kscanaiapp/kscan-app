// Build 5 Phase 1 — Today with Elise feature-flag contract.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const FLAGS_PATH = path.join(ROOT, 'constants', 'featureFlags.ts');
const EAS_PATH = path.join(ROOT, 'eas.json');

const flagsSource = fs.readFileSync(FLAGS_PATH, 'utf8');
const eas = JSON.parse(fs.readFileSync(EAS_PATH, 'utf8'));

function loadFlags(env = {}) {
  const source = ts.transpileModule(flagsSource, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const sandbox = {
    module: { exports: {} },
    exports: {},
    require: () => ({}),
    process: { env },
    __DEV__: false,
    console,
  };
  sandbox.module.exports = sandbox.exports;
  vm.runInNewContext(source, sandbox, { filename: 'constants/featureFlags.ts' });
  return sandbox.module.exports;
}

const ON = 'true';
const FALSE_LIKE = ['TRUE', 'True', '1', 'yes', 'on', '', ' true', 'true ', 'false', undefined, null];

test('Today with Elise parent defaults OFF when absent', () => {
  const flags = loadFlags({});
  assert.equal(flags.TODAY_WITH_ELISE_V1, false);
  assert.equal(flags.TODAY_WITH_ELISE_ACTIVE, false);
  assert.equal(flags.TODAY_WITH_ELISE_GENERATED_GREETING_ACTIVE, false);
  assert.equal(flags.TODAY_WITH_ELISE_WEATHER_ACTIVE, false);
});

test('false-like and malformed parent values stay OFF', () => {
  for (const value of FALSE_LIKE) {
    assert.equal(
      loadFlags({ EXPO_PUBLIC_TODAY_WITH_ELISE_V1: value }).TODAY_WITH_ELISE_V1,
      false,
      String(value),
    );
  }
  assert.equal(loadFlags({ EXPO_PUBLIC_TODAY_WITH_ELISE_V1: ON }).TODAY_WITH_ELISE_V1, true);
});

test('generated greeting without parent stays OFF', () => {
  const flags = loadFlags({
    EXPO_PUBLIC_TODAY_WITH_ELISE_GENERATED_GREETING_V1: ON,
  });
  assert.equal(flags.TODAY_WITH_ELISE_GENERATED_GREETING_V1, true);
  assert.equal(flags.TODAY_WITH_ELISE_GENERATED_GREETING_ACTIVE, false);
});

test('weather without parent stays OFF', () => {
  const flags = loadFlags({
    EXPO_PUBLIC_TODAY_WITH_ELISE_WEATHER_V1: ON,
  });
  assert.equal(flags.TODAY_WITH_ELISE_WEATHER_V1, true);
  assert.equal(flags.TODAY_WITH_ELISE_WEATHER_ACTIVE, false);
});

test('children activate only with parent', () => {
  const flags = loadFlags({
    EXPO_PUBLIC_TODAY_WITH_ELISE_V1: ON,
    EXPO_PUBLIC_TODAY_WITH_ELISE_GENERATED_GREETING_V1: ON,
    EXPO_PUBLIC_TODAY_WITH_ELISE_WEATHER_V1: ON,
  });
  assert.equal(flags.TODAY_WITH_ELISE_ACTIVE, true);
  assert.equal(flags.TODAY_WITH_ELISE_GENERATED_GREETING_ACTIVE, true);
  assert.equal(flags.TODAY_WITH_ELISE_WEATHER_ACTIVE, true);
});

test('production and preview EAS profiles leave Today flags unset', () => {
  for (const profileName of ['production', 'preview', 'development']) {
    const profile = eas.build?.[profileName];
    if (!profile) continue;
    const env = profile.env || {};
    assert.equal(
      env.EXPO_PUBLIC_TODAY_WITH_ELISE_V1,
      undefined,
      `${profileName} must not set TODAY_WITH_ELISE_V1`,
    );
    assert.equal(
      env.EXPO_PUBLIC_TODAY_WITH_ELISE_GENERATED_GREETING_V1,
      undefined,
      `${profileName} must not set GENERATED_GREETING`,
    );
    assert.equal(
      env.EXPO_PUBLIC_TODAY_WITH_ELISE_WEATHER_V1,
      undefined,
      `${profileName} must not set WEATHER`,
    );
  }
});

test('pure resolvers fail closed', () => {
  const flags = loadFlags({});
  assert.equal(flags.resolveTodayWithEliseActive(false), false);
  assert.equal(flags.resolveTodayWithEliseGeneratedGreetingActive(false, true), false);
  assert.equal(flags.resolveTodayWithEliseWeatherActive(true, false), false);
  assert.equal(flags.resolveTodayWithEliseWeatherActive(true, true), true);
});
