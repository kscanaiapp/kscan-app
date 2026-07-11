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
  const reasons = run('services/style-dna/localStyleDnaReasons.ts', {
    '@react-native-async-storage/async-storage': asyncMock,
    './localStyleDnaFeedbackStore': store,
  }, env);
  const profile = run('services/style-dna/localStyleDnaProfile.ts', {
    '@react-native-async-storage/async-storage': asyncMock,
    './localStyleDnaFeedbackStore': store,
    './localStyleDnaReasons': reasons,
  }, env);
  return { store, reasons, profile, storage };
}

const U = 'user:abc';

test('reason feedback flag disabled by default (env unset)', () => {
  const { reasons } = load(makeStorage());
  assert.equal(reasons.STYLE_DNA_REASON_FEEDBACK_ENABLED, false);
});

test('reason feedback flag enabled when env is "true"', () => {
  const { reasons } = load(makeStorage(), { EXPO_PUBLIC_STYLE_DNA_REASON_FEEDBACK_ENABLED: 'true' });
  assert.equal(reasons.STYLE_DNA_REASON_FEEDBACK_ENABLED, true);
});

test('reason is optional: feedback persists with no reason recorded', async () => {
  const { store, reasons } = load(makeStorage());
  await store.setFeedbackForMessage({ userKey: U, sessionId: 's1', messageId: 'm1', feedback: 'helpful' });
  const r = await reasons.getReasonForMessage({ userKey: U, sessionId: 's1', messageId: 'm1' });
  assert.equal(r, null);
  const fb = await store.getFeedbackForMessage({ userKey: U, sessionId: 's1', messageId: 'm1' });
  assert.equal(fb.feedback, 'helpful');
});

test('valid reason codes persist locally', async () => {
  const { reasons } = load(makeStorage());
  await reasons.setReasonForMessage({ userKey: U, sessionId: 's1', messageId: 'm1', feedback: 'helpful', reasonCode: 'practical' });
  const r = await reasons.getReasonForMessage({ userKey: U, sessionId: 's1', messageId: 'm1' });
  assert.equal(r.reasonCode, 'practical');
  assert.equal(r.feedback, 'helpful');
});

test('invalid reason code is rejected (throws)', async () => {
  const { reasons } = load(makeStorage());
  await assert.rejects(
    () => reasons.setReasonForMessage({ userKey: U, sessionId: 's1', messageId: 'm1', feedback: 'helpful', reasonCode: 'nonsense' }),
    /Invalid Style Memory reason code/,
  );
});

test('polarity-mismatched reason is rejected (helpful reason on not_my_style)', async () => {
  const { reasons } = load(makeStorage());
  await assert.rejects(
    () => reasons.setReasonForMessage({ userKey: U, sessionId: 's1', messageId: 'm1', feedback: 'not_my_style', reasonCode: 'practical' }),
    /Invalid Style Memory reason code/,
  );
});

test('reason aggregation is per-user and by code/feedback', async () => {
  const { reasons } = load(makeStorage());
  await reasons.setReasonForMessage({ userKey: U, sessionId: 's1', messageId: 'm1', feedback: 'helpful', reasonCode: 'practical' });
  await reasons.setReasonForMessage({ userKey: U, sessionId: 's1', messageId: 'm2', feedback: 'helpful', reasonCode: 'practical' });
  await reasons.setReasonForMessage({ userKey: U, sessionId: 's2', messageId: 'm3', feedback: 'not_my_style', reasonCode: 'too_bold' });
  // another user's reason must not leak in
  await reasons.setReasonForMessage({ userKey: 'user:other', sessionId: 's1', messageId: 'm1', feedback: 'helpful', reasonCode: 'would_try' });

  const counts = await reasons.getReasonCountsForUser({ userKey: U });
  assert.equal(counts.totalReasons, 3);
  assert.equal(counts.byReasonCode.practical, 2);
  assert.equal(counts.byReasonCode.too_bold, 1);
  assert.equal(counts.byReasonCode.would_try, undefined);
  assert.equal(counts.byFeedback.helpful, 2);
  assert.equal(counts.byFeedback.not_my_style, 1);
});

test('corrupt reason storage does not crash aggregation', async () => {
  const storage = makeStorage({ '@style_dna_v1/reasons/user:abc/sBad': '{broken' });
  const { reasons } = load(storage);
  await reasons.setReasonForMessage({ userKey: U, sessionId: 'sOk', messageId: 'm1', feedback: 'helpful', reasonCode: 'would_try' });
  const counts = await reasons.getReasonCountsForUser({ userKey: U });
  assert.equal(counts.totalReasons, 1);
  assert.equal(counts.byReasonCode.would_try, 1);
});

test('clearReasonsForUser clears only current user', async () => {
  const { reasons } = load(makeStorage());
  await reasons.setReasonForMessage({ userKey: U, sessionId: 's1', messageId: 'm1', feedback: 'helpful', reasonCode: 'practical' });
  await reasons.setReasonForMessage({ userKey: 'user:other', sessionId: 's1', messageId: 'm1', feedback: 'helpful', reasonCode: 'practical' });
  await reasons.clearReasonsForUser(U);
  assert.equal((await reasons.getReasonCountsForUser({ userKey: U })).totalReasons, 0);
  assert.equal((await reasons.getReasonCountsForUser({ userKey: 'user:other' })).totalReasons, 1);
});

test('reset via profile clears reasons for current user (reset synchronization)', async () => {
  // profile.resetLocalStyleDnaProfile must clear reasons too once wired.
  const { store, reasons, profile } = load(makeStorage());
  await store.setFeedbackForMessage({ userKey: U, sessionId: 's1', messageId: 'm1', feedback: 'helpful' });
  await reasons.setReasonForMessage({ userKey: U, sessionId: 's1', messageId: 'm1', feedback: 'helpful', reasonCode: 'practical' });
  await profile.resetLocalStyleDnaProfile(U);
  assert.equal((await profile.getStyleDnaProfileSummary({ userKey: U })).totalSignals, 0);
  assert.equal((await reasons.getReasonCountsForUser({ userKey: U })).totalReasons, 0);
});

test('valid code sets cover the documented reason taxonomy', () => {
  const { reasons } = load(makeStorage());
  assert.deepEqual([...reasons.reasonCodesForFeedback('helpful')], ['practical','matches_my_style','good_for_occasion','would_try']);
  assert.deepEqual([...reasons.reasonCodesForFeedback('not_my_style')], ['too_bold','too_plain','too_dressy','too_casual','not_practical','would_not_wear']);
  assert.equal(reasons.isValidReasonCode('practical'), true);
  assert.equal(reasons.isValidReasonCode('nope'), false);
});

test('clearReasonForMessage removes a stored reason', async () => {
  const { reasons } = load(makeStorage());
  await reasons.setReasonForMessage({ userKey: U, sessionId: 's1', messageId: 'm1', feedback: 'helpful', reasonCode: 'practical' });
  await reasons.clearReasonForMessage({ userKey: U, sessionId: 's1', messageId: 'm1' });
  assert.equal(await reasons.getReasonForMessage({ userKey: U, sessionId: 's1', messageId: 'm1' }), null);
});

test('Style Memory context (derived from feedback) is unaffected by reason saves', async () => {
  const { store, reasons, profile } = load(makeStorage());
  await store.setFeedbackForMessage({ userKey: U, sessionId: 's', messageId: 'a', feedback: 'helpful' });
  await store.setFeedbackForMessage({ userKey: U, sessionId: 's', messageId: 'b', feedback: 'helpful' });
  await store.setFeedbackForMessage({ userKey: U, sessionId: 's', messageId: 'c', feedback: 'not_my_style' });
  await reasons.setReasonForMessage({ userKey: U, sessionId: 's', messageId: 'a', feedback: 'helpful', reasonCode: 'practical' });
  const summary = await profile.getStyleDnaProfileSummary({ userKey: U });
  const ctxMod = run('services/style-dna/styleDnaContext.ts', {}, {});
  const ctx = ctxMod.buildStyleDnaContext(summary, { enabled: true });
  assert.equal(ctx.signalCount, 3);
  assert.equal(ctx.confidence, 'low');
});
