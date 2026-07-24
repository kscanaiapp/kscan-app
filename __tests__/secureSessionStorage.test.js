'use strict';

// Regression coverage for services/secureSessionStorage.ts (Batch 1 — secure sessions).
// Native sessions (refresh tokens) must live in the platform keystore/keychain, with a
// SAFE migration from legacy AsyncStorage: a keystore-write failure must never destroy a
// still-valid legacy session (otherwise an upgrade would silently sign the user out).
// The module imports native RN packages, so it is loaded through a transpile + vm sandbox
// with in-memory mocks (same pattern as the other backend contract tests).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const SRC = path.join(__dirname, '..', 'services', 'secureSessionStorage.ts');

function loadSecureSessionStorage({ platformOS = 'ios', failSecureSet = false } = {}) {
  const secure = {}; // keychain backing
  const legacy = {}; // AsyncStorage backing
  const state = { failSecureSet };

  const SecureStore = {
    async getItemAsync(key) {
      return Object.prototype.hasOwnProperty.call(secure, key) ? secure[key] : null;
    },
    async setItemAsync(key, value) {
      if (state.failSecureSet) throw new Error('keychain write failed');
      secure[key] = value;
    },
    async deleteItemAsync(key) {
      delete secure[key];
    },
  };
  const AsyncStorage = {
    async getItem(key) {
      return Object.prototype.hasOwnProperty.call(legacy, key) ? legacy[key] : null;
    },
    async setItem(key, value) {
      legacy[key] = value;
    },
    async removeItem(key) {
      delete legacy[key];
    },
  };

  const requireMap = {
    'expo-secure-store': SecureStore,
    '@react-native-async-storage/async-storage': { default: AsyncStorage, __esModule: true },
    'react-native': { Platform: { OS: platformOS } },
  };

  const source = fs.readFileSync(SRC, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;

  const mod = { exports: {} };
  const sandbox = {
    module: mod,
    exports: mod.exports,
    console,
    require: (id) => {
      if (id in requireMap) return requireMap[id];
      if (id.startsWith('node:')) return require(id);
      throw new Error(`Unexpected require: ${id}`);
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(output, sandbox, { filename: SRC });
  return { storage: mod.exports.secureSessionStorage, secure, legacy, state };
}

test('web uses AsyncStorage only (no keystore on web)', async () => {
  const { storage, secure, legacy } = loadSecureSessionStorage({ platformOS: 'web' });
  await storage.setItem('k', 'v');
  assert.equal(legacy.k, 'v');
  assert.equal(secure.k, undefined);
  assert.equal(await storage.getItem('k'), 'v');
  await storage.removeItem('k');
  assert.equal(legacy.k, undefined);
});

test('native getItem returns the keystore value when present', async () => {
  const { storage, secure } = loadSecureSessionStorage({ platformOS: 'ios' });
  secure.session = 'keychain-token';
  assert.equal(await storage.getItem('session'), 'keychain-token');
});

test('native getItem migrates a legacy AsyncStorage session into the keystore', async () => {
  const { storage, secure, legacy } = loadSecureSessionStorage({ platformOS: 'ios' });
  legacy.session = 'legacy-token';
  const value = await storage.getItem('session');
  assert.equal(value, 'legacy-token');
  assert.equal(secure.session, 'legacy-token', 'migrated into keystore');
  assert.equal(legacy.session, undefined, 'legacy copy removed only after secure write succeeds');
});

test('native getItem migration failure PRESERVES the legacy session (no silent sign-out)', async () => {
  const { storage, secure, legacy } = loadSecureSessionStorage({ platformOS: 'ios', failSecureSet: true });
  legacy.session = 'legacy-token';
  await assert.rejects(() => storage.getItem('session'), /keychain write failed/);
  // The invariant: the legacy session must still exist so a later read can recover it.
  assert.equal(legacy.session, 'legacy-token', 'legacy session must NOT be removed when the keystore write fails');
  assert.equal(secure.session, undefined);
});

test('native getItem returns null when neither store has the key', async () => {
  const { storage } = loadSecureSessionStorage({ platformOS: 'ios' });
  assert.equal(await storage.getItem('missing'), null);
});

test('native setItem writes the keystore and clears the legacy copy', async () => {
  const { storage, secure, legacy } = loadSecureSessionStorage({ platformOS: 'ios' });
  legacy.session = 'old';
  await storage.setItem('session', 'new');
  assert.equal(secure.session, 'new');
  assert.equal(legacy.session, undefined);
});

test('native removeItem clears both keystore and legacy locations', async () => {
  const { storage, secure, legacy } = loadSecureSessionStorage({ platformOS: 'ios' });
  secure.session = 'a';
  legacy.session = 'b';
  await storage.removeItem('session');
  assert.equal(secure.session, undefined);
  assert.equal(legacy.session, undefined);
});
