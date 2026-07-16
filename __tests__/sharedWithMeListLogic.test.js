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
      if (id === './sharedRoomMemberships') return {};
      throw new Error(`Unexpected require: ${id}`);
    },
  }, { filename });
  return module.exports;
}

const logic = loadTsModule('services/sharedWithMeListLogic.ts');

function makeRoom(overrides = {}) {
  return {
    shareToken: 'token-a',
    title: 'Summer Capsule',
    itemCount: 3,
    firstOpenedAt: '2026-07-01T00:00:00.000Z',
    lastAccessedAt: '2026-07-02T00:00:00.000Z',
    availability: 'available',
    updatedAt: '2026-07-03T00:00:00.000Z',
    ...overrides,
  };
}

test('actor change clears prior shared rooms immediately', () => {
  const previous = {
    phase: 'ready',
    rooms: [makeRoom()],
    actorId: 'user-a',
    generation: 2,
    errorMessage: null,
  };
  const next = logic.clearSharedWithMeForActorChange(previous, 'user-b');
  assert.equal(next.rooms.length, 0);
  assert.equal(next.actorId, 'user-b');
  assert.equal(next.phase, 'loading');
  assert.equal(next.generation, 3);
});

test('unauthenticated actor does not retain prior rooms', () => {
  const previous = {
    phase: 'ready',
    rooms: [makeRoom()],
    actorId: 'user-a',
    generation: 1,
    errorMessage: null,
  };
  const next = logic.clearSharedWithMeForActorChange(previous, null);
  assert.equal(next.phase, 'unauthenticated');
  assert.equal(next.rooms.length, 0);
  assert.equal(next.actorId, null);
});

test('successful list result renders ready or empty', () => {
  const previous = logic.beginSharedWithMeLoad(logic.createSharedWithMeSnapshot('user-1'), 'user-1');
  const ready = logic.applySharedWithMeListResult({
    previous,
    generation: previous.generation,
    actorId: 'user-1',
    result: { ok: true, rooms: [makeRoom()] },
    removedTokens: new Set(),
  });
  assert.equal(ready.phase, 'ready');
  assert.equal(ready.rooms.length, 1);

  const empty = logic.applySharedWithMeListResult({
    previous,
    generation: previous.generation,
    actorId: 'user-1',
    result: { ok: true, rooms: [] },
    removedTokens: new Set(),
  });
  assert.equal(empty.phase, 'empty');
  assert.equal(empty.rooms.length, 0);
});

test('temporary failure does not appear as empty when prior rooms exist', () => {
  const previous = {
    phase: 'ready',
    rooms: [makeRoom()],
    actorId: 'user-1',
    generation: 4,
    errorMessage: null,
  };
  const next = logic.applySharedWithMeListResult({
    previous,
    generation: 4,
    actorId: 'user-1',
    result: { ok: false, reason: 'temporary_failure' },
    removedTokens: new Set(),
  });
  assert.equal(next.phase, 'temporary_failure');
  assert.equal(next.rooms.length, 1);
  assert.equal(next.errorMessage, logic.SHARED_WITH_ME_REFRESH_ERROR);
});

test('temporary failure with no prior rooms is not empty', () => {
  const previous = {
    phase: 'loading',
    rooms: [],
    actorId: 'user-1',
    generation: 1,
    errorMessage: null,
  };
  const next = logic.applySharedWithMeListResult({
    previous,
    generation: 1,
    actorId: 'user-1',
    result: { ok: false, reason: 'temporary_failure' },
    removedTokens: new Set(),
  });
  assert.equal(next.phase, 'temporary_failure');
  assert.notEqual(next.phase, 'empty');
});

test('stale generation and actor mismatches are ignored', () => {
  const previous = {
    phase: 'loading',
    rooms: [],
    actorId: 'user-1',
    generation: 5,
    errorMessage: null,
  };
  assert.equal(
    logic.applySharedWithMeListResult({
      previous,
      generation: 4,
      actorId: 'user-1',
      result: { ok: true, rooms: [makeRoom()] },
      removedTokens: new Set(),
    }),
    null,
  );
  assert.equal(
    logic.applySharedWithMeListResult({
      previous,
      generation: 5,
      actorId: 'user-2',
      result: { ok: true, rooms: [makeRoom()] },
      removedTokens: new Set(),
    }),
    null,
  );
});

test('stale list result does not resurrect removed card', () => {
  const previous = {
    phase: 'ready',
    rooms: [],
    actorId: 'user-1',
    generation: 2,
    errorMessage: null,
  };
  const next = logic.applySharedWithMeListResult({
    previous,
    generation: 2,
    actorId: 'user-1',
    result: { ok: true, rooms: [makeRoom({ shareToken: 'token-a' })] },
    removedTokens: new Set(['token-a']),
  });
  assert.equal(next.phase, 'empty');
  assert.equal(next.rooms.length, 0);
});

test('optimistic removal and failed restore work', () => {
  const rooms = [makeRoom({ shareToken: 'token-a' }), makeRoom({ shareToken: 'token-b', lastAccessedAt: '2026-07-04T00:00:00.000Z' })];
  const removed = logic.applyOptimisticSharedRoomRemoval(rooms, 'token-a');
  assert.equal(removed.length, 1);
  assert.equal(removed[0].shareToken, 'token-b');

  const restored = logic.restoreSharedRoomAfterFailedRemoval(removed, rooms[0]);
  assert.equal(restored.length, 2);
  assert.equal(restored[0].shareToken, 'token-b');
});

test('available and empty rooms are openable; unavailable is not', () => {
  assert.equal(logic.canOpenSharedRoom(makeRoom({ availability: 'available' })), true);
  assert.equal(logic.canOpenSharedRoom(makeRoom({ availability: 'empty', itemCount: 0 })), true);
  assert.equal(logic.canOpenSharedRoom(makeRoom({ availability: 'unavailable' })), false);
});

test('canonical token route contains no private ids', () => {
  const path = logic.buildSharedRoomNativePath('active-token-a');
  assert.equal(path, '/rooms/active-token-a');
  assert.doesNotMatch(path, /room_id|membership|owner/i);
});

test('accessibility labels distinguish unavailable rooms', () => {
  assert.match(
    logic.sharedRoomAccessibilityLabel(makeRoom()),
    /Shared Dressing Room, Summer Capsule, 3 items/,
  );
  assert.match(
    logic.sharedRoomAccessibilityLabel(makeRoom({ availability: 'unavailable', title: null })),
    /no longer available/,
  );
});
