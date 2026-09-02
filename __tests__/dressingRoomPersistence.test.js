/**
 * Durable shared-room persistence.
 *
 * The product invariant: a Dressing Room stays in the owner's and every
 * authorized participant's Dressing Rooms until someone explicitly or
 * authoritatively ends that access. Closing the app is never such an event.
 *
 * The invariant has an equal and opposite security half — persistence must
 * never resurrect revoked access — so these tests assert both directions:
 * nothing about app lifecycle may destroy membership, and nothing cached may
 * outrank the server on whether that membership still stands.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function loadTsModule(relativePath, requireMap = {}) {
  const filename = path.join(ROOT, relativePath);
  const output = ts.transpileModule(read(relativePath), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(
    output,
    {
      __DEV__: false,
      console,
      exports: module.exports,
      module,
      require: (id) => {
        if (id in requireMap) return requireMap[id];
        if (id.startsWith('node:')) return require(id);
        throw new Error(`Unexpected require: ${id}`);
      },
    },
    { filename },
  );
  return module.exports;
}

/** Every surface that renders or manages a shared Dressing Room. */
const ROOM_SURFACES = [
  'app/dressing-rooms/index.tsx',
  'app/dressing-rooms/[id].tsx',
  'app/(public)/rooms/[token].tsx',
  'components/rooms/RoomMessagesPanel.tsx',
  'hooks/useStyleObjects.ts',
  'hooks/useSharedRoomMemberships.ts',
];

/**
 * Calls that durably change whether an account still has a room. None of these
 * may be reachable from an app-lifecycle path.
 */
const MEMBERSHIP_MUTATIONS = [
  'deleteDressingRoom(',
  'revokeRoomShare(',
  'blockDressingRoomUser(',
  'removeSharedRoomForCurrentUser(',
  'left_at',
];

/**
 * Extracts the body of every lifecycle teardown and every app-state handler in
 * a source file: `return () => { … }` cleanups (effect teardown, which is what
 * runs on unmount, blur and screen destruction) and AppState change handlers
 * (background / foreground). Brace-matched rather than regex-sliced so a nested
 * closure cannot fall outside the captured region.
 */
function lifecycleRegions(source) {
  const regions = [];
  const starts = [];
  for (const marker of ['return () => {', 'AppState.addEventListener(']) {
    let at = source.indexOf(marker);
    while (at !== -1) {
      starts.push(source.indexOf('{', at));
      at = source.indexOf(marker, at + marker.length);
    }
  }
  for (const open of starts) {
    if (open === -1) continue;
    let depth = 0;
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          regions.push(source.slice(open, i + 1));
          break;
        }
      }
    }
  }
  return regions;
}

// ═══════════════════════════════════════════════════════════════════════════
// App lifecycle must never end membership.
// Mutation controls DR-PERSIST-NC-001 (teardown leaves the room) and
// DR-PERSIST-NC-007 (disconnect marks the participant left) fail here.
// ═══════════════════════════════════════════════════════════════════════════

test('no lifecycle teardown or app-state handler mutates room membership', () => {
  for (const surface of ROOM_SURFACES) {
    const source = read(surface);
    const regions = lifecycleRegions(source);
    for (const region of regions) {
      for (const mutation of MEMBERSHIP_MUTATIONS) {
        assert.ok(
          !region.includes(mutation),
          `${surface}: an app-lifecycle path calls ${mutation} — closing the app must never end membership`,
        );
      }
    }
  }
});

test('the room surfaces have lifecycle teardown at all, so the guard above is meaningful', () => {
  // Guards against the check above passing vacuously if teardown disappears.
  const withTeardown = ROOM_SURFACES.filter((s) => lifecycleRegions(read(s)).length > 0);
  assert.ok(
    withTeardown.length >= 3,
    `expected several surfaces with lifecycle handlers, found ${withTeardown.length}`,
  );
});

test('teardown releases only ephemeral resources', () => {
  // Subscriptions, timers and listeners may be released; membership may not.
  const panel = read('components/rooms/RoomMessagesPanel.tsx');
  assert.match(panel, /handle\.stop\(\);/, 'the bounded refresh handle is stopped on unmount');
  assert.match(panel, /data\.subscription\.unsubscribe\(\);/, 'the auth listener is unsubscribed');
  // …and stopping the poller is a local timer clear, not a server call.
  const collaboration = read('services/dressingRoomCollaboration.ts');
  const stopFn = collaboration.slice(collaboration.indexOf('const stop = () => {'));
  const stopBody = stopFn.slice(0, stopFn.indexOf('};') + 2);
  assert.match(stopBody, /clearTimeout\(timer\)/);
  for (const mutation of MEMBERSHIP_MUTATIONS) {
    assert.ok(!stopBody.includes(mutation), `stopping sync must not call ${mutation}`);
  }
});

test('unsubscribing is not leaving: no client path writes left_at', () => {
  // left_at is set only by block_dressing_room_user, server-side, inside the
  // block transaction. No client surface writes it, so no disconnect,
  // unmount or background transition can mark a participant departed.
  for (const surface of ROOM_SURFACES) {
    const source = read(surface);
    assert.ok(
      !/left_at\s*[:=]/.test(source),
      `${surface} must not write left_at`,
    );
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Reconstruction is from the server, so a fresh client rebuilds the same rooms.
// Mutation controls DR-PERSIST-NC-002 (owner list from ephemeral state) and
// DR-PERSIST-NC-003 (shared rooms not rebuilt from server membership) fail here.
// ═══════════════════════════════════════════════════════════════════════════

test('the owned-room list is rebuilt from the server on every focus', () => {
  const hook = read('hooks/useStyleObjects.ts');
  assert.match(hook, /const nextRooms = await listDressingRooms\(\);/);
  assert.match(hook, /useFocusEffect\(\s*useCallback\(\(\) => \{\s*void reload\(\);/);
  const service = read('services/styleObjects.ts');
  const fn = service.slice(service.indexOf('export async function listDressingRooms'));
  assert.match(fn.slice(0, 1200), /\.from\('dressing_rooms'\)/, 'owned rooms come from the table');
});

test('shared rooms are rebuilt from server membership on every focus', () => {
  const hook = read('hooks/useSharedRoomMemberships.ts');
  assert.match(hook, /listSharedRoomsForCurrentUser\(\)/);
  assert.match(hook, /useFocusEffect/);
  const service = read('services/sharedRoomMemberships.ts');
  assert.match(service, /supabase\.rpc\('list_shared_rooms_for_me'\)/);
});

test('no room surface persists rooms or membership locally', () => {
  // This is the structural reason a reinstall recovers every authorized room
  // and, equally, the reason a revoked room cannot resurrect from a cache:
  // there is no cache. Membership exists only on the server.
  for (const surface of ROOM_SURFACES) {
    const source = read(surface);
    assert.ok(
      !source.includes('AsyncStorage'),
      `${surface} must not persist room state locally — the server is the only authority`,
    );
  }
  for (const service of [
    'services/sharedRoomMemberships.ts',
    'services/roomMessages.ts',
    'services/styleObjects.ts',
  ]) {
    assert.ok(!read(service).includes('AsyncStorage'), `${service} must not cache rooms locally`);
  }
});

test('availability is re-derived per call, so revocation outranks any earlier answer', () => {
  // list_shared_rooms_for_me recomputes is_available from the live share and
  // the live block relation on every call; a room the caller may no longer
  // reach is reported unavailable with its title and item count withheld.
  const migration = read('supabase/migrations/20260815233353_dressing_room_items_blocking.sql');
  const fn = migration.slice(migration.indexOf('function public.list_shared_rooms_for_me'));
  assert.match(fn, /rs\.is_active = true/);
  assert.match(fn, /rs\.revoked_at is null/);
  assert.match(fn, /rs\.expires_at is null or rs\.expires_at > now\(\)/);
  assert.match(fn, /not internal\.is_dressing_room_pair_blocked\(dr\.user_id, current_user_id\)/);
  assert.match(fn, /when not rm\.is_available then 'unavailable'/);
  assert.match(fn, /when rm\.is_available then[\s\S]{0,200}?else null::text/, 'title withheld when unavailable');
});

// ═══════════════════════════════════════════════════════════════════════════
// Room identity is the server's, never regenerated.
// Mutation control DR-PERSIST-NC-008 fails here.
// ═══════════════════════════════════════════════════════════════════════════

test('reopening a room uses the canonical server id, never a new one', () => {
  const list = read('app/dressing-rooms/index.tsx');
  assert.match(list, /router\.push\(`\/dressing-rooms\/\$\{room\.id\}`\)/);
  // createDressingRoom is reachable only from the explicit create handler,
  // never from a restore or reconstruction path.
  const createCalls = list.match(/createDressingRoom\(/g) || [];
  assert.equal(createCalls.length, 1, 'room creation must have exactly one, explicit call site');
  assert.match(list, /await createDressingRoom\(\{ userId: user\?\.id, title, description \}\)/);
  // A shared room reopens by its server share token.
  assert.match(list, /buildSharedRoomNativePath/);
});

// ═══════════════════════════════════════════════════════════════════════════
// Joining a room must also make it discoverable.
// Mutation controls DR-PERSIST-NC-003 / NC-004 fail here.
// ═══════════════════════════════════════════════════════════════════════════

function loadRoomMessages({ joinResult, saveImpl } = {}) {
  const rpcCalls = [];
  const saveCalls = [];
  const supabase = {
    auth: { getSession: async () => ({ data: { session: { user: { id: 'user-1' } } } }) },
    rpc: async (name, params) => {
      rpcCalls.push({ name, params });
      if (name === 'join_room_via_share_token') {
        return joinResult ?? { data: 'room-1', error: null };
      }
      return { data: null, error: null };
    },
  };
  const mod = loadTsModule('services/roomMessages.ts', {
    './supabaseClient': { supabase },
    '../constants/featureFlags': { DRESSING_ROOM_THREADS_V1: false },
    './dressingRoomCollaboration': {
      bumpCollabActorGeneration: () => {},
      COLLAB_ACCESS_ERROR: 'This Dressing Room is no longer available.',
      createCollabRequestId: () => 'req-1',
      getCollabActorGeneration: () => 1,
      isCurrentCollabGeneration: () => true,
      mergeMessagesById: (a, b) => [...a, ...b],
    },
    './sharedRoomMemberships': {
      saveSharedRoomForCurrentUser: async (token) => {
        saveCalls.push(token);
        if (saveImpl) return saveImpl(token);
        return { status: 'saved' };
      },
    },
  });
  return { mod, rpcCalls, saveCalls };
}

test('joining a shared room also records it as discoverable', async () => {
  // Access and discovery are two different records. join_room_via_share_token
  // writes dressing_room_participants (access); only save_shared_room_for_me
  // writes shared_room_memberships (what makes the room APPEAR in Dressing
  // Rooms). Proven on staging 2026-09-02: a join without the second record
  // left an active participant who could read and post, and whose Dressing
  // Rooms screen showed nothing at all.
  const { mod, rpcCalls, saveCalls } = loadRoomMessages();
  const roomId = await mod.joinSharedRoom('tok-abc');

  assert.equal(roomId, 'room-1');
  assert.ok(
    rpcCalls.some((c) => c.name === 'join_room_via_share_token' && c.params.p_share_token === 'tok-abc'),
    'the join itself must still happen',
  );
  assert.deepEqual(
    Array.from(saveCalls),
    ['tok-abc'],
    'the same token must be recorded for discovery, so the room survives an app restart',
  );
});

test('a failed discovery record never fails the join', async () => {
  // The join has already succeeded server-side. Reporting a failure would
  // strand the user outside a room they are genuinely a member of.
  const { mod, saveCalls } = loadRoomMessages({
    saveImpl: async () => {
      throw new Error('network');
    },
  });
  const roomId = await mod.joinSharedRoom('tok-abc');
  assert.equal(roomId, 'room-1');
  assert.equal(saveCalls.length, 1, 'it was attempted');
});

test('a rejected join records nothing', async () => {
  // No access means no discovery record: a blocked or revoked account must not
  // be handed a listing for a room it cannot open.
  const { mod, saveCalls } = loadRoomMessages({
    joinResult: { data: null, error: { code: '42501' } },
  });
  await assert.rejects(() => mod.joinSharedRoom('tok-abc'));
  assert.equal(saveCalls.length, 0, 'a denied join must not create a listing');
});

test('the discovery record is bound to the token the join validated', async () => {
  const { mod, rpcCalls, saveCalls } = loadRoomMessages();
  await mod.joinSharedRoom('  tok-xyz  ');
  const join = rpcCalls.find((c) => c.name === 'join_room_via_share_token');
  assert.equal(join.params.p_share_token, 'tok-xyz');
  assert.deepEqual(Array.from(saveCalls), ['tok-xyz'], 'never a different token than the one joined');
});

test('the public route still captures membership on preview, independently', async () => {
  // The join-time record is a second, independent path to the same guarantee,
  // not a replacement: a viewer who opens the link and never taps Join is
  // still listed.
  const capture = loadTsModule('services/captureSharedRoomMembership.ts', {
    './sharedRoomMemberships': { saveSharedRoomForCurrentUser: async () => ({ status: 'saved' }) },
    './roomDeepLinks': require('../services/roomDeepLinks'),
  });
  assert.equal(
    capture.isEligibleForSharedRoomMembershipCapture({
      shareToken: 'tok-abc',
      previewShareToken: 'tok-abc',
      previewStatus: 'available',
      sessionState: { phase: 'authenticated', actorId: 'user-1' },
      platform: 'ios',
    }),
    true,
  );
  // An unauthenticated viewer is never recorded, so a signed-out link open
  // cannot create a membership for whoever signs in next on that device.
  assert.equal(
    capture.isEligibleForSharedRoomMembershipCapture({
      shareToken: 'tok-abc',
      previewShareToken: 'tok-abc',
      previewStatus: 'available',
      sessionState: { phase: 'unauthenticated' },
      platform: 'ios',
    }),
    false,
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// Persistence must not outlive authorization.
// Mutation controls DR-PERSIST-NC-005 (cache bypasses revalidation) and
// DR-PERSIST-NC-006 (Actor A cache authoritative under B) fail here.
// ═══════════════════════════════════════════════════════════════════════════

test('an actor change clears the shared-room snapshot before anything renders', () => {
  const hook = read('hooks/useSharedRoomMemberships.ts');
  assert.match(hook, /clearSharedWithMeForActorChange/);
  assert.match(hook, /if \(actorIdRef\.current !== requestActorId\) return;/);
  assert.match(hook, /isSharedWithMeSnapshotVisibleToActor/);
});

test('the owned-room list rejects a result whose actor has changed', () => {
  const hook = read('hooks/useStyleObjects.ts');
  assert.match(hook, /const scope = captureActorScope\(\);/);
  assert.match(hook, /if \(!isActorScopeCurrent\(scope\)\) return;/);
});

test('an open room revalidates access rather than trusting what it already rendered', () => {
  const screen = read('app/dressing-rooms/[id].tsx');
  assert.match(screen, /const detail = await getDressingRoomDetail\(roomId\)/);
  assert.match(
    screen,
    /AppState\.addEventListener\('change', \(nextState\) => \{[\s\S]{0,200}?void reload\(\);/,
    'returning from the background revalidates against the server',
  );
  const panel = read('components/rooms/RoomMessagesPanel.tsx');
  assert.match(panel, /Safety-critical, so this is never gated on a feature flag/);
  assert.match(panel, /onAccessLost: applyAccessRevoked/);
});

test('losing access flushes room content instead of leaving it on screen', () => {
  const screen = read('app/dressing-rooms/[id].tsx');
  assert.match(screen, /setAccessLost\(true\)/);
  assert.match(screen, /setRoom\(null\)/);
  assert.match(screen, /setItems\(\[\]\)/);
  assert.match(screen, /title=\{accessLost \? 'Dressing Room' : room\?\.title \|\| 'Untitled Room'\}/);
});
