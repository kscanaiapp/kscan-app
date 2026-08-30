// K+ boundary FEATURE FLAG suite.
//
// Proves KPLUS_EARLY_ACCESS_ENABLED fails closed on anything but the exact
// string 'true', and that VOICESCAN_ENABLED (an unrelated, hardcoded-false
// mic-permission flag) is untouched by this build.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const FLAGS_PATH = path.join(ROOT, 'constants', 'featureFlags.ts');
const flagsSource = fs.readFileSync(FLAGS_PATH, 'utf8');

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

test('KPLUS_EARLY_ACCESS_ENABLED defaults off', () => {
  const flags = loadFlags({});
  assert.equal(flags.KPLUS_EARLY_ACCESS_ENABLED, false);
});

test('resolveKPlusEarlyAccessEnabled fails closed on anything but the exact string "true"', () => {
  const flags = loadFlags({});
  for (const value of [undefined, '', 'false', 'TRUE', '1', 'yes', 'true ']) {
    assert.equal(flags.resolveKPlusEarlyAccessEnabled(value), false, `expected false for ${JSON.stringify(value)}`);
  }
  assert.equal(flags.resolveKPlusEarlyAccessEnabled('true'), true);
});

test('KPLUS_EARLY_ACCESS_ENABLED turns on only via EXPO_PUBLIC_KPLUS_EARLY_ACCESS_ENABLED=true', () => {
  assert.equal(loadFlags({ EXPO_PUBLIC_KPLUS_EARLY_ACCESS_ENABLED: 'true' }).KPLUS_EARLY_ACCESS_ENABLED, true);
  assert.equal(loadFlags({ EXPO_PUBLIC_KPLUS_EARLY_ACCESS_ENABLED: 'false' }).KPLUS_EARLY_ACCESS_ENABLED, false);
});

test('VOICESCAN_ENABLED remains the unrelated, hardcoded-false mic-permission flag', () => {
  const flags = loadFlags({ EXPO_PUBLIC_KPLUS_EARLY_ACCESS_ENABLED: 'true' });
  assert.equal(flags.VOICESCAN_ENABLED, false);
  assert.match(flagsSource, /export const VOICESCAN_ENABLED = false;/);
});
