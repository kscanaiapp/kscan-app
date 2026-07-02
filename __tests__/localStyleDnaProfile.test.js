const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function transpile(rel) {
  return ts.transpileModule(fs.readFileSync(path.join(ROOT, rel), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
}
function run(rel, requireMap, env = {}) {
  const module = { exports: {} };
  const sandbox = { console, process: { env }, exports: module.exports, module,
    require: (id) => { if (id in requireMap) return requireMap[id]; throw new Error('Unexpected require: ' + id); } };
  vm.runInNewContext(transpile(rel), sandbox, { filename: rel });
  return module.exports;
}
function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    async getItem(k) { return map.has(k) ? map.get(k) : null; },
    async setItem(k, v) { map.set(k, v); },
    async removeItem(k) { map.delete(k); },
    async getAllKeys() { return [...map.keys()]; },
    async multiGet(keys) { return keys.map((k) => [k, map.has(k) ? map.get(k) : null]); },
    async multiRemove(keys) { keys.forEach((k) => map.delete(k)); },
  };
}
function load(storage, env = {}) {
  const asyncMock = { __esModule: true, default: storage };
  const store = run('services/style-dna/localStyleDnaFeedbackStore.ts', {
    '@react-native-async-storage/async-storage': asyncMock,
  }, env);
  const profile = run('services/style-dna/localStyleDnaProfile.ts', {
    '@react-native-async-storage/async-storage': asyncMock,
    './localStyleDnaFeedbackStore': store,
  }, env);
  return { store, profile };
}

const U = 'user:abc';

test('empty profile when no feedback', async () => {
  const { profile } = load(makeStorage());
  const s = await profile.getStyleDnaProfileSummary({ userKey: U });
  assert.equal(s.totalSignals, 0);
  assert.equal(s.helpfulRatio, null);
  assert.equal(s.sessionsWithFeedback, 0);
});

test('aggregates helpful/not_my_style across multiple sessions', async () => {
  const { store, profile } = load(makeStorage());
  await store.setFeedbackForMessage({ userKey: U, sessionId: 's1', messageId: 'm1', feedback: 'helpful' });
  await store.setFeedbackForMessage({ userKey: U, sessionId: 's1', messageId: 'm2', feedback: 'not_my_style' });
  await store.setFeedbackForMessage({ userKey: U, sessionId: 's2', messageId: 'm3', feedback: 'helpful' });
  const s = await profile.getStyleDnaProfileSummary({ userKey: U });
  assert.equal(s.helpfulCount, 2);
  assert.equal(s.notMyStyleCount, 1);
  assert.equal(s.totalSignals, 3);
  assert.equal(Math.round(s.helpfulRatio * 100), 67);
  assert.equal(s.sessionsWithFeedback, 2);
  assert.ok(s.lastUpdatedAt);
});

test('only counts the queried user', async () => {
  const { store, profile } = load(makeStorage());
  await store.setFeedbackForMessage({ userKey: U, sessionId: 's1', messageId: 'm1', feedback: 'helpful' });
  await store.setFeedbackForMessage({ userKey: 'user:other', sessionId: 's1', messageId: 'm1', feedback: 'helpful' });
  const s = await profile.getStyleDnaProfileSummary({ userKey: U });
  assert.equal(s.totalSignals, 1);
});

test('summary text: null when flag off, present when enabled and >= 3 signals', async () => {
  // flag off
  const off = load(makeStorage(), {});
  await off.store.setFeedbackForMessage({ userKey: U, sessionId: 's', messageId: 'a', feedback: 'helpful' });
  await off.store.setFeedbackForMessage({ userKey: U, sessionId: 's', messageId: 'b', feedback: 'helpful' });
  await off.store.setFeedbackForMessage({ userKey: U, sessionId: 's', messageId: 'c', feedback: 'not_my_style' });
  const offSummary = await off.profile.getStyleDnaProfileSummary({ userKey: U });
  assert.equal(off.profile.buildStyleDnaSummaryText(offSummary), null);

  // flag on, >= 3 signals
  const on = load(makeStorage(), { EXPO_PUBLIC_STYLE_DNA_PROFILE_ENABLED: 'true' });
  await on.store.setFeedbackForMessage({ userKey: U, sessionId: 's', messageId: 'a', feedback: 'helpful' });
  await on.store.setFeedbackForMessage({ userKey: U, sessionId: 's', messageId: 'b', feedback: 'helpful' });
  await on.store.setFeedbackForMessage({ userKey: U, sessionId: 's', messageId: 'c', feedback: 'not_my_style' });
  const onSummary = await on.profile.getStyleDnaProfileSummary({ userKey: U });
  const text = on.profile.buildStyleDnaSummaryText(onSummary);
  assert.ok(text && text.includes('2 marked helpful'));
});

test('summary text: null below threshold even when enabled', async () => {
  const { store, profile } = load(makeStorage(), { EXPO_PUBLIC_STYLE_DNA_PROFILE_ENABLED: 'true' });
  await store.setFeedbackForMessage({ userKey: U, sessionId: 's', messageId: 'a', feedback: 'helpful' });
  const s = await profile.getStyleDnaProfileSummary({ userKey: U });
  assert.equal(profile.buildStyleDnaSummaryText(s), null);
});

test('resetLocalStyleDnaProfile clears the derived signal', async () => {
  const { store, profile } = load(makeStorage());
  await store.setFeedbackForMessage({ userKey: U, sessionId: 's', messageId: 'a', feedback: 'helpful' });
  await profile.resetLocalStyleDnaProfile(U);
  const s = await profile.getStyleDnaProfileSummary({ userKey: U });
  assert.equal(s.totalSignals, 0);
});

test('corrupted session map is skipped, not thrown', async () => {
  const storage = makeStorage({ '@style_dna_v1/sessions/user:abc/sBad': '{broken' });
  const { store, profile } = load(storage);
  await store.setFeedbackForMessage({ userKey: U, sessionId: 'sOk', messageId: 'a', feedback: 'helpful' });
  const s = await profile.getStyleDnaProfileSummary({ userKey: U });
  assert.equal(s.totalSignals, 1);
});
