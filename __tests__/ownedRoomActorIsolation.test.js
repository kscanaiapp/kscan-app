const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadTsModule(relativePath) {
  const filename = path.join(ROOT, relativePath);
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, {
    exports: module.exports,
    module,
    require: (id) => {
      throw new Error(`Unexpected require: ${id}`);
    },
  }, { filename });
  return module.exports;
}

const logic = loadTsModule('services/ownedRoomListLogic.ts');

test('stale actor A success cannot overwrite actor B rooms', () => {
  let snapshot = logic.createOwnedRoomListSnapshot('actor-a', 1);
  snapshot = logic.beginOwnedRoomListLoad(snapshot, 'actor-a', 2);
  snapshot = logic.clearOwnedRoomListForActorChange(snapshot, 'actor-b');
  snapshot = logic.beginOwnedRoomListLoad(snapshot, 'actor-b', snapshot.generation);
  const bApplied = logic.applyOwnedRoomListResult({
    previous: snapshot,
    generation: snapshot.generation,
    actorId: 'actor-b',
    items: [{ id: 'room-b' }],
  });
  assert.ok(bApplied);
  snapshot = bApplied;

  const staleA = logic.applyOwnedRoomListResult({
    previous: snapshot,
    generation: 2,
    actorId: 'actor-a',
    items: [{ id: 'room-a' }],
  });
  assert.equal(staleA, null);
  assert.deepEqual(snapshot.items.map((room) => room.id), ['room-b']);
});

test('logout clears owned rooms and rejects late responses', () => {
  let snapshot = logic.createOwnedRoomListSnapshot('actor-a', 1);
  snapshot = logic.beginOwnedRoomListLoad(snapshot, 'actor-a', 2);
  snapshot = logic.clearOwnedRoomListForActorChange(snapshot, null);
  assert.equal(snapshot.actorId, null);
  assert.equal(snapshot.items.length, 0);

  const late = logic.applyOwnedRoomListResult({
    previous: snapshot,
    generation: 2,
    actorId: 'actor-a',
    items: [{ id: 'room-a' }],
  });
  assert.equal(late, null);
});

test('stale error after actor switch cannot wipe current rooms', () => {
  let snapshot = logic.createOwnedRoomListSnapshot('actor-b', 5);
  snapshot = {
    ...snapshot,
    items: [{ id: 'room-b' }],
    loading: false,
  };
  const staleError = logic.applyOwnedRoomListResult({
    previous: snapshot,
    generation: 4,
    actorId: 'actor-a',
    errorMessage: 'Unable to load Dressing Rooms.',
  });
  assert.equal(staleError, null);
  assert.deepEqual(snapshot.items.map((room) => room.id), ['room-b']);
});

test('current-actor error preserves existing rooms', () => {
  let snapshot = logic.beginOwnedRoomListLoad(
    logic.createOwnedRoomListSnapshot('actor-a', 1),
    'actor-a',
    2,
  );
  snapshot = {
    ...snapshot,
    items: [{ id: 'keep-me' }],
  };
  const errored = logic.applyOwnedRoomListResult({
    previous: snapshot,
    generation: 2,
    actorId: 'actor-a',
    errorMessage: 'temporary failure',
  });
  assert.ok(errored);
  assert.equal(errored.errorMessage, 'temporary failure');
  assert.deepEqual(errored.items.map((room) => room.id), ['keep-me']);
  assert.equal(errored.loading, false);
});

test('refresh during in-flight request uses newer generation', () => {
  let snapshot = logic.beginOwnedRoomListLoad(
    logic.createOwnedRoomListSnapshot('actor-a', 1),
    'actor-a',
    2,
  );
  snapshot = logic.beginOwnedRoomListLoad(snapshot, 'actor-a', 3);
  const staleRefresh = logic.applyOwnedRoomListResult({
    previous: snapshot,
    generation: 2,
    actorId: 'actor-a',
    items: [{ id: 'stale' }],
  });
  assert.equal(staleRefresh, null);

  const current = logic.applyOwnedRoomListResult({
    previous: snapshot,
    generation: 3,
    actorId: 'actor-a',
    items: [{ id: 'fresh' }],
  });
  assert.ok(current);
  assert.deepEqual(current.items.map((room) => room.id), ['fresh']);
});

test('stale removal mutation cannot resurrect a deleted room for another actor', () => {
  let snapshot = logic.createOwnedRoomListSnapshot('actor-b', 9);
  snapshot = {
    ...snapshot,
    items: [{ id: 'room-b' }],
    loading: false,
  };
  const staleRemoval = logic.applyOwnedRoomLocalMutation({
    previous: snapshot,
    actorId: 'actor-a',
    generation: 8,
    mutate: (items) => [...items, { id: 'deleted-a' }],
  });
  assert.equal(staleRemoval, null);

  const currentRemoval = logic.applyOwnedRoomLocalMutation({
    previous: snapshot,
    actorId: 'actor-b',
    generation: 9,
    mutate: (items) => items.filter((room) => room.id !== 'room-b'),
  });
  assert.ok(currentRemoval);
  assert.deepEqual(currentRemoval.items, []);
});

test('hook wires auth actor guards and generation suppression', () => {
  const hook = fs.readFileSync(path.join(ROOT, 'hooks/useStyleObjects.ts'), 'utf8');
  assert.match(hook, /useAuthSession/);
  assert.match(hook, /generationRef/);
  assert.match(hook, /actorIdRef/);
  assert.match(hook, /clearOwnedRoomListForActorChange/);
  assert.match(hook, /applyOwnedRoomListResult/);
  assert.match(hook, /inFlightActorRef/);
});
