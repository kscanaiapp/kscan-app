/**
 * DR-4 hostile collaboration + commerce regression coverage.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const ROOT = path.join(__dirname, '..');

function loadTsModule(relativePath, flagOverrides = {}) {
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
    if (id === 'expo-crypto') {
      return {
        randomUUID: () => '11111111-1111-4111-8111-111111111111',
        getRandomBytes: (length) => new Uint8Array(length),
      };
    }
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
        DRESSING_ROOM_CANONICAL_ITEM_V1: true,
        DRESSING_ROOM_COMMERCE_PRESERVATION_V1: true,
        DRESSING_ROOM_DEDUPE_V1: false,
        ...flagOverrides,
      };
    }
    if (id.includes('dressingRoomItemContract') || id.endsWith('./dressingRoomItemContract')) {
      return require(path.join(ROOT, 'services/dressingRoomItemContract.ts'.replace(/\.ts$/, '')));
    }
    try {
      return require(id);
    } catch {
      const resolved = path.resolve(path.dirname(path.join(ROOT, relativePath)), id);
      if (fs.existsSync(resolved + '.ts')) {
        return loadTsModule(path.relative(ROOT, resolved + '.ts').replace(/\\/g, '/'), flagOverrides);
      }
      throw new Error(`Cannot require ${id}`);
    }
  };
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
const dr3Migration = fs.readFileSync(
  path.join(ROOT, 'supabase/migrations/20260721170559_dr3_collaborative_interactions.sql'),
  'utf8',
);
const dr4Migration = fs.readFileSync(
  path.join(ROOT, 'supabase/migrations/20260721183308_dr4_collab_idempotency_room_scope.sql'),
  'utf8',
);
const panel = fs.readFileSync(path.join(ROOT, 'components/rooms/RoomMessagesPanel.tsx'), 'utf8');
const roomMessages = fs.readFileSync(path.join(ROOT, 'services/roomMessages.ts'), 'utf8');
const styleObjects = fs.readFileSync(path.join(ROOT, 'services/styleObjects.ts'), 'utf8');
const commerce = fs.readFileSync(path.join(ROOT, 'services/dressingRoomCommerce.ts'), 'utf8');
const contract = fs.readFileSync(path.join(ROOT, 'services/dressingRoomItemContract.ts'), 'utf8');
const attachmentContext = fs.readFileSync(
  path.join(ROOT, 'supabase/functions/stylechat-generate/attachmentContext.ts'),
  'utf8',
);
const visualPipeline = fs.readFileSync(
  path.join(ROOT, 'supabase/functions/stylechat-generate/eliseVisualContextPipeline.ts'),
  'utf8',
);

test('DR-4 idempotency unique key includes room_id', () => {
  assert.match(
    dr4Migration,
    /unique \(room_id, actor_id, operation, request_id\)/,
  );
  assert.match(dr4Migration, /where room_id = p_room_id/);
  assert.match(dr4Migration, /alter column room_id set not null/);
  // Cross-room same requestId must not collide after DR-4
  assert.doesNotMatch(
    dr4Migration,
    /constraint dressing_room_collab_idempotency_actor_op_request_key\s+unique \(actor_id, operation, request_id\)/,
  );
});

test('DR-4 message table uniqueness remains room-scoped', () => {
  assert.match(
    dr3Migration,
    /dressing_room_messages_sender_room_client_msg_uidx[\s\S]*\(sender_id, room_id, client_message_id\)/,
  );
});

test('DR-4 access errors from onTick tear down sync', () => {
  assert.match(
    fs.readFileSync(path.join(ROOT, 'services/dressingRoomCollaboration.ts'), 'utf8'),
    /isCollaborationAccessError/,
  );
  assert.match(
    fs.readFileSync(path.join(ROOT, 'services/dressingRoomCollaboration.ts'), 'utf8'),
    /onAccessLost\(\);\s*\n\s*stop\(\);/,
  );
});

test('DR-4 catch-up uses newer keyset and bounds pages', () => {
  const source = fs.readFileSync(
    path.join(ROOT, 'services/dressingRoomCollaboration.ts'),
    'utf8',
  );
  assert.match(source, /catchUpCollaborationMessages/);
  assert.match(source, /DR3_COLLAB_CATCHUP_MAX_PAGES/);
  assert.match(source, /direction: 'newer'/);
  assert.match(panel, /catchUpRoomMessages/);
  assert.match(panel, /newestCursorRef/);
});

test('DR-4 send applies generation and revoke guards', () => {
  assert.match(panel, /sendGeneration/);
  assert.match(panel, /isCurrentCollabGeneration\(sendGeneration\)/);
  assert.match(roomMessages, /ROOM_MESSAGES_STALE_ERROR/);
  assert.match(panel, /ROOM_MESSAGES_STALE_ERROR/);
});

test('DR-4 merge remains stable under equal timestamps and live insert', () => {
  const base = [
    {
      id: '00000000-0000-4000-8000-000000000001',
      roomId: 'r',
      senderId: 'a',
      body: 'a',
      createdAt: '2026-07-21T12:00:00.000Z',
      isMine: true,
    },
    {
      id: '00000000-0000-4000-8000-000000000002',
      roomId: 'r',
      senderId: 'a',
      body: 'b',
      createdAt: '2026-07-21T12:00:00.000Z',
      isMine: true,
    },
  ];
  const live = [
    {
      id: '00000000-0000-4000-8000-000000000003',
      roomId: 'r',
      senderId: 'b',
      body: 'c',
      createdAt: '2026-07-21T12:00:00.000Z',
      isMine: false,
    },
    base[1],
  ];
  const merged = collab.mergeMessagesById(base, live);
  assert.equal(merged.length, 3);
  assert.deepEqual(
    merged.map((m) => m.id),
    [
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000003',
    ],
  );
});

test('DR-4 actor generation discards stale apply', () => {
  const gA = collab.bumpCollabActorGeneration('user-a');
  assert.equal(collab.isCurrentCollabGeneration(gA), true);
  const gB = collab.bumpCollabActorGeneration('user-b');
  assert.equal(collab.isCurrentCollabGeneration(gA), false);
  assert.equal(collab.isCurrentCollabGeneration(gB), true);
});

test('DR-4 access error classifier recognizes revoke classes', () => {
  assert.equal(collab.isCollaborationAccessError(collab.COLLAB_ACCESS_ERROR), true);
  assert.equal(collab.isCollaborationAccessError(new Error('Shared room is unavailable')), true);
  assert.equal(collab.isCollaborationAccessError(new Error('network down')), false);
});

test('DR-4 flat-thread and keyset contracts remain present', () => {
  assert.match(dr3Migration, /Replies to replies are not allowed/);
  assert.match(dr3Migration, /\(m\.created_at, m\.id\) </);
  assert.doesNotMatch(dr3Migration, /\boffset\s+\d+/i);
  assert.match(panel, /!replyTo\.parentMessageId/);
});

test('DR-4 no AsyncStorage persistence of room collaboration state', () => {
  assert.doesNotMatch(panel, /AsyncStorage|MMKV|persist\(/);
  assert.doesNotMatch(roomMessages, /AsyncStorage|MMKV/);
  assert.doesNotMatch(
    fs.readFileSync(path.join(ROOT, 'services/dressingRoomCollaboration.ts'), 'utf8'),
    /AsyncStorage|MMKV/,
  );
});

test('DR-4 Scanner commerce fields survive contract + styleObjects writers', () => {
  assert.match(commerce, /affiliateUrl|affiliate_url/);
  assert.match(commerce, /purchaseOptions|purchase_options/);
  assert.match(contract, /normalizePurchaseOptions|purchaseOptions/);
  assert.match(styleObjects, /DRESSING_ROOM_COMMERCE_PRESERVATION_V1/);
  assert.match(styleObjects, /snapshotPayload\.purchaseOptions/);
  // Collaboration reaction path must not rewrite item snapshots
  assert.doesNotMatch(
    fs.readFileSync(
      path.join(ROOT, 'supabase/migrations/20260721183308_dr4_collab_idempotency_room_scope.sql'),
      'utf8',
    ),
    /update public\.dressing_room_items|snapshot_payload/,
  );
});

test('DR-4 Elise model text excludes raw purchase/affiliate URLs', () => {
  assert.match(attachmentContext, /NEVER contains[\s\S]*product arrays/i);
  assert.match(attachmentContext, /dressingRoomItemToEvidence/);
  assert.doesNotMatch(attachmentContext, /affiliateUrl|purchaseOptions/);
  assert.match(visualPipeline, /purchaseUrlPresent/);
  // Boolean presence only — not raw URL injection into model text builders
  assert.match(visualPipeline, /purchaseUrlPresent:\s*(Boolean|!!|Boolean\()/);
});

test('DR-4 flags remain default OFF', () => {
  const flags = fs.readFileSync(path.join(ROOT, 'constants/featureFlags.ts'), 'utf8');
  for (const name of [
    'DRESSING_ROOM_COLLABORATION_V1',
    'DRESSING_ROOM_REACTIONS_V1',
    'DRESSING_ROOM_MESSAGES_V1',
    'DRESSING_ROOM_THREADS_V1',
    'DRESSING_ROOM_REALTIME_SYNC_V1',
  ]) {
    assert.match(flags, new RegExp(`${name}[\\s\\S]*?=== 'true'`));
  }
});

test('DR-4 revoke preserves history and bumps access version', () => {
  assert.match(dr3Migration, /Intentionally do NOT delete dressing_room_messages/);
  assert.match(dr3Migration, /collaboration_access_version = collaboration_access_version \+ 1/);
});
