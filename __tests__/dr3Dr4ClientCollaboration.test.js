/**
 * Batch 3 — DR-3 / DR-4 CLIENT-ONLY collaboration coverage.
 *
 * Ported from the donor's __tests__/dr3Collaboration.test.js and
 * __tests__/dr4Hardening.test.js (donor 1575143). Those two donor suites are
 * cross-cutting backend+client audits: they read DR-3/DR-4 migration SQL and
 * the donor's legacy scripts/process-deletion-request.js. Batch 3 is a
 * surgical CLIENT-ONLY integration, so no migration file is added to the tree
 * and the legacy deletion script is superseded by the reconciled
 * supabase/functions/_shared/deletion registry.
 *
 * Every assertion below is one of:
 *   A. CLIENT BEHAVIOR   — ported verbatim in intent from the donor suites.
 *   B. CURRENT BACKEND CONTRACT — retargeted to reconciled in-tree source.
 *
 * The donor's migration-SQL assertions are class C (PRODUCTION CONTRACT) and
 * were validated read-only against the production database during Batch 3
 * integration rather than by adding a migration-file diff. See the Batch 3
 * report for the recorded evidence.
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
    if (id === 'expo-crypto') {
      // Hermes-safe ID source (V17 hotfix): native module mocked for Node.
      return {
        randomUUID: () => '11111111-2222-4333-8444-555555555555',
        getRandomBytes: (n) => new Uint8Array(n),
      };
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

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const collab = loadTsModule('services/dressingRoomCollaboration.ts');
const collabSource = read('services/dressingRoomCollaboration.ts');
const flagsSource = read('constants/featureFlags.ts');
const roomMessages = read('services/roomMessages.ts');
const panel = read('components/rooms/RoomMessagesPanel.tsx');
const styleObjects = read('services/styleObjects.ts');
const commerce = read('services/dressingRoomCommerce.ts');
const contract = read('services/dressingRoomItemContract.ts');
// B. Retarget: donor asserted against scripts/process-deletion-request.js.
// The reconciled tree carries the account-deletion registry here instead.
const deletionRegistry = read('supabase/functions/_shared/deletion/userDataResources.ts');
const attachmentContext = read('supabase/functions/stylechat-generate/attachmentContext.ts');
const visualPipeline = read('supabase/functions/stylechat-generate/eliseVisualContextPipeline.ts');

// ── A. Flags ────────────────────────────────────────────────────────────────

test('DR-3/DR-4 collaboration flags exist, are independently named, and default OFF', () => {
  for (const name of [
    'DRESSING_ROOM_COLLABORATION_V1',
    'DRESSING_ROOM_REACTIONS_V1',
    'DRESSING_ROOM_MESSAGES_V1',
    'DRESSING_ROOM_THREADS_V1',
    'DRESSING_ROOM_REALTIME_SYNC_V1',
    'DRESSING_ROOM_READ_STATE_V1',
  ]) {
    assert.match(flagsSource, new RegExp(`export const ${name}`));
    assert.match(flagsSource, new RegExp(`${name}[\\s\\S]*?=== 'true'`));
  }
});

test('Batch 2 Elise flags survive the DR flag merge with unchanged semantics', () => {
  assert.match(
    flagsSource,
    /ELISE_VISUAL_ATTACHMENTS_V1_ENABLED\s*=\s*\n?\s*process\.env\.EXPO_PUBLIC_ELISE_VISUAL_ATTACHMENTS_V1_ENABLED === 'true'/,
  );
  // Declared exactly once — the donor also defines it, and a duplicated
  // export would be a redeclaration error rather than a merge.
  assert.equal(
    (flagsSource.match(/export const ELISE_ADVICE_METADATA_CLIENT_V1 /g) || []).length,
    1,
  );
});

// ── A. Pure client behavior ─────────────────────────────────────────────────

test('DR-3 UUIDv4 request ids reject non-v4 shapes', () => {
  assert.equal(collab.isUuidV4('11111111-1111-4111-8111-111111111111'), true);
  assert.equal(collab.isUuidV4('11111111-1111-1111-8111-111111111111'), false);
  assert.equal(collab.isUuidV4('not-a-uuid'), false);
  assert.equal(collab.isUuidV4(collab.createCollabRequestId()), true);
});

test('DR-3 message merge dedupes by stable id across live + cursor pages', () => {
  const mk = (id, body, createdAt, isMine) => ({
    id,
    roomId: 'r',
    senderId: 'u',
    body,
    createdAt,
    isMine,
  });
  const page = [
    mk('a', 'one', '2026-07-21T10:00:00.000Z', true),
    mk('b', 'two', '2026-07-21T10:01:00.000Z', true),
  ];
  const live = [
    mk('b', 'two-updated', '2026-07-21T10:01:00.000Z', true),
    mk('c', 'three', '2026-07-21T10:02:00.000Z', false),
  ];
  const merged = collab.mergeMessagesById(page, live);
  assert.equal(merged.length, 3);
  assert.equal(merged.filter((m) => m.id === 'b').length, 1);
  assert.equal(merged.find((m) => m.id === 'b').body, 'two-updated');
  assert.deepEqual(merged.map((m) => m.id), ['a', 'b', 'c']);
});

test('DR-4 merge remains stable under equal timestamps and live insert', () => {
  const at = '2026-07-21T12:00:00.000Z';
  const mk = (id) => ({ id, roomId: 'r', senderId: 'a', body: id, createdAt: at, isMine: true });
  const base = [
    mk('00000000-0000-4000-8000-000000000001'),
    mk('00000000-0000-4000-8000-000000000002'),
  ];
  const live = [mk('00000000-0000-4000-8000-000000000003')];
  const merged = collab.mergeMessagesById(base, live);
  assert.equal(merged.length, 3);
  // Stable, deterministic ordering under identical timestamps.
  assert.deepEqual(collab.mergeMessagesById(base, live).map((m) => m.id), merged.map((m) => m.id));
});

test('DR-3/DR-4 actor generation isolates stale application', () => {
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
  // Missing required identity fields must not be treated as authorized.
  assert.equal(collab.parseCollaborationAccess({ ok: true, roomId: 'r' }).ok, false);
  const ok = collab.parseCollaborationAccess({
    ok: true,
    roomId: 'r',
    authenticatedActorId: 'a',
    currentOwnerId: 'o',
    relationship: 'owner',
    accessVersion: 3,
    canReact: true,
    canMessage: true,
    canReply: true,
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.canReact, true);
  assert.equal(ok.canUpdateReadState, false);
  assert.equal(ok.accessVersion, 3);
});

test('Dressing Room blocking: canMessage/canReact/canReply reflect the backend, never hardcoded true', () => {
  // The backend returns canMessage:false for an owner whose sole participant
  // is blocked, even though ok:true (room + history preserved). The parser
  // must surface that distinction, not paper over it with a hardcoded true.
  const ownerBlockedAudience = collab.parseCollaborationAccess({
    ok: true,
    roomId: 'r',
    authenticatedActorId: 'owner',
    currentOwnerId: 'owner',
    relationship: 'owner',
    accessVersion: 5,
    canReact: false,
    canMessage: false,
    canReply: false,
  });
  assert.equal(ownerBlockedAudience.ok, true);
  assert.equal(ownerBlockedAudience.canMessage, false);
  assert.equal(ownerBlockedAudience.canReact, false);
  assert.equal(ownerBlockedAudience.canReply, false);

  // A payload silently missing these fields must fail closed to false, never
  // default to true.
  const missingFields = collab.parseCollaborationAccess({
    ok: true,
    roomId: 'r',
    authenticatedActorId: 'a',
    currentOwnerId: 'o',
    relationship: 'shared_recipient',
    accessVersion: 1,
  });
  assert.equal(missingFields.ok, true);
  assert.equal(missingFields.canMessage, false);
  assert.equal(missingFields.canReact, false);
  assert.equal(missingFields.canReply, false);
});

test('DR-4 access error classifier recognizes revoke classes', () => {
  assert.equal(collab.isCollaborationAccessError(collab.COLLAB_ACCESS_ERROR), true);
  assert.equal(collab.isCollaborationAccessError(new Error('Shared room is unavailable')), true);
  assert.equal(collab.isCollaborationAccessError(new Error('network down')), false);
});

test('DR-3 client access failures collapse to one generic message (no existence leak)', () => {
  // The RPC distinguishes not_found from unauthorized internally; the client
  // must never surface that distinction to the user.
  const notFound = collab.parseCollaborationAccess({ ok: false, reason: 'not_found' });
  const unauthorized = collab.parseCollaborationAccess({ ok: false, reason: 'unauthorized' });
  assert.equal(notFound.ok, false);
  assert.equal(unauthorized.ok, false);
  assert.equal(collab.isCollaborationAccessError(collab.COLLAB_ACCESS_ERROR), true);
  // Exactly one user-facing string exists for loss of access. It is neutral by
  // contract: the same denial covers an expired link and a block in either
  // direction, so it must not assert a state change ("you no longer have
  // access" is untrue for a first-time joiner blocked before joining) and must
  // not disclose that a block exists.
  assert.equal(collab.COLLAB_ACCESS_ERROR, 'This Dressing Room is no longer available.');
  // The classifier must still recognise the historical wording, or persisted
  // strings would silently stop being treated as access loss.
  assert.equal(
    collab.isCollaborationAccessError('You no longer have access to this room.'),
    true,
  );
  assert.doesNotMatch(panel, /not_found/);
});

// ── A. Client wiring ────────────────────────────────────────────────────────

test('DR-3 client wiring uses RPC paths and bounded refresh, not OFFSET', () => {
  assert.match(roomMessages, /list_dressing_room_messages|listCollaborationMessages/);
  assert.match(roomMessages, /createCollaborationMessage|create_dressing_room_message/);
  assert.match(roomMessages, /createCollabRequestId|isCurrentCollabGeneration/);
  assert.doesNotMatch(roomMessages, /\.range\(|OFFSET/i);
  assert.match(styleObjects, /setItemReactionDesiredState/);
  assert.match(styleObjects, /createCollabRequestId/);
  assert.match(panel, /startCollaborationBoundedRefresh/);
  assert.match(panel, /AppState/);
  assert.match(panel, /bumpCollabActorGeneration/);
  assert.match(panel, /listRoomMessagesPage/);
  assert.match(panel, /parentMessageId/);
});

test('DR-4 access errors from onTick tear down sync', () => {
  assert.match(collabSource, /isCollaborationAccessError/);
  assert.match(collabSource, /onAccessLost\(\);\s*\n\s*stop\(\);/);
});

test('DR-4 catch-up uses newer keyset and bounds pages', () => {
  assert.match(collabSource, /catchUpCollaborationMessages/);
  assert.match(collabSource, /DR3_COLLAB_CATCHUP_MAX_PAGES/);
  assert.match(collabSource, /direction: 'newer'/);
  assert.match(panel, /catchUpRoomMessages/);
  assert.match(panel, /newestCursorRef/);
});

test('DR-4 send applies generation and revoke guards', () => {
  assert.match(panel, /sendGeneration/);
  assert.match(panel, /isCurrentCollabGeneration\(sendGeneration\)/);
  assert.match(roomMessages, /ROOM_MESSAGES_STALE_ERROR/);
  assert.match(panel, /ROOM_MESSAGES_STALE_ERROR/);
});

test('DR-4 flat-thread reply depth is enforced client-side', () => {
  assert.match(panel, /!replyTo\.parentMessageId/);
});

test('DR-4 no AsyncStorage persistence of room collaboration state', () => {
  assert.doesNotMatch(panel, /AsyncStorage|MMKV|persist\(/);
  assert.doesNotMatch(roomMessages, /AsyncStorage|MMKV/);
  assert.doesNotMatch(collabSource, /AsyncStorage|MMKV/);
});

test('Dressing Room blocking: the legacy direct-insert message fallback has been fully removed', () => {
  // Message send/read must always go through the protected RPCs
  // (create_dressing_room_message / list_dressing_room_messages) regardless
  // of feature flags, so block/canMessage enforcement in those RPCs cannot be
  // bypassed by a flag-off build.
  assert.doesNotMatch(roomMessages, /collabMessagesEnabled\(\)/);
  assert.doesNotMatch(roomMessages, /\.from\('dressing_room_messages'\)/);
  assert.match(roomMessages, /create_dressing_room_message|createCollaborationMessage/);
  assert.match(roomMessages, /list_dressing_room_messages|listCollaborationMessages/);
  assert.match(styleObjects, /onConflict: 'item_id,user_id'/);
});

test('DR-3 platform source parity: shared RN modules only (no kt/swift forks)', () => {
  assert.match(panel, /Platform|react-native|AppState/);
  assert.doesNotMatch(roomMessages, /\.kt|\.swift/);
  assert.doesNotMatch(styleObjects, /Platform\.OS === 'android'|Platform\.OS === 'ios'/);
  assert.equal(fs.existsSync(path.join(ROOT, 'android')), true);
});

// ── A + B. Commerce preservation and Elise grounding ────────────────────────

test('DR-4 Scanner commerce fields survive contract + styleObjects writers', () => {
  assert.match(commerce, /affiliateUrl|affiliate_url/);
  assert.match(commerce, /purchaseOptions|purchase_options/);
  assert.match(contract, /normalizePurchaseOptions|purchaseOptions/);
  assert.match(styleObjects, /DRESSING_ROOM_COMMERCE_PRESERVATION_V1/);
  assert.match(styleObjects, /snapshotPayload\.purchaseOptions/);
});

test('DR-4 Elise model text excludes raw purchase/affiliate URLs (reconciled backend)', () => {
  assert.match(attachmentContext, /NEVER contains[\s\S]*product arrays/i);
  assert.match(attachmentContext, /dressingRoomItemToEvidence/);
  assert.doesNotMatch(attachmentContext, /affiliateUrl|purchaseOptions/);
  assert.match(visualPipeline, /purchaseUrlPresent/);
  assert.match(visualPipeline, /purchaseUrlPresent:\s*(Boolean|!!|Boolean\()/);
});

// ── B. Account-deletion registry (retargeted from legacy deletion script) ───

test('DR-4 collab idempotency ledger is covered by the account-deletion registry', () => {
  assert.match(deletionRegistry, /dressing_room_collab_idempotency/);
  assert.match(deletionRegistry, /dressing_room_participants/);
  assert.match(deletionRegistry, /dressing_room_messages/);
  assert.match(deletionRegistry, /dressing_room_item_reactions/);
});
