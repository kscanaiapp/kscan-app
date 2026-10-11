'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRenderer, runModule, settle, deferred } = require('./helpers/componentRenderer');

/**
 * The Closet's first load must always END (Production Scanner debugger, P-CLOSET-1).
 *
 * `useCloset.hydrate` and `useCloset.refresh` share ONE generation counter.
 * hydrate starts a local read, then fires the cross-device restore pass and, when
 * that settles, calls `refresh()`. A restore pass that settles before the read
 * does (a no-op when the restore flag is off, which is how every store profile
 * ships) made `refresh()` take the generation: the original read then resolved,
 * found itself stale, and returned WITHOUT clearing `loading`. `refresh()` never
 * touches `loading`, so the screen spun forever, with no error state, on a Closet
 * whose items were safely on disk.
 *
 * The real hook is executed; only the device/network edges are stubbed.
 */

const CODES = { ACTOR_CHANGED: 'actor_changed', READ_FAILED: 'read_failed' };

function mount({ restore, loadClosetTyped }) {
  const renderer = createRenderer();
  const modules = {
    ...renderer.runtimeModules,
    // useFocusEffect: run on focus, clean up on blur/unmount, re-run when the
    // callback identity changes (the contract the hook relies on).
    'expo-router': { useFocusEffect: (callback) => renderer.react.useEffect(() => callback(), [callback]) },
    '../services/closetLibrary': {
      loadClosetTyped,
      CLOSET_LOAD_CODES: CODES,
      deleteClosetItem: async () => true,
      createClosetItem: async () => ({ ok: true }),
      updateClosetItem: async () => ({ ok: true }),
    },
    '../services/closetPromotion': { promoteScanToCloset: async () => ({ ok: true }) },
    '../services/closetItemProjection': { getClosetItemProjections: (items) => items },
    '../services/actorContext': {
      createActorRequest: () => ({ epoch: 1 }),
      isActorRequestCurrent: () => true,
    },
    '../services/closet/closetSyncCoordinator': {
      afterClosetItemDeleted: async () => {},
      beforeClosetItemDeleted: async () => ({ ok: true, previous: null }),
      noteClosetItemSaved: async () => {},
      revertClosetItemDeleteMark: async () => {},
      resumeClosetSync: async () => {},
    },
    '../services/closet/closetRestoreEngine': { resumeClosetRestore: restore },
    '../services/closet/closetHistoricalMigrationEngine': { resumeClosetHistoricalMigration: async () => {} },
    '../contexts/AuthSessionContext': {
      useAuthSession: () => ({ isAuthenticated: true, user: { id: 'user-a' } }),
    },
  };
  const hook = runModule('hooks/useCloset.js', modules, { jsx: false });
  let latest = null;
  function Probe() {
    latest = hook.useCloset();
    return null;
  }
  const rerender = () => renderer.render(renderer.jsx(Probe, {}));
  rerender();
  return { rerender, current: () => latest };
}

/** A read the test finishes by hand; every call to loadClosetTyped is recorded. */
function controllableReads() {
  const reads = [];
  return {
    reads,
    loadClosetTyped: () => {
      const read = deferred();
      reads.push(read);
      return read.promise;
    },
  };
}

const ITEMS = [{ id: 'closet-1' }];

test('restore that settles BEFORE the local read: loading still ends and the items show', async () => {
  const { reads, loadClosetTyped } = controllableReads();
  const view = mount({ restore: async () => {}, loadClosetTyped });
  assert.equal(view.current().loading, true, 'starts loading');

  // The no-op restore pass settles and calls refresh() before any read finishes.
  await settle();
  view.rerender();
  assert.equal(reads.length, 2, 'hydrate read + the refresh the restore pass triggered');

  // The disk reads now finish, original first (the order a real disk produces).
  reads[0].resolve({ ok: true, items: ITEMS });
  await settle();
  reads[1].resolve({ ok: true, items: ITEMS });
  await settle();
  view.rerender();

  assert.equal(view.current().loading, false, 'the first load must end');
  assert.deepEqual(view.current().items, ITEMS);
  assert.equal(view.current().error, null);
});

test('restore that settles BEFORE the local read, refresh answering first, still ends', async () => {
  const { reads, loadClosetTyped } = controllableReads();
  const view = mount({ restore: async () => {}, loadClosetTyped });
  await settle();
  view.rerender();

  reads[1].resolve({ ok: true, items: ITEMS });
  await settle();
  reads[0].resolve({ ok: true, items: ITEMS });
  await settle();
  view.rerender();

  assert.equal(view.current().loading, false);
  assert.deepEqual(view.current().items, ITEMS);
});

test('a failed read still ends loading and reports the failure, never an empty Closet', async () => {
  const { reads, loadClosetTyped } = controllableReads();
  const view = mount({ restore: async () => {}, loadClosetTyped });
  await settle();
  view.rerender();

  reads[0].resolve({ ok: false, items: [], code: CODES.READ_FAILED, message: 'disk unreadable' });
  reads[1].resolve({ ok: false, items: [], code: CODES.READ_FAILED, message: 'disk unreadable' });
  await settle();
  view.rerender();

  assert.equal(view.current().loading, false);
  assert.deepEqual(view.current().items, []);
  assert.equal(view.current().error?.code, CODES.READ_FAILED);
});

test('restore slower than the local read: loading ends on the read (unchanged behaviour)', async () => {
  const { reads, loadClosetTyped } = controllableReads();
  const restore = deferred();
  const view = mount({ restore: () => restore.promise, loadClosetTyped });

  reads[0].resolve({ ok: true, items: ITEMS });
  await settle();
  view.rerender();
  assert.equal(view.current().loading, false);
  assert.deepEqual(view.current().items, ITEMS);

  restore.resolve();
  await settle();
  reads[1]?.resolve({ ok: true, items: ITEMS });
  await settle();
  view.rerender();
  assert.equal(view.current().loading, false);
});

test('an actor change during the read does not end loading on the old actor', async () => {
  const { reads, loadClosetTyped } = controllableReads();
  const view = mount({ restore: async () => {}, loadClosetTyped });
  await settle();
  view.rerender();

  reads[0].resolve({ ok: false, items: [], code: CODES.ACTOR_CHANGED, message: '' });
  reads[1].resolve({ ok: false, items: [], code: CODES.ACTOR_CHANGED, message: '' });
  await settle();
  view.rerender();

  assert.equal(view.current().loading, true, 'an ACTOR_CHANGED answer describes nobody; the new actor load still owns loading');
  assert.equal(view.current().error, null);
});
