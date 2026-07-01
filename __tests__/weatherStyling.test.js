const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function transpile(rel) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  return ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
}

function run(rel, requireMap, env = {}) {
  const module = { exports: {} };
  const sandbox = {
    console, process: { env },
    exports: module.exports, module,
    require: (id) => {
      if (id in requireMap) return requireMap[id];
      throw new Error('Unexpected require: ' + id);
    },
  };
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
  };
}

function loadConstants(env = {}) {
  return run('constants/weatherStyling.ts', {}, env);
}
function loadStore(storage, env = {}) {
  const constants = loadConstants(env);
  return run('services/weather/weatherPermissionStore.ts', {
    '@react-native-async-storage/async-storage': { __esModule: true, default: storage },
    '../../constants/weatherStyling': constants,
  }, env);
}

test('feature flag: undefined/false disabled, only "true" enabled', () => {
  assert.equal(loadConstants({}).WEATHER_STYLING_CONTEXT_ENABLED, false);
  assert.equal(loadConstants({ EXPO_PUBLIC_WEATHER_STYLING_CONTEXT_ENABLED: 'false' }).WEATHER_STYLING_CONTEXT_ENABLED, false);
  assert.equal(loadConstants({ EXPO_PUBLIC_WEATHER_STYLING_CONTEXT_ENABLED: 'true' }).WEATHER_STYLING_CONTEXT_ENABLED, true);
});

test('roundCoordinate uses 1 decimal (~11km)', () => {
  const c = loadConstants();
  assert.equal(c.roundCoordinate(37.774929), 37.8);
  assert.equal(c.roundCoordinate(-122.419416), -122.4);
});

test('default permission state is not_asked and is prompt-eligible', async () => {
  const store = loadStore(makeStorage());
  const rec = await store.readWeatherPermission();
  assert.equal(rec.state, 'not_asked');
  assert.equal(store.isPromptEligible(rec), true);
});

test('granted and denied are not prompt-eligible', () => {
  const store = loadStore(makeStorage());
  assert.equal(store.isPromptEligible({ schemaVersion: 1, state: 'granted', updatedAt: '' }), false);
  assert.equal(store.isPromptEligible({ schemaVersion: 1, state: 'denied', updatedAt: '' }), false);
});

test('dismissed: not eligible immediately, eligible after 7 days or 5 sessions', () => {
  const store = loadStore(makeStorage());
  const now = Date.now();
  const fresh = { schemaVersion: 1, state: 'dismissed', updatedAt: '', dismissedAt: new Date(now).toISOString(), sessionsSinceDismiss: 0 };
  assert.equal(store.isPromptEligible(fresh, now), false);
  const old = { ...fresh, dismissedAt: new Date(now - 8 * 86400000).toISOString() };
  assert.equal(store.isPromptEligible(old, now), true);
  const many = { ...fresh, sessionsSinceDismiss: 5 };
  assert.equal(store.isPromptEligible(many, now), true);
});

test('setWeatherPermissionState persists and round-trips', async () => {
  const storage = makeStorage();
  const store = loadStore(storage);
  await store.setWeatherPermissionState('granted');
  assert.equal((await store.readWeatherPermission()).state, 'granted');
  const dismissed = await store.setWeatherPermissionState('dismissed');
  assert.equal(dismissed.state, 'dismissed');
  assert.equal(dismissed.sessionsSinceDismiss, 0);
  assert.ok(dismissed.dismissedAt);
});

test('noteStyleChatSessionOpened increments only while dismissed', async () => {
  const storage = makeStorage();
  const store = loadStore(storage);
  await store.setWeatherPermissionState('dismissed');
  const a = await store.noteStyleChatSessionOpened();
  const b = await store.noteStyleChatSessionOpened();
  assert.equal(a.sessionsSinceDismiss, 1);
  assert.equal(b.sessionsSinceDismiss, 2);
  await store.setWeatherPermissionState('granted');
  const c = await store.noteStyleChatSessionOpened();
  assert.equal(c.state, 'granted');
  assert.equal(c.sessionsSinceDismiss, undefined);
});

test('clearWeatherPermissionState removes the key', async () => {
  const storage = makeStorage();
  const store = loadStore(storage);
  await store.setWeatherPermissionState('granted');
  await store.clearWeatherPermissionState();
  assert.equal(storage.map.has(store.WEATHER_PERMISSION_KEY), false);
});

test('corrupted JSON recovers to not_asked', async () => {
  const storage = makeStorage({ '@style_dna_v1/weather/permissionState': '{bad json' });
  const store = loadStore(storage);
  assert.equal((await store.readWeatherPermission()).state, 'not_asked');
});
