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
    async getItem(k) { return map.has(k) ? map.get(k) : null; },
    async setItem(k, v) { map.set(k, v); },
    async removeItem(k) { map.delete(k); },
    async getAllKeys() { return [...map.keys()]; },
    async multiGet(keys) { return keys.map((k) => [k, map.has(k) ? map.get(k) : null]); },
    async multiRemove(keys) { keys.forEach((k) => map.delete(k)); },
  };
}

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

function load(storage, env = {}) {
  const asyncMock = { __esModule: true, default: storage };
  const feedback = run('services/style-dna/localStyleDnaFeedbackStore.ts', {
    '@react-native-async-storage/async-storage': asyncMock,
  }, env);
  const reasons = run('services/style-dna/localStyleDnaReasons.ts', {
    '@react-native-async-storage/async-storage': asyncMock,
    './localStyleDnaFeedbackStore': feedback,
  }, env);
  const profile = run('services/style-dna/localStyleDnaProfile.ts', {
    '@react-native-async-storage/async-storage': asyncMock,
    './localStyleDnaFeedbackStore': feedback,
    './localStyleDnaReasons': reasons,
  }, env);
  const preferences = run('services/style-dna/localStyleDnaPreferences.ts', {
    '@react-native-async-storage/async-storage': asyncMock,
    './localStyleDnaFeedbackStore': feedback,
  }, env);
  return { feedback, reasons, profile, preferences };
}

const U = 'user:abc';
const OTHER = 'user:other';

test('reset clears feedback and reasons for current actor only', async () => {
  const { feedback, reasons, profile } = load(makeStorage());
  await feedback.setFeedbackForMessage({ userKey: U, sessionId: 's1', messageId: 'm1', feedback: 'helpful' });
  await reasons.setReasonForMessage({ userKey: U, sessionId: 's1', messageId: 'm1', feedback: 'helpful', reasonCode: 'practical' });
  await feedback.setFeedbackForMessage({ userKey: OTHER, sessionId: 's1', messageId: 'm1', feedback: 'helpful' });

  await profile.resetLocalStyleDnaProfile(U);

  assert.equal((await profile.getStyleDnaProfileSummary({ userKey: U })).totalSignals, 0);
  assert.equal((await reasons.getReasonCountsForUser({ userKey: U })).totalReasons, 0);

  const other = await profile.getStyleDnaProfileSummary({ userKey: OTHER });
  assert.equal(other.totalSignals, 1);
});

test('reset preserves UI preferences for current actor', async () => {
  const storage = makeStorage();
  const { feedback, profile, preferences } = load(storage);
  await feedback.setFeedbackForMessage({ userKey: U, sessionId: 's1', messageId: 'm1', feedback: 'helpful' });
  await preferences.setStyleDnaPreferences(U, {
    learnFromFeedback: true,
    showFeedbackControls: true,
    feedbackEducationDismissed: true,
  });

  await profile.resetLocalStyleDnaProfile(U);

  assert.equal((await profile.getStyleDnaProfileSummary({ userKey: U })).totalSignals, 0);

  const prefs = await preferences.getStyleDnaPreferences(U);
  assert.equal(prefs.learnFromFeedback, true);
  assert.equal(prefs.showFeedbackControls, true);
  assert.equal(prefs.feedbackEducationDismissed, true);
});

test('reset does not touch unrelated namespaces', async () => {
  const storage = makeStorage({
    onboardingComplete: 'true',
    'kscan.privacy_preferences.v1': '{}',
  });
  const { feedback, profile } = load(storage);
  await feedback.setFeedbackForMessage({ userKey: U, sessionId: 's1', messageId: 'm1', feedback: 'helpful' });

  await profile.resetLocalStyleDnaProfile(U);

  const keys = await storage.getAllKeys();
  assert.ok(keys.includes('onboardingComplete'));
  assert.ok(keys.includes('kscan.privacy_preferences.v1'));
});
