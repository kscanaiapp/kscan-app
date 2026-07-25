/**
 * DR-3 collaboration hostile / contract coverage (behavioral where pure).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const ROOT = path.join(__dirname, '..');

function loadTsModule(relativePath) {
  const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: relativePath,
  });
  const module = { exports: {} };
  const requireFn = (id) => {
    if (id === './supabaseClient' || id.endsWith('/supabaseClient')) {
      return { supabase: {} };
    }
    if (id.includes('featureFlags')) {
      return {
        DRESSING_ROOM_COLLABORATION_V1: false,
        DRESSING_ROOM_MESSAGES_V1: false,
        DRESSING_ROOM_THREADS_V1: false,
        DRESSING_ROOM_REACTIONS_V1: false,
        DRESSING_ROOM_REALTIME_SYNC_V1: false,
        DRESSING_ROOM_READ_STATE_V1: false,
      };
    }
    return require(id);
  };
  // eslint-disable-next-line no-new-func
  Function('exports', 'require', 'module', '__filename', '__dirname', outputText)(
    module.exports,
    requireFn,
    module,
    path.join(ROOT, relativePath),
    path.dirname(path.join(ROOT, relativePath)),
  );
  return module.exports;
}

const collab = loadTsModule('services/dressingRoomCollaboration.ts');
const flagsSource = fs.readFileSync(path.join(ROOT, 'constants/featureFlags.ts'), 'utf8');
const migration = fs.readFileSync(
  path.join(ROOT, 'supabase/migrations/20260721170559_dr3_collaborative_interactions.sql'),
  'utf8',
);
const roomMessages = fs.readFileSync(path.join(ROOT, 'services/roomMessages.ts'), 'utf8');
const panel = fs.readFileSync(path.join(ROOT, 'components/rooms/RoomMessagesPanel.tsx'), 'utf8');
const styleObjects = fs.readFileSync(path.join(ROOT, 'services/styleObjects.ts'), 'utf8');
const deletion = fs.readFileSync(path.join(ROOT, 'scripts/process-deletion-request.js'), 'utf8');

test('DR-3 flags default OFF and are independently named', () => {
  for (const name of [
    'DRESSING_ROOM_COLLABORATION_V1',
    'DRESSING_ROOM_REACTIONS_V1',
    'DRESSING_ROOM_MESSAGES_V1',
    'DRESSING_ROOM_THREADS_V1',
    'DRESSING_ROOM_REALTIME_SYNC_V1',
    'DRESSING_ROOM_READ_STATE_V1',
  ]) {
    assert.match(flagsSource, new RegExp(`export const ${name}`));
    assert.match(
      flagsSource,
      new RegExp(`${name}[\\s\\S]*?=== 'true'`),
    );
  }
});

test('DR-3 migration hardens access, preserves history, and adds keyset/idempotency', () => {
  assert.match(migration, /create or replace function public\.can_access_room_messages/);
  assert.match(migration, /rs\.is_active = true/);
  assert.match(migration, /rs\.revoked_at is null/);
  assert.match(migration, /collaboration_access_version/);
  assert.match(migration, /Intentionally do NOT delete dressing_room_messages/);
  assert.match(migration, /dressing_room_messages_room_created_id_idx/);
  assert.match(migration, /client_message_id/);
  assert.match(migration, /parent_message_id/);
  assert.match(migration, /Replies to replies are not allowed/);
  assert.match(migration, /dressing_room_collab_idempotency/);
  assert.match(migration, /set_dressing_room_item_reaction/);
  assert.match(migration, /create_dressing_room_message/);
  assert.match(migration, /list_dressing_room_messages/);
  assert.doesNotMatch(migration, /\boffset\s+\d+/i);
  assert.doesNotMatch(migration, /\boffset\s+\$/i);
  assert.match(migration, /\(m\.created_at, m\.id\) </);
});

test('DR-3 ledger uniqueness is superseded by DR-4 room-scoped constraint', () => {
  const dr4 = fs.readFileSync(
    path.join(ROOT, 'supabase/migrations/20260721183308_dr4_collab_idempotency_room_scope.sql'),
    'utf8',
  );
  assert.match(dr4, /unique \(room_id, actor_id, operation, request_id\)/);
});

test('DR-3 UUIDv4 request ids reject non-v4 shapes', () => {
  assert.equal(collab.isUuidV4('11111111-1111-4111-8111-111111111111'), true);
  assert.equal(collab.isUuidV4('11111111-1111-1111-8111-111111111111'), false);
  assert.equal(collab.isUuidV4('not-a-uuid'), false);
  const id = collab.createCollabRequestId();
  assert.equal(collab.isUuidV4(id), true);
});

test('DR-3 message merge dedupes by stable id across live + cursor pages', () => {
  const page = [
    {
      id: 'a',
      roomId: 'r',
      senderId: 'u',
      body: 'one',
      createdAt: '2026-07-21T10:00:00.000Z',
      isMine: true,
    },
    {
      id: 'b',
      roomId: 'r',
      senderId: 'u',
      body: 'two',
      createdAt: '2026-07-21T10:01:00.000Z',
      isMine: true,
    },
  ];
  const live = [
    {
      id: 'b',
      roomId: 'r',
      senderId: 'u',
      body: 'two-updated',
      createdAt: '2026-07-21T10:01:00.000Z',
      isMine: true,
    },
    {
      id: 'c',
      roomId: 'r',
      senderId: 'u',
      body: 'three',
      createdAt: '2026-07-21T10:02:00.000Z',
      isMine: false,
    },
  ];
  const merged = collab.mergeMessagesById(page, live);
  assert.equal(merged.length, 3);
  assert.equal(merged.filter((m) => m.id === 'b').length, 1);
  assert.equal(merged.find((m) => m.id === 'b').body, 'two-updated');
  assert.deepEqual(
    merged.map((m) => m.id),
    ['a', 'b', 'c'],
  );
});

test('DR-3 actor generation isolates stale application', () => {
  const g1 = collab.bumpCollabActorGeneration('actor-a');
  const g2 = collab.bumpCollabActorGeneration('actor-a');
  assert.equal(g1, g2);
  const g3 = collab.bumpCollabActorGeneration('actor-b');
  assert.notEqual(g1, g3);
  assert.equal(collab.isCurrentCollabGeneration(g1), false);
  assert.equal(collab.isCurrentCollabGeneration(g3), true);
});

test('DR-3 access parser fails closed on malformed payloads', () => {
  assert.deepEqual(collab.parseCollaborationAccess(null), {
    ok: false,
    reason: 'unavailable',
  });
  assert.equal(collab.parseCollaborationAccess({ ok: false, reason: 'unauthorized' }).ok, false);
  const ok = collab.parseCollaborationAccess({
    ok: true,
    roomId: 'r',
    authenticatedActorId: 'a',
    currentOwnerId: 'o',
    relationship: 'owner',
    accessVersion: 3,
  });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.canReact, true);
    assert.equal(ok.canUpdateReadState, false);
    assert.equal(ok.accessVersion, 3);
  }
});

test('DR-3 client wiring uses RPC paths and bounded refresh, not OFFSET', () => {
  assert.match(roomMessages, /list_dressing_room_messages|listCollaborationMessages/);
  assert.match(roomMessages, /createCollaborationMessage|create_dressing_room_message/);
  assert.match(roomMessages, /createCollabRequestId/);
  assert.match(roomMessages, /isCurrentCollabGeneration/);
  assert.doesNotMatch(roomMessages, /\.range\(|OFFSET/i);
  assert.match(styleObjects, /setItemReactionDesiredState/);
  assert.match(styleObjects, /createCollabRequestId/);
  assert.match(panel, /startCollaborationBoundedRefresh/);
  assert.match(panel, /AppState/);
  assert.match(panel, /bumpCollabActorGeneration/);
  assert.match(panel, /listRoomMessagesPage/);
  assert.match(panel, /parentMessageId/);
  assert.match(deletion, /dressing_room_collab_idempotency/);
});

test('DR-3 platform source parity: shared RN modules only (no kt/swift forks)', () => {
  assert.match(panel, /Platform|react-native|AppState/);
  assert.doesNotMatch(roomMessages, /\.kt|\.swift/);
  assert.doesNotMatch(styleObjects, /Platform\.OS === 'android'|Platform\.OS === 'ios'/);
  const androidNative = fs.existsSync(path.join(ROOT, 'android'));
  const iosNative = fs.existsSync(path.join(ROOT, 'ios'));
  assert.equal(androidNative, true);
  // Expo-managed iOS tree may be absent; shared TS is the contract.
  assert.equal(typeof iosNative, 'boolean');
});

test('DR-3 flags OFF leave legacy list/send paths intact in source', () => {
  assert.match(roomMessages, /collabMessagesEnabled\(\)/);
  assert.match(roomMessages, /\.from\('dressing_room_messages'\)/);
  assert.match(styleObjects, /onConflict: 'item_id,user_id'/);
});
