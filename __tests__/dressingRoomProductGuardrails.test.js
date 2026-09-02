const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const deepLinks = require('../services/roomDeepLinks');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function loadTsModule(relativePath, requireMap = {}) {
  const filename = path.join(ROOT, relativePath);
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
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

// Production/staging EAS values for the room flags (eas.json `staging` and
// `production` profiles both set all four to "true").
const SHIPPING_FLAGS = {
  ROOM_CHAT_ENABLED: true,
  DRESSING_ROOM_COLLABORATION_V1: true,
  DRESSING_ROOM_REACTIONS_V1: true,
  ELISE_SHARED_ROOM_EVIDENCE_V1: true,
  SHARED_ROOM_CONTRIBUTIONS_V1: false,
};

function loadCapabilities(flags = SHIPPING_FLAGS) {
  return loadTsModule('services/sharedRoomCapabilities.ts', {
    '../constants/featureFlags': { ...SHIPPING_FLAGS, ...flags },
    './sharedRoomMemberships': {},
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// DR-REG-003 — emoji/reactions belong to BOTH the owner and the authorized
// shared person. This is a shared collaboration feature and must never become
// owner-only. Mutation control DR-NC-EMOJI-MEMBER (restrict reactions to the
// owner) fails the second assertion below.
// ═══════════════════════════════════════════════════════════════════════════

test('DR-REG-003: reactions are available to the owner AND the active shared person', () => {
  const caps = loadCapabilities();
  const owner = caps.resolveSharedRoomCapabilities({
    isAuthenticated: true,
    isOwner: true,
    availability: 'available',
  });
  const sharedPerson = caps.resolveSharedRoomCapabilities({
    isAuthenticated: true,
    isOwner: false,
    availability: 'available',
  });

  assert.equal(owner.canReact, true, 'the room owner must be able to react');
  assert.equal(
    sharedPerson.canReact,
    true,
    'an authorized shared person must be able to react - reactions are not owner-only',
  );
  // Symmetry is the property under test: the two roles must be gated by the
  // same flags, so a change that narrows one narrows both visibly.
  assert.equal(owner.canReact, sharedPerson.canReact);
});

test('DR-REG-003: reaction availability is denied for every unauthorized shape', () => {
  const caps = loadCapabilities();
  const denied = [
    ['removed/unavailable membership', { isAuthenticated: true, isOwner: false, availability: 'unavailable' }],
    ['signed-out viewer', { isAuthenticated: false, isOwner: false, availability: 'available' }],
    ['signed-out owner surface', { isAuthenticated: false, isOwner: true, availability: 'available' }],
  ];
  for (const [label, input] of denied) {
    assert.equal(
      caps.resolveSharedRoomCapabilities(input).canReact,
      false,
      `${label} must not be offered a reaction control`,
    );
  }
});

test('DR-REG-003: an empty but live room still allows both roles to react', () => {
  const caps = loadCapabilities();
  for (const isOwner of [true, false]) {
    assert.equal(
      caps.resolveSharedRoomCapabilities({ isAuthenticated: true, isOwner, availability: 'empty' })
        .canReact,
      true,
    );
  }
});

test('DR-REG-003: reaction actor identity is never client-supplied', () => {
  // set_dressing_room_item_reaction derives the actor from auth.uid() inside a
  // SECURITY DEFINER function; the client sends room, item, type, active and an
  // idempotency key, and no user id. Mutation control DR-NC-017 (accept a
  // client-supplied actor) fails here.
  const collaboration = read('services/dressingRoomCollaboration.ts');
  const reactionCall = collaboration.slice(
    collaboration.indexOf("supabase.rpc('set_dressing_room_item_reaction'"),
  );
  const args = reactionCall.slice(0, reactionCall.indexOf('});'));
  assert.doesNotMatch(args, /p_user_id|p_actor|userId|actorId/, 'no actor id may be sent');
  for (const param of ['p_room_id', 'p_item_id', 'p_reaction_type', 'p_active', 'p_request_id']) {
    assert.ok(args.includes(param), `${param} must be part of the reaction contract`);
  }

  const migration = read('supabase/migrations/20260721201218_dr3_collaborative_interactions.sql');
  const fn = migration.slice(
    migration.indexOf('create or replace function public.set_dressing_room_item_reaction'),
  );
  assert.match(fn.slice(0, 2000), /current_user_id uuid := \(select auth\.uid\(\)\)/);
  assert.match(fn.slice(0, 4000), /security definer/);
});

test('DR-REG-003: a reaction is bound to the room the item actually belongs to', () => {
  // Room/content identity invariant: the RPC re-derives the item's room and
  // refuses a mismatch, so a stale index or a late response cannot attach a
  // reaction for Item A in Room A to a different room. Mutation control
  // DR-NC-018 (drop the room match) fails here.
  const migration = read('supabase/migrations/20260721201218_dr3_collaborative_interactions.sql');
  assert.match(
    migration,
    /select dri\.dressing_room_id\s+into item_room_id[\s\S]{0,400}?item_room_id is distinct from p_room_id/,
    'the RPC must reject an item that does not belong to the supplied room',
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// DR-REG-002 — a Dressing Room share link opens the installed app FIRST, with
// the browser as fallback. Platform association is asserted in
// __tests__/roomDeepLinks.test.js; this file covers the half that association
// alone does not prove: that the canonical share URL the app GENERATES maps to
// a registered in-app route, that the route resolves the token it was given
// (Room A link cannot become Room B), and that the web fallback still exists.
// Mutation control DR-NC-APP-LINK / DR-NC-014 (delete the route or the
// association) fails the first assertion below.
// ═══════════════════════════════════════════════════════════════════════════

test('DR-REG-002: the canonical share URL maps to a registered in-app room route', () => {
  const shareToken = '5c5c1aa5-8b69-4a26-a11a-6454e0b4d0d4';

  // The URL the owner actually shares (app/dressing-rooms/[id].tsx builds
  // `${KSCAN_PUBLIC_BASE_URL}/rooms/${encodeURIComponent(shareToken)}`).
  const roomDetail = read('app/dressing-rooms/[id].tsx');
  assert.match(
    roomDetail,
    /\$\{KSCAN_PUBLIC_BASE_URL\}\/rooms\/\$\{encodeURIComponent\(shareToken\)\}/,
    'the shared URL shape must stay /rooms/<token> on the associated domain',
  );

  const webUrl = deepLinks.buildRoomWebUrl(shareToken);
  assert.equal(webUrl, `https://kscan.app/rooms/${shareToken}`);

  // That path must be a real Expo Router route, or the verified App Link /
  // Universal Link hands off to a 404 and the browser wins by default.
  assert.ok(
    fs.existsSync(path.join(ROOT, 'app', '(public)', 'rooms', '[token].tsx')),
    'app/(public)/rooms/[token].tsx must exist for the app-first hand-off to resolve',
  );

  // Both the HTTPS and the custom-scheme forms resolve to the same token.
  assert.equal(deepLinks.parseRoomDeepLink(webUrl).shareToken, shareToken);
  assert.equal(
    deepLinks.parseRoomDeepLink(deepLinks.buildRoomAppUrl(shareToken)).shareToken,
    shareToken,
  );
});

test('DR-REG-002: a Room A link can never resolve to Room B', () => {
  // Identity, not merely navigation: the route reads its own token parameter,
  // normalizes it, and every preview response is discarded unless the token it
  // was requested for is still the live route token. Mutation control
  // DR-NC-015 (route Room A to Room B) fails here.
  const tokenA = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
  const tokenB = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
  assert.equal(deepLinks.parseRoomDeepLink(deepLinks.buildRoomWebUrl(tokenA)).shareToken, tokenA);
  assert.notEqual(deepLinks.parseRoomDeepLink(deepLinks.buildRoomWebUrl(tokenB)).shareToken, tokenA);

  const screen = read('app/(public)/rooms/[token].tsx');
  assert.match(screen, /routeTokenRef\.current = normalizedRouteToken/);
  assert.match(
    screen,
    /requestId !== previewRequestId\.current \|\|\s*routeTokenRef\.current !== requestedToken/,
    'a preview for one token must never be applied under another',
  );
});

test('DR-REG-002: the browser fallback remains reachable, as a fallback', () => {
  const screen = read('app/(public)/rooms/[token].tsx');
  // App-first: the primary action opens the custom scheme; web is secondary.
  assert.match(screen, /testID="room-open-in-app-button"/);
  assert.match(screen, /testID="room-open-in-web-button"/);
  assert.match(screen, /const appUrl = buildRoomAppUrl\(shareToken\)/);
  // Copy must not invert the order and present the browser as preferred.
  assert.match(screen, /The native app is the primary room experience/);
});

test('DR-REG-002: opening through the app does not bypass share authorization', () => {
  // Deep links navigate; they do not authorize. The route still fetches the
  // preview by token and still requires join_room_via_share_token before any
  // participant capability. Mutation control DR-NC-012 fails here.
  const screen = read('app/(public)/rooms/[token].tsx');
  assert.match(screen, /const result = await fetchRoomPreview\(requestedToken\)/);
  assert.match(screen, /joinedRoomId/);
  assert.match(
    screen,
    /const canReact = Boolean\(capabilities\.canReact && joinedRoomId && reactionItemId\)/,
    'reacting requires an actual joined membership, not merely arriving by link',
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// DR-REG-001 — a shared Dressing Room persists and is reconstructed from
// SERVER state, for the owner and for the authorized shared person, across
// navigation, backgrounding and process death. Mutation control DR-NC-013 /
// DR-NC-PERSISTENCE (break the authoritative reload path) fails these.
//
// SOURCE CONTRACT ONLY. Real process death and device restart need artifact /
// device validation; what is proven here is that no surface depends on
// in-memory state to show a room it has already been shown.
// ═══════════════════════════════════════════════════════════════════════════

test('DR-REG-001: the owner room screen reconstructs from the server, not from memory', () => {
  const screen = read('app/dressing-rooms/[id].tsx');
  // Server read, keyed on the route id.
  assert.match(screen, /const detail = await getDressingRoomDetail\(roomId\)/);
  // Reconstructed on every entry, and again on foreground.
  assert.match(screen, /useFocusEffect\(useCallback\(\(\) => \{\s*void reload\(\);/);
  assert.match(
    screen,
    /AppState\.addEventListener\('change', \(nextState\) => \{[\s\S]{0,200}?void reload\(\);/,
    'returning to the foreground must revalidate against the server',
  );
});

test('DR-REG-001: the owned-room list reconstructs from the server on every focus', () => {
  const hook = read('hooks/useStyleObjects.ts');
  assert.match(hook, /const nextRooms = await listDressingRooms\(\);/);
  assert.match(hook, /useFocusEffect\(\s*useCallback\(\(\) => \{\s*void reload\(\);/);
});

test('DR-REG-001: the authorized shared person reconstructs their rooms from the server', () => {
  // Shared With Me is rebuilt from list_shared_rooms_for_me, a SECURITY DEFINER
  // RPC that re-derives availability per call, so a returning member never
  // depends on a local cache to find a room shared with them.
  const memberships = read('services/sharedRoomMemberships.ts');
  assert.match(memberships, /list_shared_rooms_for_me/);
  const hook = read('hooks/useSharedRoomMemberships.ts');
  assert.match(hook, /listSharedRoomsForCurrentUser\(\)/);
  assert.match(hook, /useFocusEffect/);
});

test('DR-REG-001: persistence never outranks authorization', () => {
  // The same reload path that restores a room is the one that discovers access
  // was lost: an access failure clears protected state instead of leaving a
  // persisted copy on screen.
  const panel = read('components/rooms/RoomMessagesPanel.tsx');
  assert.match(panel, /const applyAccessRevoked = useCallback\(\(\) => \{/);
  assert.match(panel, /setAccessRevoked\(true\);[\s\S]{0,200}?clearInteractiveState\(\);/);
  // Revalidation is deliberately not behind a feature flag.
  assert.match(panel, /Safety-critical, so this is never gated on a feature flag/);
});

test('DR-REG-001: a room reload is bound to its actor and its room', () => {
  // Reconstruction must not become a cross-actor or cross-room leak: the owner
  // screen discards a late detail response whose actor or room has changed.
  const screen = read('app/dressing-rooms/[id].tsx');
  // Anchored to the detail-load site specifically. The same three-part guard
  // appears at several call sites in this file, so an unanchored regex stayed
  // green when the guard was removed from the one that actually writes room
  // state - caught by mutation control DR-NC-005 and tightened here.
  assert.match(
    screen,
    /requestId !== roomLoadRequestId\.current \|\|\s*activeActorIdRef\.current !== requestedActorId \|\|\s*activeRoomIdRef\.current !== roomId\s*\) return;\s*setRoom\(detail\.room\);/,
    'the response that writes room state must be discarded when the actor or the room has changed',
  );
  const hook = read('hooks/useStyleObjects.ts');
  assert.match(hook, /if \(!isActorScopeCurrent\(scope\)\) return;/);
});
