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

function loadPreferences(storage, env = {}) {
  const asyncMock = { __esModule: true, default: storage };
  const feedbackStore = run('services/style-dna/localStyleDnaFeedbackStore.ts', {
    '@react-native-async-storage/async-storage': asyncMock,
  }, env);
  return run('services/style-dna/localStyleDnaPreferences.ts', {
    '@react-native-async-storage/async-storage': asyncMock,
    './localStyleDnaFeedbackStore': feedbackStore,
  }, env);
}

const U = 'user:abc';

const U2 = 'user:def';

test('defaults are learn=true, show=false, education=false', async () => {
  const prefs = loadPreferences(makeStorage());
  const result = await prefs.getStyleDnaPreferences(U);
  assert.equal(result.learnFromFeedback, true);
  assert.equal(result.showFeedbackControls, false);
  assert.equal(result.feedbackEducationDismissed, false);
});

test('preferences are actor-scoped', async () => {
  const prefs = loadPreferences(makeStorage());
  await prefs.setStyleDnaPreferences(U, { learnFromFeedback: false, showFeedbackControls: true });
  await prefs.setStyleDnaPreferences(U2, { learnFromFeedback: true, showFeedbackControls: false, feedbackEducationDismissed: true });

  const a = await prefs.getStyleDnaPreferences(U);
  assert.equal(a.learnFromFeedback, false);
  assert.equal(a.showFeedbackControls, false);
  assert.equal(a.feedbackEducationDismissed, false);

  const b = await prefs.getStyleDnaPreferences(U2);
  assert.equal(b.learnFromFeedback, true);
  assert.equal(b.showFeedbackControls, false);
  assert.equal(b.feedbackEducationDismissed, true);
});

test('partial update preserves other fields', async () => {
  const prefs = loadPreferences(makeStorage());
  await prefs.setStyleDnaPreferences(U, { feedbackEducationDismissed: true });
  const result = await prefs.getStyleDnaPreferences(U);
  assert.equal(result.learnFromFeedback, true);
  assert.equal(result.showFeedbackControls, false);
  assert.equal(result.feedbackEducationDismissed, true);
});

test('visibility and learning changes preserve existing learned feedback data', async () => {
  const feedbackKey = '@style_dna_v1/sessions/user:abc/session-1';
  const learnedData = JSON.stringify({ feedbackByMessageId: { message1: { feedback: 'helpful' } } });
  const storage = makeStorage({ [feedbackKey]: learnedData });
  const prefs = loadPreferences(storage);

  await prefs.setStyleDnaPreferences(U, { showFeedbackControls: true });
  await prefs.setStyleDnaPreferences(U, { learnFromFeedback: false });
  await prefs.setStyleDnaPreferences(U, { learnFromFeedback: true });

  assert.equal(await storage.getItem(feedbackKey), learnedData);
  const result = await prefs.getStyleDnaPreferences(U);
  assert.equal(result.learnFromFeedback, true);
  assert.equal(result.showFeedbackControls, false);
});

test('preferences persist across reads', async () => {
  const storage = makeStorage();
  const prefs = loadPreferences(storage);
  await prefs.setStyleDnaPreferences(U, { learnFromFeedback: false });
  const second = loadPreferences(storage);
  const result = await second.getStyleDnaPreferences(U);
  assert.equal(result.learnFromFeedback, false);
});

test('corrupted JSON recovers to defaults', async () => {
  const storage = makeStorage({ '@style_dna_v1/preferences/user:abc': '{not valid' });
  const prefs = loadPreferences(storage);
  const result = await prefs.getStyleDnaPreferences(U);
  assert.equal(result.learnFromFeedback, true);
  assert.equal(result.showFeedbackControls, false);
});

test('clearStyleDnaPreferencesForUser removes only that user', async () => {
  const prefs = loadPreferences(makeStorage());
  await prefs.setStyleDnaPreferences(U, { learnFromFeedback: false });
  await prefs.setStyleDnaPreferences(U2, { learnFromFeedback: false });
  await prefs.clearStyleDnaPreferencesForUser(U);
  const a = await prefs.getStyleDnaPreferences(U);
  assert.equal(a.learnFromFeedback, true);
  const b = await prefs.getStyleDnaPreferences(U2);
  assert.equal(b.learnFromFeedback, false);
});

test('clearAllStyleDnaPreferences removes only preference keys', async () => {
  const storage = makeStorage({
    '@style_dna_v1/preferences/user:abc': '{}',
    '@style_dna_v1/sessions/user:abc/session-1': '{}',
    'other:key': 'value',
  });
  const prefs = loadPreferences(storage);
  await prefs.clearAllStyleDnaPreferences();
  const keys = await storage.getAllKeys();
  assert.ok(!keys.some((k) => k.startsWith('@style_dna_v1/preferences/')));
  assert.ok(keys.includes('@style_dna_v1/sessions/user:abc/session-1'));
  assert.ok(keys.includes('other:key'));
});

test('missing userKey returns defaults', async () => {
  const prefs = loadPreferences(makeStorage());
  const result = await prefs.getStyleDnaPreferences('');
  assert.equal(result.learnFromFeedback, true);
  assert.equal(result.showFeedbackControls, false);
});

test('setStyleDnaPreferences throws without userKey', async () => {
  const prefs = loadPreferences(makeStorage());
  await assert.rejects(() => prefs.setStyleDnaPreferences('', { learnFromFeedback: false }));
});

test('cold-launch hydration publishes the persisted actor snapshot', async () => {
  const storage = makeStorage({
    '@style_dna_v1/preferences/user:abc': JSON.stringify({
      learnFromFeedback: false,
      showFeedbackControls: true,
      feedbackEducationDismissed: true,
    }),
  });
  const prefs = loadPreferences(storage);
  assert.strictEqual(
    prefs.getStyleDnaPreferencesSnapshot(U),
    prefs.DEFAULT_STYLE_DNA_PREFERENCES,
  );

  await prefs.hydrateStyleDnaPreferences(U);
  const hydrated = prefs.getStyleDnaPreferencesSnapshot(U);
  assert.equal(hydrated.learnFromFeedback, false);
  assert.equal(hydrated.showFeedbackControls, false);
  assert.equal(hydrated.feedbackEducationDismissed, true);
});

test('stale hydration cannot overwrite a newer local selection', async () => {
  let resolveHydration;
  let getCalls = 0;
  const storage = makeStorage();
  storage.getItem = async () => {
    getCalls += 1;
    if (getCalls === 1) {
      return new Promise((resolve) => { resolveHydration = resolve; });
    }
    return null;
  };
  const prefs = loadPreferences(storage);

  const hydration = prefs.hydrateStyleDnaPreferences(U);
  await prefs.setStyleDnaPreferences(U, { learnFromFeedback: false });
  resolveHydration(JSON.stringify({ learnFromFeedback: true }));
  await hydration;

  assert.equal(prefs.getStyleDnaPreferencesSnapshot(U).learnFromFeedback, false);
});

test('account A hydration arriving after account B stays actor-isolated', async () => {
  let resolveActorA;
  const storage = makeStorage({
    '@style_dna_v1/preferences/user:def': JSON.stringify({ learnFromFeedback: false }),
  });
  const originalGet = storage.getItem;
  storage.getItem = async (key) => {
    if (key.endsWith(U)) {
      return new Promise((resolve) => { resolveActorA = resolve; });
    }
    return originalGet(key);
  };
  const prefs = loadPreferences(storage);

  const actorAHydration = prefs.hydrateStyleDnaPreferences(U);
  await prefs.hydrateStyleDnaPreferences(U2);
  assert.equal(prefs.getStyleDnaPreferencesSnapshot(U2).learnFromFeedback, false);

  resolveActorA(JSON.stringify({ showFeedbackControls: true }));
  await actorAHydration;
  assert.equal(prefs.getStyleDnaPreferencesSnapshot(U2).learnFromFeedback, false);
  assert.equal(prefs.getStyleDnaPreferencesSnapshot(U2).showFeedbackControls, false);
});

test('serialized rapid partial updates preserve both selections', async () => {
  const prefs = loadPreferences(makeStorage());
  await Promise.all([
    prefs.setStyleDnaPreferences(U, { learnFromFeedback: false }),
    prefs.setStyleDnaPreferences(U, { showFeedbackControls: true }),
  ]);
  const result = await prefs.getStyleDnaPreferences(U);
  assert.equal(result.learnFromFeedback, false);
  assert.equal(result.showFeedbackControls, false);
});

test('read failure rejects an update without overwriting stored preferences', async () => {
  const key = '@style_dna_v1/preferences/user:abc';
  const stored = JSON.stringify({
    learnFromFeedback: true,
    showFeedbackControls: true,
    feedbackEducationDismissed: true,
  });
  const storage = makeStorage({ [key]: stored });
  storage.getItem = async () => { throw new Error('read unavailable'); };
  const prefs = loadPreferences(storage);

  await assert.rejects(
    prefs.setStyleDnaPreferences(U, { feedbackEducationDismissed: false }),
    /read unavailable/,
  );
  assert.equal(storage.map.get(key), stored);
  assert.strictEqual(
    prefs.getStyleDnaPreferencesSnapshot(U),
    prefs.DEFAULT_STYLE_DNA_PREFERENCES,
  );
});

test('persistence rejection does not publish a false selection', async () => {
  const storage = makeStorage();
  storage.setItem = async () => { throw new Error('disk full'); };
  const prefs = loadPreferences(storage);
  await assert.rejects(
    prefs.setStyleDnaPreferences(U, { learnFromFeedback: false }),
    /disk full/,
  );
  assert.equal(prefs.getStyleDnaPreferencesSnapshot(U).learnFromFeedback, true);
});

test('a later failed update does not suppress an earlier durable snapshot', async () => {
  const storage = makeStorage();
  let writes = 0;
  const originalSet = storage.setItem;
  storage.setItem = async (key, value) => {
    writes += 1;
    if (writes === 2) throw new Error('disk full');
    return originalSet(key, value);
  };
  const prefs = loadPreferences(storage);

  const first = prefs.setStyleDnaPreferences(U, { showFeedbackControls: true });
  const second = prefs.setStyleDnaPreferences(U, { feedbackEducationDismissed: true });
  await first;
  await assert.rejects(second, /disk full/);

  const snapshot = prefs.getStyleDnaPreferencesSnapshot(U);
  assert.equal(snapshot.showFeedbackControls, true);
  assert.equal(snapshot.feedbackEducationDismissed, false);
});

test('snapshots are referentially stable and duplicate subscriptions notify once', async () => {
  const prefs = loadPreferences(makeStorage());
  assert.strictEqual(
    prefs.getStyleDnaPreferencesSnapshot(U),
    prefs.getStyleDnaPreferencesSnapshot(U),
  );

  let notifications = 0;
  const listener = () => { notifications += 1; };
  const unsubscribeA = prefs.subscribeStyleDnaPreferences(U, listener);
  const unsubscribeB = prefs.subscribeStyleDnaPreferences(U, listener);
  await prefs.setStyleDnaPreferences(U, { showFeedbackControls: true });
  assert.equal(notifications, 1);
  assert.strictEqual(
    prefs.getStyleDnaPreferencesSnapshot(U),
    prefs.getStyleDnaPreferencesSnapshot(U),
  );
  unsubscribeA();
  unsubscribeB();
});
