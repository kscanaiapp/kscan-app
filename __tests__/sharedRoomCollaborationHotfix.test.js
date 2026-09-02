// iOS Shared Room collaboration hotfix — focused regression coverage.
//
// 1. Room Chat / DR-3 reaction idempotency IDs must not depend on browser
//    Web Crypto: Hermes has no global `crypto`, and the previous fallback
//    itself dereferenced `crypto.getRandomValues`, throwing
//    "Property 'crypto' doesn't exist" on every chat send and reaction.
// 2. One capability resolver decides shared-room access presentation, so
//    active recipients are collaborators (chat + reactions are already
//    participant-authorized in production policy) and nothing labels them
//    view-only while mutations are enabled.
// 3. Item contributions stay dark until the local contributions migration
//    is deployed; the migration itself must be additive and owner-safe.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadTsModule(relativePath, requireMap = {}, sandboxExtras = {}) {
  const filename = path.join(ROOT, relativePath);
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const mod = { exports: {} };
  const sandbox = {
    __DEV__: false,
    console,
    exports: mod.exports,
    module: mod,
    Date,
    Math,
    JSON,
    Object,
    Array,
    Error,
    Promise,
    Uint8Array,
    RegExp,
    String,
    Number,
    Boolean,
    ...sandboxExtras,
    require: (id) => {
      if (id in requireMap) return requireMap[id];
      if (id.startsWith('node:')) return require(id);
      throw new Error(`Unexpected require: ${id}`);
    },
  };
  vm.runInNewContext(output, sandbox, { filename });
  return mod.exports;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fakeRandomBytes(byteCount) {
  // Deterministic-but-varied bytes for tests; production uses native entropy.
  const bytes = new Uint8Array(byteCount);
  for (let i = 0; i < byteCount; i += 1) bytes[i] = (i * 37 + 11) % 256;
  return bytes;
}

const collabMocks = (expoCrypto) => ({
  'expo-crypto': expoCrypto,
  './supabaseClient': { supabase: {} },
});

// ── Hermes crypto repair ─────────────────────────────────────────────────────

test('createCollabRequestId works with NO global crypto (Hermes) via expo-crypto randomUUID', () => {
  const collab = loadTsModule(
    'services/dressingRoomCollaboration.ts',
    collabMocks({ randomUUID: () => 'a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5', getRandomBytes: fakeRandomBytes }),
  );
  // The sandbox intentionally has no `crypto` global.
  const id = collab.createCollabRequestId();
  assert.match(id, UUID_V4);
  assert.equal(collab.isUuidV4(id), true);
});

test('createCollabRequestId falls back to expo-crypto secure bytes with correct v4 formatting', () => {
  const collab = loadTsModule(
    'services/dressingRoomCollaboration.ts',
    collabMocks({ getRandomBytes: fakeRandomBytes }),
  );
  const id = collab.createCollabRequestId();
  assert.match(id, UUID_V4, 'version/variant bits must be forced even from raw bytes');
  assert.equal(collab.isUuidV4(id), true);
});

test('createCollabRequestId still prefers a real runtime crypto.randomUUID when present', () => {
  const collab = loadTsModule(
    'services/dressingRoomCollaboration.ts',
    collabMocks({ randomUUID: () => { throw new Error('expo-crypto must not be used when Web Crypto exists'); } }),
    { crypto: { randomUUID: () => 'f0e1d2c3-b4a5-4696-8788-99aabbccddee' } },
  );
  assert.equal(collab.createCollabRequestId(), 'f0e1d2c3-b4a5-4696-8788-99aabbccddee');
});

test('no unguarded global-crypto dereference remains on the collaboration path', () => {
  const source = fs.readFileSync(path.join(ROOT, 'services/dressingRoomCollaboration.ts'), 'utf8');
  const unguarded = source.match(/^\s*crypto\.getRandomValues/m);
  assert.equal(unguarded, null, 'crypto.getRandomValues must not be called outside the typeof guard');
  assert.match(source, /import \* as ExpoCrypto from 'expo-crypto';/);
});

test('Room Chat retains one request id across a recoverable retry of the same logical draft', () => {
  const panel = fs.readFileSync(
    path.join(ROOT, 'components/rooms/RoomMessagesPanel.tsx'),
    'utf8',
  );
  assert.match(panel, /pendingSendRef/);
  assert.match(panel, /pending\?\.logicalKey === logicalKey[\s\S]*pending\.clientMessageId/);
  // The send now captures the room and the draft before showing an optimistic
  // row, so it posts sendRoomId/previousDraft rather than reading the live
  // props mid-flight. The idempotency property this test guards is unchanged
  // and slightly stronger: a recoverable failure restores previousDraft, so the
  // retry recomputes the same logicalKey and reuses the same clientMessageId.
  assert.match(panel, /sendRoomMessage\(sendRoomId, previousDraft, \{[\s\S]*clientMessageId/);
  assert.match(panel, /pendingSendRef\.current = null/);
});

// ── Capability resolver ──────────────────────────────────────────────────────

function loadCapabilities(flags) {
  return loadTsModule('services/sharedRoomCapabilities.ts', {
    '../constants/featureFlags': {
      ROOM_CHAT_ENABLED: false,
      DRESSING_ROOM_COLLABORATION_V1: false,
      DRESSING_ROOM_REACTIONS_V1: false,
      ELISE_SHARED_ROOM_EVIDENCE_V1: false,
      SHARED_ROOM_CONTRIBUTIONS_V1: false,
      ...flags,
    },
    './sharedRoomMemberships': {},
  });
}

const PROD_FLAGS = {
  ROOM_CHAT_ENABLED: true,
  DRESSING_ROOM_COLLABORATION_V1: true,
  DRESSING_ROOM_REACTIONS_V1: true,
  ELISE_SHARED_ROOM_EVIDENCE_V1: true,
};

test('active recipient under production flags is a collaborator (chat + reactions, no admin)', () => {
  const caps = loadCapabilities(PROD_FLAGS);
  const input = { isAuthenticated: true, isOwner: false, availability: 'available' };
  const resolved = caps.resolveSharedRoomCapabilities(input);
  assert.equal(resolved.canView, true);
  assert.equal(resolved.canChat, true, 'participant chat INSERT policy is deployed');
  assert.equal(resolved.canReact, true, 'participant reaction policies are deployed');
  assert.equal(resolved.canUseEliseEvidence, true);
  assert.equal(resolved.canAddItems, false, 'contributions stay dark until the migration deploys');
  assert.equal(resolved.canEditOwnItems, false);
  assert.equal(resolved.canRemoveOwnItems, false);
  assert.equal(resolved.canRenameRoom, false, 'admin stays owner-only');
  assert.equal(resolved.canManageMembers, false);
  assert.equal(resolved.canDeleteRoom, false);
  assert.equal(caps.sharedRoomAccessRole(input), 'collaborator');
  assert.equal(caps.sharedRoomStatusLabel(input), 'Shared · Collaborator');
  assert.equal(caps.sharedRoomAccessA11y(input), 'shared, collaborator');
});

test('recipient with all collaboration flags off is an honest viewer', () => {
  const caps = loadCapabilities({});
  const input = { isAuthenticated: true, isOwner: false, availability: 'available' };
  const resolved = caps.resolveSharedRoomCapabilities(input);
  assert.equal(resolved.canView, true);
  assert.equal(resolved.canChat, false);
  assert.equal(resolved.canReact, false);
  assert.equal(caps.sharedRoomAccessRole(input), 'viewer');
  assert.equal(caps.sharedRoomStatusLabel(input), 'Shared · View only');
  assert.equal(caps.sharedRoomAccessA11y(input), 'shared, view only');
});

test('unavailable, unauthenticated, and empty-availability states resolve safely', () => {
  const caps = loadCapabilities(PROD_FLAGS);
  const unavailable = { isAuthenticated: true, isOwner: false, availability: 'unavailable' };
  assert.deepEqual(
    Object.values(caps.resolveSharedRoomCapabilities(unavailable)),
    Array(10).fill(false),
    'unavailable rooms expose zero capabilities',
  );
  assert.equal(caps.sharedRoomAccessRole(unavailable), 'unavailable');
  assert.equal(caps.sharedRoomStatusLabel(unavailable), 'Shared · Unavailable');

  const signedOut = { isAuthenticated: false, isOwner: false, availability: 'available' };
  assert.equal(caps.resolveSharedRoomCapabilities(signedOut).canChat, false);
  assert.equal(caps.resolveSharedRoomCapabilities(signedOut).canView, false);

  const empty = { isAuthenticated: true, isOwner: false, availability: 'empty' };
  assert.equal(caps.resolveSharedRoomCapabilities(empty).canChat, true, 'empty rooms are still active');
});

test('owner keeps administrative capabilities; recipients never gain them', () => {
  const caps = loadCapabilities(PROD_FLAGS);
  const owner = caps.resolveSharedRoomCapabilities({ isAuthenticated: true, isOwner: true, availability: 'available' });
  assert.equal(owner.canRenameRoom, true);
  assert.equal(owner.canManageMembers, true);
  assert.equal(owner.canDeleteRoom, true);
  assert.equal(owner.canAddItems, true);
  assert.equal(caps.sharedRoomAccessRole({ isAuthenticated: true, isOwner: true, availability: 'available' }), 'owner');
});

test('contributions flag alone enables item capabilities and collaborator status', () => {
  const caps = loadCapabilities({ SHARED_ROOM_CONTRIBUTIONS_V1: true });
  const input = { isAuthenticated: true, isOwner: false, availability: 'available' };
  const resolved = caps.resolveSharedRoomCapabilities(input);
  assert.equal(resolved.canAddItems, true);
  assert.equal(resolved.canEditOwnItems, true);
  assert.equal(resolved.canRemoveOwnItems, true);
  assert.equal(caps.sharedRoomAccessRole(input), 'collaborator');
});

// ── Contributions migration (local, additive, owner-safe) ────────────────────

// The contributions migration lives in supabase/migrations-deferred/: it is
// deliberately excluded from the staging parity baseline because it drops and
// recreates three RLS policies production already defines differently (see that
// directory's README). These three guards kept reading the old
// supabase/migrations/ path and had been throwing ENOENT ever since the move, so
// the predicate behind the LIVE production contribution policies had no working
// repo gate at all. Deferred is where the file is; deferred is where they read it.
test('contributions migration uses a current room-scoped participant/share predicate', () => {
  const migration = fs.readFileSync(
    path.join(ROOT, 'supabase/migrations-deferred/20260725100000_shared_room_item_contributions.sql'),
    'utf8',
  );
  assert.doesNotMatch(migration, /\b(drop\s+table|truncate|delete\s+from)\b/i, 'additive only');
  assert.doesNotMatch(migration, /using\s*\(\s*true\s*\)/i, 'no unrestricted USING');
  assert.doesNotMatch(migration, /with\s+check\s*\(\s*true\s*\)/i, 'no unrestricted WITH CHECK');
  assert.match(migration, /add column if not exists created_by uuid[\s\S]*references auth\.users\(id\) on delete cascade/);
  assert.match(migration, /alter column created_by set default auth\.uid\(\)/, 'contributor identity is server-derived');
  assert.match(migration, /alter column created_by set not null/);
  assert.match(migration, /created_by = \(select auth\.uid\(\)\)/, 'mutations pinned to the authenticated actor');
  const predicateUses = migration.match(/public\.can_contribute_to_dressing_room\(dressing_room_id\)/g) ?? [];
  assert.ok(predicateUses.length >= 4, 'every contribution policy uses the current-access predicate');
  assert.doesNotMatch(migration, /public\.can_access_room_messages\(dressing_room_id\)/);
  assert.match(migration, /drp\.joined_via_share_id/);
  assert.match(migration, /rs\.room_id = p_room_id/);
  assert.match(migration, /rs\.is_active = true/);
  assert.match(migration, /rs\.revoked_at is null/);
  assert.match(migration, /rs\.expires_at is null or rs\.expires_at > now\(\)/);
  assert.match(migration, /set search_path = ''/);
  assert.match(migration, /revoke all on function public\.can_contribute_to_dressing_room\(uuid\) from public/);
});

test('contribution UPDATE cannot reassign contributor identity or move an item between rooms', () => {
  const migration = fs.readFileSync(
    path.join(ROOT, 'supabase/migrations-deferred/20260725100000_shared_room_item_contributions.sql'),
    'utf8',
  );
  assert.match(migration, /before update of created_by, dressing_room_id/);
  assert.match(migration, /new\.created_by is distinct from old\.created_by/);
  assert.match(migration, /new\.dressing_room_id is distinct from old\.dressing_room_id/);
  assert.match(migration, /revoke all on function public\.guard_dressing_room_item_contribution_identity\(\)[\s\S]*from public, anon, authenticated/);
  assert.match(migration, /for update[\s\S]*using \([\s\S]*created_by = \(select auth\.uid\(\)\)[\s\S]*with check \([\s\S]*created_by = \(select auth\.uid\(\)\)/);
});

test('contribution DELETE remains own-item-only while existing owner policies are untouched', () => {
  const migration = fs.readFileSync(
    path.join(ROOT, 'supabase/migrations-deferred/20260725100000_shared_room_item_contributions.sql'),
    'utf8',
  );
  assert.match(migration, /for delete[\s\S]*created_by = \(select auth\.uid\(\)\)[\s\S]*can_contribute_to_dressing_room/);
  assert.doesNotMatch(migration, /drop policy if exists "Users can (insert|update|delete) own dressing room items"/);
  const grants = fs.readFileSync(
    path.join(ROOT, 'supabase/migrations/202606180001_fix_staging_grants_saved_scans_soft_delete.sql'),
    'utf8',
  );
  assert.match(grants, /grant select, insert, update, delete on table[\s\S]*public\.dressing_room_items[\s\S]*to authenticated/);
});

test('Shared-With-Me route upgrades only collaborator-mode authenticated sessions and consumes capabilities', () => {
  const listLogic = fs.readFileSync(path.join(ROOT, 'services/sharedWithMeListLogic.ts'), 'utf8');
  const route = fs.readFileSync(path.join(ROOT, 'app/(public)/rooms/[token].tsx'), 'utf8');
  assert.match(listLogic, /\/rooms\/\$\{encodeURIComponent\(normalizedToken\)\}\?mode=collaborator/);
  assert.match(route, /mode === 'collaborator' && Platform\.OS !== 'web'/);
  assert.match(route, /resolveSharedRoomCapabilities\(\{/);
  assert.match(route, /canChat=\{capabilities\.canChat\}/);
  assert.match(route, /autoJoin=\{collaboratorMode\}/);
  assert.match(route, /capabilities\.canReact && joinedRoomId/);
  assert.match(route, /setJoinedRoomId\(null\)[\s\S]*\[user\?\.id\]/);
});

test('public preview cannot receive collaborator controls from a query mode alone', () => {
  const route = fs.readFileSync(path.join(ROOT, 'app/(public)/rooms/[token].tsx'), 'utf8');
  assert.match(route, /resolveSharedRoomCapabilities\(\{[\s\S]*isAuthenticated/);
  assert.match(route, /if \(!canChat \|\| !isAuthenticated\)/);
  assert.match(route, /autoJoin && canChat && isAuthenticated && !roomId/);
});

test('client contributions gate defaults OFF and is absent from the production profile', () => {
  const flags = fs.readFileSync(path.join(ROOT, 'constants/featureFlags.ts'), 'utf8');
  assert.match(flags, /SHARED_ROOM_CONTRIBUTIONS_V1 =\s*\n?\s*process\.env\.EXPO_PUBLIC_SHARED_ROOM_CONTRIBUTIONS_V1 === 'true'/);
  const eas = JSON.parse(fs.readFileSync(path.join(ROOT, 'eas.json'), 'utf8'));
  for (const profile of Object.values(eas.build ?? {})) {
    assert.equal(
      (profile.env ?? {}).EXPO_PUBLIC_SHARED_ROOM_CONTRIBUTIONS_V1,
      undefined,
      'flag must stay unset until the migration is deployed',
    );
  }
});
