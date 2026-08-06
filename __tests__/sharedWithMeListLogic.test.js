const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadTsModule(relativePath, requireMap = {}) {
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
    __DEV__: false,
    console,
    exports: module.exports,
    module,
    require: (id) => {
      if (id in requireMap) return requireMap[id];
      if (id === './sharedRoomMemberships') return {};
      if (id === './roomDeepLinks') return require('../services/roomDeepLinks');
      throw new Error(`Unexpected require: ${id}`);
    },
  }, { filename });
  return module.exports;
}

const logic = loadTsModule('services/sharedWithMeListLogic.ts', {
  // Capability resolver mocked at flag-off (viewer) behavior so this suite
  // keeps exercising the pure list logic; resolver behavior itself is
  // covered by sharedRoomCollaborationHotfix.test.js.
  './sharedRoomCapabilities': {
    sharedRoomAccessA11y: (input) =>
      input.availability === 'unavailable'
        ? 'no longer available, shared, view only'
        : 'shared, view only',
  },
});

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

test('User A rooms become non-renderable immediately when the actor changes to User B', () => {
  const snapshot = {
    phase: 'ready',
    rooms: [makeRoom({ shareToken: 'user-a-room' })],
    actorId: 'user-a',
    generation: 2,
    errorMessage: null,
  };
  assert.equal(logic.isSharedWithMeSnapshotVisibleToActor({
    snapshot,
    actorId: 'user-a',
    authLoading: false,
  }), true);
  assert.equal(logic.isSharedWithMeSnapshotVisibleToActor({
    snapshot,
    actorId: 'user-b',
    authLoading: false,
  }), false);
  assert.equal(logic.isSharedWithMeSnapshotVisibleToActor({
    snapshot,
    actorId: 'user-a',
    authLoading: true,
  }), false);
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

test('unauthenticated list completion remains keyed to its requesting actor', () => {
  const previous = {
    phase: 'loading',
    rooms: [],
    actorId: 'user-a',
    generation: 3,
    errorMessage: null,
  };
  const next = logic.applySharedWithMeListResult({
    previous,
    generation: 3,
    actorId: 'user-a',
    result: { ok: false, reason: 'unauthenticated' },
    removedTokens: new Set(),
  });
  assert.equal(next.phase, 'unauthenticated');
  assert.equal(next.actorId, 'user-a');
  assert.equal(next.rooms.length, 0);
});

test('missing or unavailable list RPC presents temporary failure with Retry, never empty', async () => {
  const mockClient = {
    auth: {
      getSession: async () => ({
        data: { session: { user: { id: 'user-1' } } },
        error: null,
      }),
    },
    rpc: async () => ({
      data: null,
      error: {
        code: 'PGRST202',
        message: 'Could not find the function public.list_shared_rooms_for_me without parameters in the schema cache',
      },
    }),
  };
  const memberships = loadTsModule('services/sharedRoomMemberships.ts', {
    './supabaseClient': { supabase: mockClient },
  });

  const listResult = await memberships.listSharedRoomsForCurrentUser();
  assert.equal(listResult.ok, false);
  assert.equal(listResult.reason, 'temporary_failure');
  assert.equal(Object.keys(listResult).sort().join(','), 'ok,reason');

  const previous = logic.beginSharedWithMeLoad(
    logic.createSharedWithMeSnapshot('user-1'),
    'user-1',
  );
  const next = logic.applySharedWithMeListResult({
    previous,
    generation: previous.generation,
    actorId: 'user-1',
    result: listResult,
    removedTokens: new Set(),
  });
  assert.equal(next.phase, 'temporary_failure');

  const presentation = logic.getSharedWithMeSectionPresentation({
    phase: next.phase,
    rooms: next.rooms,
    loading: false,
  });

  assert.equal(presentation.showTemporaryFailure, true);
  assert.equal(presentation.showRetry, true);
  assert.equal(presentation.showEmpty, false);
  assert.equal(presentation.showRooms, false);
  assert.equal(presentation.showLoading, false);
  assert.equal(presentation.failureBody, logic.SHARED_WITH_ME_REFRESH_ERROR);
  assert.equal(presentation.emptyTitle, null);
  assert.equal(presentation.emptySubtitle, null);
  assert.equal(presentation.sectionSubtitle, 'Could not refresh');
  assert.doesNotMatch(
    `${presentation.failureBody}\n${presentation.sectionSubtitle}`,
    /list_shared_rooms_for_me|PGRST202|42883|schema cache|postgres/i,
  );
  assert.doesNotMatch(presentation.sectionSubtitle, /no shared rooms/i);
  assert.doesNotMatch(presentation.failureBody, /no shared rooms/i);
});

test('removing the final shared room transitions to the normal empty state', () => {
  const previous = {
    phase: 'ready',
    rooms: [makeRoom({ shareToken: 'only-token' })],
    actorId: 'user-1',
    generation: 2,
    errorMessage: null,
  };
  const next = logic.applySuccessfulFinalSharedRoomRemoval(previous, 'only-token');
  assert.equal(next.phase, 'empty');
  assert.equal(next.rooms.length, 0);
  assert.equal(next.errorMessage, null);

  const presentation = logic.getSharedWithMeSectionPresentation({
    phase: next.phase,
    rooms: next.rooms,
    loading: false,
  });

  assert.equal(presentation.showEmpty, true);
  assert.equal(presentation.showLoading, false);
  assert.equal(presentation.showTemporaryFailure, false);
  assert.equal(presentation.showRooms, false);
  assert.equal(presentation.emptyTitle, logic.SHARED_WITH_ME_EMPTY_TITLE);
  assert.equal(
    presentation.emptySubtitle,
    'Shared rooms will appear here after you open a Dressing Room link.',
  );
});

// BUG-12: "No shared rooms yet" must not appear twice on screen. The
// SectionHeader's subtitle used to repeat the exact same sentence that the
// EmptyStateCard renders as its own title just below it.
test('empty-state section subtitle does not repeat the EmptyStateCard title (BUG-12)', () => {
  const presentation = logic.getSharedWithMeSectionPresentation({
    phase: 'empty',
    rooms: [],
    loading: false,
  });

  assert.equal(presentation.showEmpty, true);
  assert.equal(presentation.emptyTitle, logic.SHARED_WITH_ME_EMPTY_TITLE);
  // The header subtitle must not duplicate the empty-state title text.
  assert.notEqual(presentation.sectionSubtitle, logic.SHARED_WITH_ME_EMPTY_TITLE);
  assert.notEqual(presentation.sectionSubtitle, 'No shared rooms yet');
  assert.equal(presentation.sectionSubtitle, '');
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

test('User A failed removal cannot restore a card into User B state', () => {
  const userB = {
    phase: 'ready',
    rooms: [makeRoom({ shareToken: 'user-b-room', title: 'User B room' })],
    actorId: 'user-b',
    generation: 8,
    errorMessage: null,
  };
  const result = logic.restoreSharedRoomAfterFailedRemovalForActor({
    previous: userB,
    operationActorId: 'user-a',
    room: makeRoom({ shareToken: 'user-a-room', title: 'User A room' }),
  });
  assert.equal(result, null);
  assert.equal(userB.rooms.length, 1);
  assert.equal(userB.rooms[0].shareToken, 'user-b-room');
});

test('removal-versus-refresh race: delayed stale refresh cannot resurrect removed room', () => {
  const roomA = makeRoom({ shareToken: 'token-a', lastAccessedAt: '2026-07-05T00:00:00.000Z' });
  const roomB = makeRoom({ shareToken: 'token-b', lastAccessedAt: '2026-07-04T00:00:00.000Z' });
  const loaded = {
    phase: 'ready',
    rooms: [roomA, roomB],
    actorId: 'user-1',
    generation: 3,
    errorMessage: null,
  };

  let suppression = logic.createSharedRoomRemovalSuppression('user-1');
  suppression = logic.rememberRemovedSharedRoomToken(suppression, 'user-1', 'token-a');
  const afterRemoval = logic.applySuccessfulFinalSharedRoomRemoval(loaded, 'token-a');
  const afterStale = logic.applySharedWithMeListResult({
    previous: afterRemoval,
    generation: 3,
    actorId: 'user-1',
    result: { ok: true, rooms: [roomA, roomB] },
    removedTokens: logic.removedSharedRoomTokensForActor(suppression, 'user-1'),
  });

  assert.ok(afterStale);
  assert.equal(afterStale.rooms.length, 1);
  assert.equal(afterStale.rooms[0].shareToken, 'token-b');
  assert.equal(
    afterStale.rooms.some((room) => room.shareToken === 'token-a'),
    false,
  );
});

test('successful removal suppression expires so a later legitimate restore can reappear', () => {
  const room = makeRoom({ shareToken: 'restorable-token' });
  const removedSnapshot = {
    phase: 'empty',
    rooms: [],
    actorId: 'user-a',
    generation: 4,
    errorMessage: null,
  };
  let suppression = logic.createSharedRoomRemovalSuppression('user-a');
  suppression = logic.rememberRemovedSharedRoomToken(
    suppression,
    'user-a',
    room.shareToken,
  );
  const removedTokensAtCompletion = new Set(
    logic.removedSharedRoomTokensForActor(suppression, 'user-a'),
  );
  // Request cleanup can run before React applies its deferred state updater.
  suppression = logic.clearSharedRoomRemovalSuppression(suppression, 'user-a');

  const stale = logic.applySharedWithMeListResult({
    previous: removedSnapshot,
    generation: 4,
    actorId: 'user-a',
    result: { ok: true, rooms: [room] },
    removedTokens: removedTokensAtCompletion,
  });
  assert.equal(stale.rooms.length, 0);

  const restored = logic.applySharedWithMeListResult({
    previous: { ...stale, generation: 5 },
    generation: 5,
    actorId: 'user-a',
    result: { ok: true, rooms: [room] },
    removedTokens: logic.removedSharedRoomTokensForActor(suppression, 'user-a'),
  });
  assert.equal(restored.phase, 'ready');
  assert.equal(restored.rooms.length, 1);
  assert.equal(restored.rooms[0].shareToken, 'restorable-token');
});

test('User A request finishing after User B request cannot replace User B state', () => {
  const userBLoading = {
    phase: 'loading',
    rooms: [],
    actorId: 'user-b',
    generation: 12,
    errorMessage: null,
  };
  const userBReady = logic.applySharedWithMeListResult({
    previous: userBLoading,
    generation: 12,
    actorId: 'user-b',
    result: { ok: true, rooms: [makeRoom({ shareToken: 'user-b-room' })] },
    removedTokens: new Set(),
  });
  const lateUserA = logic.applySharedWithMeListResult({
    previous: userBReady,
    generation: 11,
    actorId: 'user-a',
    result: { ok: true, rooms: [makeRoom({ shareToken: 'user-a-room' })] },
    removedTokens: new Set(),
  });
  assert.equal(lateUserA, null);
  assert.equal(userBReady.actorId, 'user-b');
  assert.equal(userBReady.rooms[0].shareToken, 'user-b-room');
});

test('removal suppression is bounded and actor-keyed', () => {
  let suppression = logic.createSharedRoomRemovalSuppression('user-a');
  for (const token of ['one', 'two', 'three', 'four']) {
    suppression = logic.rememberRemovedSharedRoomToken(suppression, 'user-a', token, 3);
  }
  assert.equal(suppression.tokens.size, 3);
  assert.equal(suppression.tokens.has('one'), false);
  assert.equal(logic.removedSharedRoomTokensForActor(suppression, 'user-b').size, 0);

  suppression = logic.rememberRemovedSharedRoomToken(suppression, 'user-b', 'user-b-token', 3);
  assert.equal(suppression.actorId, 'user-b');
  assert.equal(suppression.tokens.size, 1);
  assert.equal(suppression.tokens.has('user-b-token'), true);
});

test('optimistic removal and failed restore work', () => {
  const rooms = [
    makeRoom({ shareToken: 'token-a' }),
    makeRoom({ shareToken: 'token-b', lastAccessedAt: '2026-07-04T00:00:00.000Z' }),
  ];
  const removed = logic.applyOptimisticSharedRoomRemoval(rooms, 'token-a');
  assert.equal(removed.length, 1);
  assert.equal(removed[0].shareToken, 'token-b');

  const restored = logic.restoreSharedRoomAfterFailedRemoval(removed, rooms[0]);
  assert.equal(restored.length, 2);
  assert.equal(restored[0].shareToken, 'token-b');
});

test('sorts by lastAccessedAt descending with stable malformed-timestamp handling', () => {
  const rooms = [
    makeRoom({ shareToken: 'old', lastAccessedAt: '2026-07-01T00:00:00.000Z' }),
    makeRoom({ shareToken: 'new', lastAccessedAt: '2026-07-05T00:00:00.000Z' }),
    makeRoom({ shareToken: 'bad', lastAccessedAt: 'not-a-date' }),
  ];
  const sorted = logic.sortSharedRoomSummaries(rooms);
  assert.equal(sorted[0].shareToken, 'new');
  assert.equal(sorted[1].shareToken, 'old');
  assert.equal(sorted[2].shareToken, 'bad');
});

test('equal last-accessed timestamps preserve deterministic backend order', () => {
  const rooms = [
    makeRoom({ shareToken: 'first' }),
    makeRoom({ shareToken: 'second' }),
    makeRoom({ shareToken: 'third' }),
  ];
  assert.deepEqual(
    Array.from(logic.sortSharedRoomSummaries(rooms), (room) => room.shareToken),
    ['first', 'second', 'third'],
  );
});

test('dialog title truncates without mutating the source title', () => {
  const long = 'A'.repeat(80);
  const formatted = logic.formatSharedRoomDialogTitle(long, 60);
  assert.equal(formatted.length, 60);
  assert.match(formatted, /…$/);
  assert.equal(long.length, 80);
});

test('available and empty rooms are openable; unavailable is not', () => {
  assert.equal(logic.canOpenSharedRoom(makeRoom({ availability: 'available' })), true);
  assert.equal(logic.canOpenSharedRoom(makeRoom({ availability: 'empty', itemCount: 0 })), true);
  assert.equal(logic.canOpenSharedRoom(makeRoom({ availability: 'unavailable' })), false);
});

test('canonical token route contains no private ids', () => {
  const route = logic.buildSharedRoomNativePath('active-token-a');
  assert.equal(route, '/rooms/active-token-a?mode=collaborator');
  assert.doesNotMatch(route, /room_id|membership|owner/i);
  assert.equal(logic.buildSharedRoomNativePath('bad token!'), null);
});

test('malformed and duplicate summaries are dropped without crashing', () => {
  const valid = makeRoom({ shareToken: 'valid-token' });
  const prepared = logic.prepareSharedRoomSummaries([
    valid,
    makeRoom({ shareToken: 'valid-token', title: 'Duplicate' }),
    makeRoom({ shareToken: 'bad token!' }),
    makeRoom({ shareToken: 'bad-count', itemCount: -1 }),
    makeRoom({ shareToken: 'bad-date', lastAccessedAt: 'not-a-date' }),
  ]);
  assert.equal(prepared.length, 1);
  assert.equal(prepared[0].shareToken, 'valid-token');
});

test('accessibility labels distinguish unavailable rooms', () => {
  assert.match(
    logic.sharedRoomAccessibilityLabel(makeRoom()),
    /Shared Dressing Room, Summer Capsule, 3 items/,
  );
  assert.match(
    logic.sharedRoomAccessibilityLabel(makeRoom({ availability: 'unavailable', title: null })),
    /no longer available, shared, view only/,
  );
});

test('long visible titles retain their full accessible name and missing titles are safe', () => {
  const longTitle = 'A'.repeat(90);
  assert.match(
    logic.sharedRoomAccessibilityLabel(makeRoom({ title: longTitle })),
    new RegExp(longTitle),
  );
  assert.equal(
    logic.sharedRoomDisplayTitle(makeRoom({ title: '   ' })),
    'Shared Dressing Room',
  );
});

test('shared room entrance stagger delay grows linearly up to the capped index', () => {
  assert.equal(logic.sharedRoomEnterDelayMs(0, 90), 0);
  assert.equal(logic.sharedRoomEnterDelayMs(1, 90), 90);
  assert.equal(logic.sharedRoomEnterDelayMs(3, 90), 270);
  assert.equal(logic.sharedRoomEnterDelayMs(8, 90), 720);
});

test('shared room entrance stagger delay is capped so a long list does not take seconds to appear', () => {
  // Without a cap, room #49 in a 50-room list would wait 49 * 90ms = 4410ms.
  assert.equal(logic.sharedRoomEnterDelayMs(49, 90), 720);
  assert.equal(
    logic.sharedRoomEnterDelayMs(49, 90),
    logic.sharedRoomEnterDelayMs(8, 90),
  );
  assert.equal(logic.sharedRoomEnterDelayMs(20, 90, 4), 360);
});

test('shared room entrance stagger delay handles non-finite and non-positive input safely', () => {
  assert.equal(logic.sharedRoomEnterDelayMs(-1, 90), 0);
  assert.equal(logic.sharedRoomEnterDelayMs(Number.NaN, 90), 0);
  assert.equal(logic.sharedRoomEnterDelayMs(2, 0), 0);
  assert.equal(logic.sharedRoomEnterDelayMs(2, -90), 0);
  assert.equal(logic.sharedRoomEnterDelayMs(2.9, 90), 180);
});
