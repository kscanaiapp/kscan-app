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
// Relative to now: a return context is round-trip presentation state with a
// finite TTL (see DEFECT-P6-005), so a hard-coded wall-clock date would start
// failing the moment it aged past the window.
const context = {
  savedLookId: 'saved-look-1', slotKey: 'footwear',
  returnRoute: '/stylist/saved-looks/saved-look-1', createdAt: new Date().toISOString(),
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

// â”€â”€ DEFECT-P6-005: stale return context could highlight a later visit â”€â”€â”€â”€â”€â”€â”€â”€
//
// Severity: MEDIUM. The context already failed closed on every boundary that
// matters â€” the actor must match, the Saved Look id must match the Look being
// opened, it cannot expose another actor's Look, and it never redirects. What it
// lacked was any expiry or slot-membership check, so a context written weeks
// earlier still highlighted a slot on an unrelated later visit, and a Look edited
// between handoff and return could be highlighted on a slot it no longer has.

const TTL = contextStore.SAVED_LOOK_RETURN_CONTEXT_TTL_MS;

function contextAged(ms, slotKey = 'footwear', savedLookId = 'saved-look-1') {
  return {
    savedLookId,
    slotKey,
    returnRoute: `/stylist/saved-looks/${savedLookId}`,
    createdAt: new Date(Date.now() - ms).toISOString(),
  };
}

function lookFor(id = 'saved-look-1', slotKeys = ['top', 'footwear']) {
  return { id, slots: slotKeys.map((slotKey) => ({ slotKey })) };
}

test('DEFECT-P6-005: a context older than the TTL is refused and dropped', async () => {
  values.clear();
  const actorRequest = request();
  await contextStore.persistSavedLookReturnContext(actorRequest, contextAged(TTL + 60_000));
  assert.equal(await contextStore.loadSavedLookReturnContext(actorRequest), null, 'expired context returned');
  // Dropped, not merely refused: it cannot resurface on a later read.
  assert.equal(values.get(contextStore.SAVED_LOOK_RETURN_CONTEXT_KEY) ?? null, null, 'expired context retained');
});

test('DEFECT-P6-005: a context inside the TTL still works', async () => {
  values.clear();
  const actorRequest = request();
  await contextStore.persistSavedLookReturnContext(actorRequest, contextAged(Math.floor(TTL / 2)));
  const loaded = await contextStore.loadSavedLookReturnContext(actorRequest);
  assert.ok(loaded, 'a fresh context must survive');
  assert.equal(loaded.savedLookId, 'saved-look-1');
  assert.equal(loaded.slotKey, 'footwear');
});

test('DEFECT-P6-005: a context timestamped in the future is refused', async () => {
  // A clock that moved backwards must not extend the window indefinitely.
  values.clear();
  const actorRequest = request();
  await contextStore.persistSavedLookReturnContext(actorRequest, contextAged(-10 * 60_000));
  assert.equal(await contextStore.loadSavedLookReturnContext(actorRequest), null);
});

test('DEFECT-P6-005: expiry is evaluated at the boundary, not approximately', async () => {
  values.clear();
  const actorRequest = request();
  const created = new Date(1_000_000).toISOString();
  const fixed = {
    savedLookId: 'saved-look-1', slotKey: 'footwear',
    returnRoute: '/stylist/saved-looks/saved-look-1', createdAt: created,
  };

  await contextStore.persistSavedLookReturnContext(actorRequest, fixed);
  assert.ok(
    await contextStore.loadSavedLookReturnContext(actorRequest, { nowMs: 1_000_000 + TTL }),
    'exactly at the TTL must still be usable',
  );

  await contextStore.persistSavedLookReturnContext(actorRequest, fixed);
  assert.equal(
    await contextStore.loadSavedLookReturnContext(actorRequest, { nowMs: 1_000_000 + TTL + 1 }),
    null,
    'one millisecond past the TTL must be refused',
  );
});

test('DEFECT-P6-005: a slot the Saved Look no longer has is not highlighted', () => {
  const stale = contextAged(0, 'outerwear');                 // outerwear removed since handoff
  assert.equal(contextStore.resolveReturnContextSlot(stale, lookFor()), null);
});

test('DEFECT-P6-005: a slot the Saved Look still has is highlighted', () => {
  assert.equal(contextStore.resolveReturnContextSlot(contextAged(0, 'footwear'), lookFor()), 'footwear');
});

test('DEFECT-P6-005: a context for a different Saved Look is never highlighted', () => {
  const other = contextAged(0, 'footwear', 'saved-look-OTHER');
  assert.equal(contextStore.resolveReturnContextSlot(other, lookFor()), null);
});

test('DEFECT-P6-005: missing or malformed inputs resolve to no highlight', () => {
  const look = lookFor();
  assert.equal(contextStore.resolveReturnContextSlot(null, look), null);
  assert.equal(contextStore.resolveReturnContextSlot(contextAged(0), null), null);
  assert.equal(contextStore.resolveReturnContextSlot({ savedLookId: '', slotKey: 'footwear' }, look), null);
  assert.equal(contextStore.resolveReturnContextSlot(contextAged(0), { id: 'saved-look-1' }), null);
  assert.equal(contextStore.resolveReturnContextSlot(contextAged(0), { id: 'saved-look-1', slots: 'nope' }), null);
});

test('DEFECT-P6-005: actor matching still governs, TTL or not', async () => {
  values.clear();
  const actorRequestA = request('actor-a');
  await contextStore.persistSavedLookReturnContext(actorRequestA, contextAged(0));

  actor.advanceActorEpoch('actor-b');
  const actorRequestB = actor.createActorRequest();
  assert.equal(
    await contextStore.loadSavedLookReturnContext(actorRequestB),
    null,
    "actor B must not read actor A's context",
  );

  // Actor B's refused read must not have destroyed actor A's entry either.
  actor.advanceActorEpoch('actor-a');
  assert.ok(
    await contextStore.loadSavedLookReturnContext(actor.createActorRequest()),
    "actor A's context must survive actor B's read",
  );
});
