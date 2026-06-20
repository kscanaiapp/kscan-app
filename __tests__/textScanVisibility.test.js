const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadFeatureFlags(env, dev = false) {
  const filename = path.join(ROOT, 'constants', 'featureFlags.ts');
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;

  const mod = { exports: {} };
  vm.runInNewContext(output, {
    __DEV__: dev,
    exports: mod.exports,
    module: mod,
    process: { env },
  }, { filename });
  return mod.exports;
}

test('isTextScanVisible: local switch always wins', () => {
  const flags = loadFeatureFlags({ EXPO_PUBLIC_APP_ENV: 'staging' });
  assert.equal(flags.isTextScanVisible({
    localEnabled: false,
    remoteTextScanEnabled: true,
    remoteFlagError: true,
  }), false);
});

test('isTextScanVisible: production stays controlled by remote state', () => {
  const flags = loadFeatureFlags({ EXPO_PUBLIC_APP_ENV: 'production' });
  assert.equal(flags.isTextScanVisible({
    localEnabled: true,
    remoteTextScanEnabled: false,
    remoteFlagError: true,
  }), false);
  assert.equal(flags.isTextScanVisible({
    localEnabled: true,
    remoteTextScanEnabled: true,
    remoteFlagError: false,
  }), true);
});

test('isTextScanVisible: staging fails open only on remote error/loading', () => {
  const flags = loadFeatureFlags({ EXPO_PUBLIC_APP_ENV: 'staging' });
  assert.equal(flags.isTextScanVisible({
    localEnabled: true,
    remoteTextScanEnabled: false,
    remoteFlagError: false,
  }), false);
  assert.equal(flags.isTextScanVisible({
    localEnabled: true,
    remoteTextScanEnabled: false,
    remoteFlagError: true,
  }), true);
  assert.equal(flags.isTextScanVisible({
    localEnabled: true,
    remoteTextScanEnabled: null,
    remoteFlagError: false,
  }), true);
});

test('isTextScanVisible: dev builds fail open while FeatureFreeze is loading', () => {
  const flags = loadFeatureFlags({}, true);
  assert.equal(flags.isTextScanVisible({
    localEnabled: true,
    remoteTextScanEnabled: null,
  }), true);
});
