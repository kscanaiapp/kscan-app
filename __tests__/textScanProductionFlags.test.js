const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadFlags(env) {
  const filename = path.join(ROOT, 'constants/featureFlags.ts');
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const module = { exports: {} };
  const sandbox = {
    __DEV__: false,
    process: { env },
    exports: module.exports,
    module,
    require: () => {
      throw new Error('Unexpected require in featureFlags');
    },
  };
  vm.runInNewContext(output, sandbox, { filename });
  return module.exports;
}

test('production intent enables TextScan UI and backend, disables demo', () => {
  const flags = loadFlags({
    EXPO_PUBLIC_ENABLE_TEXTSCAN: 'true',
    EXPO_PUBLIC_TEXTSCAN_BACKEND_ENABLED: 'true',
    EXPO_PUBLIC_TEXTSCAN_DEMO_RESULTS: 'false',
  });
  assert.equal(flags.TEXTSCAN_UI_ENABLED, true);
  assert.equal(flags.TEXTSCAN_BACKEND_ENABLED, true);
  assert.equal(flags.TEXTSCAN_DEMO_RESULTS_ENABLED, false);
});

test('explicit false disables TextScan UI', () => {
  const flags = loadFlags({
    EXPO_PUBLIC_ENABLE_TEXTSCAN: 'false',
    EXPO_PUBLIC_TEXTSCAN_BACKEND_ENABLED: 'true',
  });
  assert.equal(flags.TEXTSCAN_UI_ENABLED, false);
});

test('missing TextScan env keeps production-safe defaults', () => {
  const flags = loadFlags({});
  // UI defaults on unless explicitly false; demo stays off; backend stays off.
  assert.equal(flags.TEXTSCAN_UI_ENABLED, true);
  assert.equal(flags.TEXTSCAN_DEMO_RESULTS_ENABLED, false);
  assert.equal(flags.TEXTSCAN_BACKEND_ENABLED, false);
});

test('demo results only enable on explicit true', () => {
  assert.equal(loadFlags({ EXPO_PUBLIC_TEXTSCAN_DEMO_RESULTS: 'true' }).TEXTSCAN_DEMO_RESULTS_ENABLED, true);
  assert.equal(loadFlags({ EXPO_PUBLIC_TEXTSCAN_DEMO_RESULTS: 'false' }).TEXTSCAN_DEMO_RESULTS_ENABLED, false);
  assert.equal(loadFlags({ EXPO_PUBLIC_TEXTSCAN_DEMO_RESULTS: '' }).TEXTSCAN_DEMO_RESULTS_ENABLED, false);
});

test('backend disabled when env missing or false', () => {
  assert.equal(loadFlags({}).TEXTSCAN_BACKEND_ENABLED, false);
  assert.equal(loadFlags({ EXPO_PUBLIC_TEXTSCAN_BACKEND_ENABLED: 'false' }).TEXTSCAN_BACKEND_ENABLED, false);
  assert.equal(loadFlags({ EXPO_PUBLIC_TEXTSCAN_BACKEND_ENABLED: 'true' }).TEXTSCAN_BACKEND_ENABLED, true);
});

test('cloud saved scans remain disabled unless explicit true', () => {
  assert.equal(loadFlags({}).CLOUD_SAVED_SCANS_ENABLED, false);
  assert.equal(loadFlags({ EXPO_PUBLIC_CLOUD_SAVED_SCANS_ENABLED: 'TRUE' }).CLOUD_SAVED_SCANS_ENABLED, true);
  assert.equal(loadFlags({ EXPO_PUBLIC_CLOUD_SAVED_SCANS_ENABLED: ' false ' }).CLOUD_SAVED_SCANS_ENABLED, false);
});

test('TextScan routes into Elise / StyleChat handoff', () => {
  const textScan = fs.readFileSync(path.join(ROOT, 'app/text-scan/index.tsx'), 'utf8');
  assert.match(textScan, /setStyleChatHandoffContext/);
  assert.match(textScan, /source:\s*['"]text-scan['"]/);
  assert.match(textScan, /router\.push\(['"]\/style-chat['"]\)/);
});

test('eas production profile pins TextScan flags', () => {
  const eas = JSON.parse(fs.readFileSync(path.join(ROOT, 'eas.json'), 'utf8'));
  const env = eas.build.production.env;
  assert.equal(env.EXPO_PUBLIC_ENABLE_TEXTSCAN, 'true');
  assert.equal(env.EXPO_PUBLIC_TEXTSCAN_BACKEND_ENABLED, 'true');
  assert.equal(env.EXPO_PUBLIC_TEXTSCAN_DEMO_RESULTS, 'false');
  assert.equal(env.EXPO_PUBLIC_CLOUD_SAVED_SCANS_ENABLED, undefined);
});
