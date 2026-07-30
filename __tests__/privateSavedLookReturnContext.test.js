const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const values = new Map();
const AsyncStorageMock = {
  async getItem(key) { return values.get(key) ?? null; },
  async setItem(key, value) { values.set(key, value); },
  async removeItem(key) { values.delete(key); },
};
const cache = new Map();
function loadModule(relPath) {
  if (cache.has(relPath)) return cache.get(relPath);
  const filename = path.join(ROOT, relPath);
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const mod = { exports: {} };
  const dirname = path.dirname(filename);
  const localRequire = (specifier) => {
    if (specifier === '@react-native-async-storage/async-storage') return AsyncStorageMock;
    if (!specifier.startsWith('.')) throw new Error(`Unexpected import ${specifier}`);
    let resolved = path.resolve(dirname, specifier);
    for (const ext of ['', '.ts', '.js']) {
      if (fs.existsSync(resolved + ext) && fs.statSync(resolved + ext).isFile()) { resolved += ext; break; }
    }
    return loadModule(path.relative(ROOT, resolved).replace(/\\/g, '/'));
  };
  vm.runInThisContext(`(function(exports,module,require){${output}\n})`, { filename })(mod.exports, mod, localRequire);
  cache.set(relPath, mod.exports);
  return mod.exports;
}

const actor = loadModule('services/actorContext.js');
const contextStore = loadModule('services/privateSavedLookReturnContext.ts');
const context = {
  savedLookId: 'saved-look-1', slotKey: 'footwear',
  returnRoute: '/stylist/saved-looks/saved-look-1', createdAt: '2026-07-30T14:00:00.000Z',
};

function request(actorId = 'actor-a') {
  actor.__resetActorContextForTests();
  actor.advanceActorEpoch(actorId);
  return actor.createActorRequest();
}

test('context survives module-local state and restores the same Saved Look and slot', async () => {
  values.clear();
  const actorRequest = request();
  assert.equal(await contextStore.persistSavedLookReturnContext(actorRequest, context), true);
  assert.deepEqual(await contextStore.loadSavedLookReturnContext(actorRequest), context);
  assert.ok(values.has(contextStore.SAVED_LOOK_RETURN_CONTEXT_KEY));
});

test('another actor cannot read or clear retained context', async () => {
  values.clear();
  const requestA = request('actor-a');
  await contextStore.persistSavedLookReturnContext(requestA, context);
  actor.advanceActorEpoch('actor-b');
  const requestB = actor.createActorRequest();
  assert.equal(await contextStore.loadSavedLookReturnContext(requestB), null);
  assert.equal(await contextStore.clearSavedLookReturnContext(requestB), true);
  actor.advanceActorEpoch('actor-a');
  assert.deepEqual(await contextStore.loadSavedLookReturnContext(actor.createActorRequest()), context);
});

test('stale and signed-out contexts fail closed', async () => {
  values.clear();
  const stale = request('actor-a');
  actor.advanceActorEpoch('actor-a');
  assert.equal(await contextStore.persistSavedLookReturnContext(stale, context), false);
  const signedOut = request(null);
  assert.equal(await contextStore.persistSavedLookReturnContext(signedOut, context), false);
});

test('malformed persisted JSON is bounded and clearable without throwing', async () => {
  values.clear();
  const actorRequest = request();
  values.set(contextStore.SAVED_LOOK_RETURN_CONTEXT_KEY, '{broken');
  assert.equal(await contextStore.loadSavedLookReturnContext(actorRequest), null);
  assert.equal(await contextStore.clearSavedLookReturnContext(actorRequest), true);
});

test('owner clear removes the restored context after same-route consumption', async () => {
  values.clear();
  const actorRequest = request();
  await contextStore.persistSavedLookReturnContext(actorRequest, context);
  assert.equal(await contextStore.clearSavedLookReturnContext(actorRequest), true);
  assert.equal(await contextStore.loadSavedLookReturnContext(actorRequest), null);
});
