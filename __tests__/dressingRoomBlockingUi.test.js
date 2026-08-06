/**
 * Dressing Room blocking — client repair coverage.
 *
 * Every test here pins a defect found in the blocking hostile audit. Each one
 * fails against the pre-repair source, so they are regression guards rather
 * than restatements of the implementation:
 *
 *   1. isOwner / roomOwnerId were hardcoded on the room detail screen.
 *   2. Block and Report user had no single-flight guard.
 *   3. canMessage was parsed but had no consumer.
 *   4. Access revalidation was gated on a flag set in no EAS profile.
 *   5. Report & Hide removed the only route to blocking that sender.
 *   6. Block required the target to have sent a message.
 *   7. Android lacked the iOS send-idempotency guard.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const ROOT = path.join(__dirname, '..');

function readSource(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function loadTsModule(relativePath, overrides = {}) {
  const source = readSource(relativePath);
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
      return { supabase: overrides.supabase ?? {} };
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

const panel = readSource('components/rooms/RoomMessagesPanel.tsx');
const roomDetail = readSource('app/dressing-rooms/[id].tsx');
const privacy = readSource('app/privacy.tsx');
const collabSource = readSource('services/dressingRoomCollaboration.ts');

// ── 1. Owner identity and consequence copy ───────────────────────────────

test('blocking UI: room detail never hardcodes owner state for the chat panel', () => {
  // The pre-repair source read: <RoomMessagesPanel roomId={roomId} isOwner roomOwnerId={user?.id ?? null} />
  assert.doesNotMatch(
    roomDetail,
    /<RoomMessagesPanel[^>]*\sisOwner\s*(\/?>|[a-zA-Z])/,
    'isOwner must be an explicit expression, never a bare always-true prop',
  );
  assert.doesNotMatch(
    roomDetail,
    /roomOwnerId=\{user\?\.id/,
    'roomOwnerId must be the ROOM owner, never the current viewer',
  );
});

test('blocking UI: owner state is derived from authoritative room data', () => {
  const mount = roomDetail.slice(roomDetail.indexOf('<RoomMessagesPanel'));
  const element = mount.slice(0, mount.indexOf('/>') + 2);
  assert.match(element, /isOwner=\{Boolean\([^}]*room\?\.userId[^}]*\)\}/);
  assert.match(element, /roomOwnerId=\{room\?\.userId \?\? null\}/);
});

test('blocking UI: consequence copy distinguishes owner, owner-target, and peer cases', () => {
  // Three distinct outcomes must remain reachable, keyed on the real
  // relationship rather than a constant.
  assert.match(panel, /const body = isOwner/);
  assert.match(panel, /targetIsRoomOwner/);
  assert.match(panel, /They will no longer be able to access shared Dressing Rooms with you/);
  assert.match(panel, /You will leave this shared Dressing Room and will no longer receive/);
});

// ── 2. Single-flight guards ──────────────────────────────────────────────

test('blocking UI: block and report-user are single-flight guarded by refs', () => {
  assert.match(panel, /blockInFlightRef = useRef\(false\)/);
  assert.match(panel, /reportUserInFlightRef = useRef\(false\)/);
  assert.match(panel, /if \(blockInFlightRef\.current\) return;/);
  assert.match(panel, /if \(reportUserInFlightRef\.current\) return;/);
});

test('blocking UI: guards release on cancel and on dialog dismiss, not only on success', () => {
  // A guard that only released in the success path would permanently disable
  // the control after one cancel.
  const cancels = panel.match(/text: 'Cancel', style: 'cancel', onPress: release/g) ?? [];
  assert.ok(cancels.length >= 2, 'block and report-user Cancel must both release');
  const dismisses = panel.match(/\{ onDismiss: release \}/g) ?? [];
  assert.ok(dismisses.length >= 2, 'block and report-user must release on dismiss');
  assert.match(panel, /finally \{\s*release\(\);/);
});

test('blocking UI: destructive controls expose a disabled/busy state while in flight', () => {
  assert.match(panel, /disabled=\{blocking\}/);
  assert.match(panel, /disabled=\{reportingUser\}/);
  assert.match(panel, /accessibilityState=\{\{ disabled: blocking, busy: blocking \}\}/);
});

test('blocking UI: unblock is ref-guarded and releases on cancel', () => {
  assert.match(privacy, /unblockInFlightRef = useRef\(false\)/);
  assert.match(privacy, /if \(unblockInFlightRef\.current\) return;/);
  assert.match(privacy, /text: 'Cancel', style: 'cancel', onPress: release/);
});

test('blocking UI: blocked-users list failure is recoverable without leaving the screen', () => {
  assert.match(privacy, /privacy-blocked-users-retry/);
  assert.match(privacy, /onRetry/);
});

// ── 3. canMessage is authoritative ───────────────────────────────────────

test('blocking UI: canMessage has a real consumer gating the composer', () => {
  assert.match(panel, /const composerEnabled = !accessRevoked && canMessage;/);
  assert.match(panel, /const canSend = !sending && composerEnabled/);
  assert.match(panel, /editable=\{!sending && composerEnabled\}/);
  assert.match(panel, /accessibilityState=\{\{ disabled: !composerEnabled \}\}/);
});

test('blocking UI: a denied send reports unavailability, not a generic retry', () => {
  assert.match(panel, /if \(!access\.canMessage\) \{\s*setSendError\(ROOM_MESSAGES_MESSAGING_UNAVAILABLE\);/);
  assert.match(panel, /room-messages-unavailable-notice/);
});

test('blocking UI: send revalidates before the write and honours the fresh answer', () => {
  const send = panel.slice(panel.indexOf('const handleSend'));
  const body = send.slice(0, send.indexOf('\n  };'));
  assert.match(body, /const access = await revalidateAccess\(\);/);
  assert.ok(
    body.indexOf('await revalidateAccess()') < body.indexOf('await sendRoomMessage('),
    'revalidation must precede the send RPC',
  );
});

test('collaboration access parser never fabricates capabilities', () => {
  const collab = loadTsModule('services/dressingRoomCollaboration.ts');
  const denied = collab.parseCollaborationAccess({
    ok: true,
    roomId: 'r1',
    authenticatedActorId: 'a1',
    currentOwnerId: 'o1',
    relationship: 'owner',
    canMessage: false,
    canReact: false,
    canReply: false,
    accessVersion: 7,
  });
  assert.equal(denied.ok, true);
  assert.equal(denied.canMessage, false, 'canMessage:false must survive parsing');
  assert.equal(denied.canReply, false);

  // A backend that omits the field must not be read as permission.
  const missing = collab.parseCollaborationAccess({
    ok: true,
    roomId: 'r1',
    authenticatedActorId: 'a1',
    currentOwnerId: 'o1',
    relationship: 'owner',
    accessVersion: 7,
  });
  assert.equal(missing.canMessage, false);
});

// ── 4. Access revalidation is not flag-gated ─────────────────────────────

test('blocking UI: access revalidation does not depend on the realtime-sync flag', () => {
  // Pre-repair this was `if (!syncEnabled() || !roomId || accessRevoked) return;`
  // with DRESSING_ROOM_REALTIME_SYNC_V1 unset in every EAS profile.
  assert.doesNotMatch(panel, /function syncEnabled\(\)/);
  assert.match(panel, /function messageSyncEnabled\(\)/);
  // Anchor on the CALL SITE, not the import of the same identifier.
  const callSite = panel.indexOf('startCollaborationBoundedRefresh({');
  assert.ok(callSite > 0, 'bounded refresh must still be wired');
  const effect = panel.slice(callSite);
  const guard = panel.slice(panel.lastIndexOf('useEffect(() => {', callSite), callSite);
  assert.doesNotMatch(
    guard,
    /messageSyncEnabled\(\)\s*\|\|/,
    'the effect must not bail out when message sync is disabled',
  );
  assert.match(guard, /if \(!roomId \|\| accessRevoked\) return;/);
  assert.ok(effect.includes('onAccessLost: applyAccessRevoked'));
});

test('blocking UI: foreground resume and screen focus both revalidate unconditionally', () => {
  const appState = panel.slice(panel.indexOf("AppState.addEventListener('change'"));
  const appStateBody = appState.slice(0, appState.indexOf('});'));
  assert.match(appStateBody, /void revalidateAccess\(\)/);
  assert.doesNotMatch(appStateBody, /syncEnabled|messageSyncEnabled/);
  assert.match(panel, /useFocusEffect\(/);
});

test('blocking UI: revoked access clears protected state and shows neutral copy', () => {
  const applied = panel.slice(panel.indexOf('const applyAccessRevoked'));
  const body = applied.slice(0, applied.indexOf('}, [clearInteractiveState]);'));
  assert.match(body, /setAccessRevoked\(true\)/);
  assert.match(body, /setCanMessage\(false\)/);
  assert.match(body, /setCounterparties\(\[\]\)/);
  assert.match(body, /clearInteractiveState\(\)/);
  assert.match(body, /setLoadError\(ROOM_MESSAGES_ACCESS_ERROR\)/);
});

test('blocking UI: polling cadence stays bounded, not high frequency', () => {
  const match = panel.match(/ACCESS_REVALIDATE_MS = ([0-9_]+)/);
  assert.ok(match, 'an explicit access revalidation cadence must be declared');
  const ms = Number(match[1].replace(/_/g, ''));
  assert.ok(ms >= 15_000, `access revalidation must not poll faster than 15s (got ${ms}ms)`);
});

// ── 5 + 6. Block reachable without a visible message ─────────────────────

test('blocking UI: hidden senders keep a reachable Block control', () => {
  assert.match(panel, /function HiddenSenderRow\(/);
  assert.match(panel, /room-hidden-sender-block-/);
  // Hiding must no longer be able to empty the surface entirely.
  assert.match(panel, /hiddenSenderIds/);
  assert.match(panel, /visibleMessages\.length === 0 && hiddenSenderIds\.length === 0/);
});

test('blocking UI: a message-independent safety roster exists', () => {
  assert.match(panel, /room-safety-controls/);
  assert.match(panel, /room-safety-block-/);
  assert.match(panel, /listBlockableCounterparties/);
  assert.match(panel, /SAFETY_SECTION_TITLE/);
});

test('blocking UI: every block entry point shares one guarded implementation', () => {
  assert.match(panel, /const blockUserById = useCallback\(/);
  // Three distinct entry points must funnel through it: a message row, a
  // hidden sender row, and the message-independent safety roster.
  const callers = panel.match(/blockUserById\(/g) ?? [];
  assert.ok(
    callers.length >= 3,
    `expected every block entry point to reuse blockUserById (found ${callers.length})`,
  );
  assert.match(panel, /blockUserById\(message\.senderId/);
  assert.match(panel, /onBlock=\{\(target\) => blockUserById\(target/);
  assert.match(panel, /blockUserById\(counterparty\.userId/);
});

test('counterparty roster excludes self and departed participants, and respects RLS', async () => {
  const rows = [
    { user_id: 'self-user', left_at: null },
    { user_id: 'peer-active', left_at: null },
    { user_id: 'peer-departed', left_at: '2026-08-06T00:00:00Z' },
    { user_id: 'owner-user', left_at: null },
  ];
  const supabase = {
    from: () => ({
      select: () => ({
        eq: async () => ({ data: rows, error: null }),
      }),
    }),
  };
  const collab = loadTsModule('services/dressingRoomCollaboration.ts', { supabase });

  const result = await collab.listBlockableCounterparties({
    roomId: 'room-1',
    currentUserId: 'self-user',
    roomOwnerId: 'owner-user',
  });
  const ids = result.map((entry) => entry.userId);

  assert.ok(!ids.includes('self-user'), 'self must never be offered as a block target');
  assert.ok(!ids.includes('peer-departed'), 'departed participants are not blockable here');
  assert.ok(ids.includes('peer-active'));
  assert.ok(ids.includes('owner-user'));
  assert.equal(
    result.find((entry) => entry.userId === 'owner-user').isRoomOwner,
    true,
    'owner must be flagged so the correct consequence copy is chosen',
  );
  assert.equal(new Set(ids).size, ids.length, 'no duplicate counterparties');
});

test('counterparty roster still offers the owner when participant enumeration is denied', async () => {
  // A participant may read only their own row; RLS returning an error or an
  // empty set must not strip the one counterparty they can identify.
  const supabase = {
    from: () => ({
      select: () => ({
        eq: async () => ({ data: null, error: { code: '42501' } }),
      }),
    }),
  };
  const collab = loadTsModule('services/dressingRoomCollaboration.ts', { supabase });
  const result = await collab.listBlockableCounterparties({
    roomId: 'room-1',
    currentUserId: 'participant-user',
    roomOwnerId: 'owner-user',
  });
  assert.deepEqual(result, [{ userId: 'owner-user', isRoomOwner: true }]);
});

test('counterparty roster returns nothing without a signed-in actor', async () => {
  const collab = loadTsModule('services/dressingRoomCollaboration.ts');
  const result = await collab.listBlockableCounterparties({
    roomId: 'room-1',
    currentUserId: null,
    roomOwnerId: 'owner-user',
  });
  assert.deepEqual(result, []);
});

test('counterparty roster never offers a self-block when the viewer owns the room', async () => {
  const supabase = {
    from: () => ({
      select: () => ({ eq: async () => ({ data: [], error: null }) }),
    }),
  };
  const collab = loadTsModule('services/dressingRoomCollaboration.ts', { supabase });
  const result = await collab.listBlockableCounterparties({
    roomId: 'room-1',
    currentUserId: 'owner-user',
    roomOwnerId: 'owner-user',
  });
  assert.deepEqual(result, [], 'an owner with no participants has nobody to block');
});

// ── 7. Android/iOS lifecycle + idempotency parity ────────────────────────

test('blocking UI: send reuses one idempotency key across retries of a draft', () => {
  assert.match(panel, /pendingSendRef = useRef</);
  assert.match(panel, /logicalKey/);
  assert.match(panel, /pending\?\.logicalKey === logicalKey/);
  assert.match(panel, /clientMessageId,/);
});

test('blocking UI: the idempotency key separator is an escape, never a raw NUL byte', () => {
  // A literal NUL in source makes the file binary to grep/diff tooling.
  assert.ok(!panel.includes('\u0000'), 'source must not contain a raw NUL byte');
  assert.match(panel, /\$\{normalizedDraft\}\\u0000\$\{parentMessageId/);
});

test('blocking UI: async work is unmount-guarded', () => {
  assert.match(panel, /mountedRef = useRef\(true\)/);
  assert.match(panel, /mountedRef\.current = false;/);
  const guards = panel.match(/mountedRef\.current/g) ?? [];
  assert.ok(guards.length >= 8, `expected pervasive unmount guards (found ${guards.length})`);
});

// ── Neutral copy ─────────────────────────────────────────────────────────

/** Source with comments removed, so prose about the design is not mistaken
 *  for user-visible copy. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
}

test('blocking UI: no user-visible string discloses a block or its direction', () => {
  const files = { panel, privacy, roomDetail, collabSource };
  for (const [name, source] of Object.entries(files)) {
    const code = stripComments(source);
    for (const forbidden of [/blocked you/i, /has blocked/i, /you were blocked/i, /they blocked/i]) {
      assert.doesNotMatch(
        code,
        forbidden,
        `${name} must never disclose block direction in user-visible copy`,
      );
    }
  }
});

test('blocking UI: access denial copy is neutral and does not assert a state change', () => {
  const collab = loadTsModule('services/dressingRoomCollaboration.ts');
  assert.equal(collab.COLLAB_ACCESS_ERROR, 'This Dressing Room is no longer available.');
  // The classifier must still recognise the neutral wording, or access loss
  // would silently stop being detected.
  assert.equal(collab.isCollaborationAccessError(collab.COLLAB_ACCESS_ERROR), true);
  assert.equal(
    collab.isCollaborationAccessError('You no longer have access to this room.'),
    true,
    'historical wording must still classify',
  );
});

// ── Adjacent: the reactions raw-table fallback ───────────────────────────
// Recorded as a non-blocking follow-up rather than repaired in this pass.
// It is unreachable in production, and blocking is still enforced on it by
// RLS. These tests pin both of those facts so the conclusion cannot rot.

test('reactions: shipping profiles take the RPC path, not the raw-table fallback', () => {
  const eas = JSON.parse(readSource('eas.json'));
  // The Android line also ships a `staging` profile; the iOS line does not.
  // Check whichever shipping profiles this platform actually defines.
  const shipping = ['production', 'staging'].filter((name) => eas.build?.[name]);
  assert.ok(shipping.includes('production'), 'a production build profile must exist');

  for (const profile of shipping) {
    const env = eas.build[profile].env ?? {};
    assert.equal(
      env.EXPO_PUBLIC_DRESSING_ROOM_COLLABORATION_V1,
      'true',
      `${profile} must keep collaboration enabled or reactions fall back to a raw table write`,
    );
    assert.equal(
      env.EXPO_PUBLIC_DRESSING_ROOM_REACTIONS_V1,
      'true',
      `${profile} must keep reactions enabled or reactions fall back to a raw table write`,
    );
  }
});

test('reactions: the raw-table path is still block-enforced by RLS', () => {
  // Defense in depth: even where the fallback is reachable (preview/dev), the
  // reaction policies evaluate can_access_room_messages, which the blocking
  // migration rewrote to include the bidirectional pair check.
  const reactionRls = readSource(
    'supabase/migrations/202606240002_dressing_room_item_reactions_participant_rls.sql',
  );
  assert.match(reactionRls, /can_access_room_messages/);
  const blocking = readSource(
    'supabase/migrations/20260806153233_dressing_room_user_blocking.sql',
  );
  const fn = blocking.slice(blocking.indexOf('function public.can_access_room_messages'));
  const body = fn.slice(0, fn.indexOf('$function$;'));
  assert.match(body, /is_dressing_room_pair_blocked/);
});

// ── Migration self-containment ───────────────────────────────────────────

test('blocking migration creates the internal schema it depends on', () => {
  // Found by replaying the repo migration set into an empty database:
  // the migration defines internal.* helpers but no migration in this repo
  // ever creates the `internal` schema (it is created by
  // 20260804090000_edge_function_errors, which exists only on the hosted
  // databases). Applying to any environment built from this repo failed with
  // `schema "internal" does not exist` (SQLSTATE 3F000).
  const blocking = readSource(
    'supabase/migrations/20260806153233_dressing_room_user_blocking.sql',
  );
  assert.match(blocking, /create schema if not exists internal;/);

  const createsAt = blocking.indexOf('create schema if not exists internal;');
  const firstUse = blocking.search(/create or replace function internal\./);
  assert.ok(firstUse > -1, 'the migration should define internal helpers');
  assert.ok(
    createsAt < firstUse,
    'the schema must be created before the first internal.* object',
  );
});

test('blocking migration grants schema USAGE so RLS predicates can run', () => {
  // EXECUTE on the function is not sufficient. The RLS policies reference
  // internal.is_dressing_room_pair_blocked and predicates evaluate as the
  // QUERYING role, so authenticated also needs USAGE on the schema or an
  // ordinary read fails with "permission denied for schema internal".
  const blocking = readSource(
    'supabase/migrations/20260806153233_dressing_room_user_blocking.sql',
  );
  assert.match(blocking, /grant usage on schema internal to authenticated;/);
  assert.match(blocking, /revoke all on schema internal from public;/);
  assert.match(blocking, /revoke all on schema internal from anon;/);
});

test('no repo migration other than the blocking one assumes the internal schema', () => {
  // If another migration starts using internal.* it must create it too, or we
  // are back to an unreplayable set.
  const dir = path.join(ROOT, 'supabase/migrations');
  const offenders = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql'))) {
    if (file === '20260806153233_dressing_room_user_blocking.sql') continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    if (/\binternal\.[a-z_]/i.test(sql) && !/create schema if not exists internal/i.test(sql)) {
      offenders.push(file);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `these migrations use the internal schema without creating it: ${offenders.join(', ')}`,
  );
});

// ── pgTAP plan integrity ─────────────────────────────────────────────────

test('pgTAP blocking suite declares a plan matching its assertion count', () => {
  const sql = readSource('supabase/tests/dressing_room_user_blocking_test.sql');
  const planMatch = sql.match(/select plan\((\d+)\);/);
  assert.ok(planMatch, 'the suite must declare a plan');
  const planned = Number(planMatch[1]);
  const assertions = (
    sql.match(/^\s*select (ok|is|isnt|throws_ok|lives_ok|throws_matching|matches)\(/gm) ?? []
  ).length;
  assert.equal(
    planned,
    assertions,
    `plan(${planned}) does not match ${assertions} assertions — pgTAP reports this as a plan mismatch, not a failure`,
  );
});
