const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadService({ initial = {}, remotelyComplete = false } = {}) {
  const storage = new Map(Object.entries(initial));
  let remoteChecks = 0;
  const asyncStorage = {
    getItem: async (key) => storage.get(key) ?? null,
    setItem: async (key, value) => { storage.set(key, value); },
    removeItem: async (key) => { storage.delete(key); },
  };
  const filename = path.join(ROOT, 'services/onboardingCompletion.ts');
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, {
    __DEV__: false,
    Map,
    Set,
    console,
    exports: module.exports,
    module,
    require: (id) => {
      if (id === '@react-native-async-storage/async-storage') return asyncStorage;
      if (id === './legalAcceptance') {
        return {
          hasCurrentLegalAcceptances: async () => {
            remoteChecks += 1;
            return remotelyComplete;
          },
        };
      }
      throw new Error(`Unexpected require: ${id}`);
    },
  }, { filename });
  return {
    ...module.exports,
    getRemoteChecks: () => remoteChecks,
    storage,
  };
}

test('local onboarding completion remains the fast path without a remote read', async () => {
  const service = loadService({
    initial: { 'onboardingComplete:private-user': 'true' },
  });

  assert.equal(await service.resolveOnboardingCompletion('private-user'), true);
  assert.equal(service.getRemoteChecks(), 0);
});

test('remote legal evidence restores the local completion flag after app data is cleared', async () => {
  const service = loadService({ remotelyComplete: true });

  assert.equal(await service.resolveOnboardingCompletion('private-user'), true);
  assert.equal(service.getRemoteChecks(), 1);
  assert.equal(service.storage.get('onboardingComplete:private-user'), 'true');
});

test('a new OAuth identity without remote legal evidence stays incomplete', async () => {
  const service = loadService({ remotelyComplete: false });

  assert.equal(await service.resolveOnboardingCompletion('private-user'), false);
  assert.equal(service.getRemoteChecks(), 1);
  assert.equal(service.storage.has('onboardingComplete:private-user'), false);
});
