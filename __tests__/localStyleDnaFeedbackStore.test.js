const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    async getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    async setItem(key, value) {
      map.set(key, value);
    },
    async removeItem(key) {
      map.delete(key);
    },
    async getAllKeys() {
      return [...map.keys()];
    },
    async multiRemove(keys) {
      keys.forEach((k) => map.delete(k));
    },
  };
}

function loadStore(storage, env = {}) {
  const filename = path.join(ROOT, 'services/style-dna/localStyleDnaFeedbackStore.ts');
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
    console,
    process: { env },
    exports: module.exports,
    module,
    require: (id) => {
      if (id === '@react-native-async-storage/async-storage') {
        return { __esModule: true, default: storage };
      }
      throw new Error(`Unexpected require: ${id}`);
    },
  };
  vm.runInNewContext(output, sandbox, { filename });
  return module.exports;
}

const U = 'user:abc-123';
const S = 'session-1';
const M = 'msg-uuid-1';

test('read for unknown message returns null', async () => {
  const store = loadStore(makeStorage());
  const r = await store.getFeedbackForMessage({ userKey: U, sessionId: S, messageId: M });
  assert.equal(r, null);
});

test('write helpful then read returns helpful', async () => {
  const store = loadStore(makeStorage());
  const saved = await store.setFeedbackForMessage({ userKey: U, sessionId: S, messageId: M, feedback: 'helpful' });
  assert.equal(saved.feedback, 'helpful');
  assert.equal(saved.messageRole, 'assistant');
  assert.equal(saved.contextSource, 'style_chat');
  const r = await store.getFeedbackForMessage({ userKey: U, sessionId: S, messageId: M });
  assert.equal(r.feedback, 'helpful');
});

test('update helpful -> not_my_style keeps one record and preserves createdAt', async () => {
  const store = loadStore(makeStorage());
  const first = await store.setFeedbackForMessage({ userKey: U, sessionId: S, messageId: M, feedback: 'helpful' });
  await new Promise((res) => setTimeout(res, 5));
  const second = await store.setFeedbackForMessage({ userKey: U, sessionId: S, messageId: M, feedback: 'not_my_style' });
  assert.equal(second.feedback, 'not_my_style');
  assert.equal(second.createdAt, first.createdAt);
  assert.notEqual(second.updatedAt, first.updatedAt);
  const sessionMap = await store.getFeedbackForSession({ userKey: U, sessionId: S });
  assert.equal(Object.keys(sessionMap).length, 1);
  assert.equal(sessionMap[M].feedback, 'not_my_style');
});

test('serialized concurrent writes do not corrupt (last write wins, single record)', async () => {
  const store = loadStore(makeStorage());
  await Promise.all([
    store.setFeedbackForMessage({ userKey: U, sessionId: S, messageId: M, feedback: 'helpful' }),
    store.setFeedbackForMessage({ userKey: U, sessionId: S, messageId: M, feedback: 'not_my_style' }),
  ]);
  const map = await store.getFeedbackForSession({ userKey: U, sessionId: S });
  assert.equal(Object.keys(map).length, 1);
  assert.ok(['helpful', 'not_my_style'].includes(map[M].feedback));
});

test('corrupted JSON recovers to empty (returns null)', async () => {
  const storage = makeStorage({ '@style_dna_v1/sessions/user:abc-123/session-1': '{not valid json' });
  const store = loadStore(storage);
  const r = await store.getFeedbackForMessage({ userKey: U, sessionId: S, messageId: M });
  assert.equal(r, null);
});

test('clearAllLocalStyleDna removes only @style_dna_v1/ keys', async () => {
  const storage = makeStorage({ 'onboardingComplete:x': 'true', 'kscan.privacy_preferences.v1': '{}' });
  const store = loadStore(storage);
  await store.setFeedbackForMessage({ userKey: U, sessionId: S, messageId: M, feedback: 'helpful' });
  await store.clearAllLocalStyleDna();
  const keys = await storage.getAllKeys();
  assert.ok(!keys.some((k) => k.startsWith('@style_dna_v1/')));
  assert.ok(keys.includes('onboardingComplete:x'));
  assert.ok(keys.includes('kscan.privacy_preferences.v1'));
});

test('clearLocalStyleDnaForUser removes only that user keys', async () => {
  const store = loadStore(makeStorage());
  await store.setFeedbackForMessage({ userKey: U, sessionId: S, messageId: M, feedback: 'helpful' });
  await store.setFeedbackForMessage({ userKey: 'user:other', sessionId: S, messageId: M, feedback: 'helpful' });
  await store.clearLocalStyleDnaForUser(U);
  assert.equal(await store.getFeedbackForMessage({ userKey: U, sessionId: S, messageId: M }), null);
  const other = await store.getFeedbackForMessage({ userKey: 'user:other', sessionId: S, messageId: M });
  assert.equal(other.feedback, 'helpful');
});

test('invalid feedback value throws', async () => {
  const store = loadStore(makeStorage());
  await assert.rejects(() =>
    store.setFeedbackForMessage({ userKey: U, sessionId: S, messageId: M, feedback: 'bogus' }),
  );
});

test('feature flag: STYLE_DNA_ENABLED defaults true, false only when explicitly "false"', () => {
  assert.equal(loadStore(makeStorage(), {}).STYLE_DNA_ENABLED, true);
  assert.equal(loadStore(makeStorage(), { EXPO_PUBLIC_STYLE_DNA_ENABLED: 'false' }).STYLE_DNA_ENABLED, false);
  assert.equal(loadStore(makeStorage(), { EXPO_PUBLIC_STYLE_DNA_ENABLED: 'true' }).STYLE_DNA_ENABLED, true);
});
