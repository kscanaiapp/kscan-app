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

test('contributions migration is additive, scoped, and reuses the canonical membership predicate', () => {
  const migration = fs.readFileSync(
    path.join(ROOT, 'supabase/migrations/20260725100000_shared_room_item_contributions.sql'),
    'utf8',
  );
  assert.doesNotMatch(migration, /\b(drop\s+table|truncate|delete\s+from)\b/i, 'additive only');
  assert.doesNotMatch(migration, /using\s*\(\s*true\s*\)/i, 'no unrestricted USING');
  assert.doesNotMatch(migration, /with\s+check\s*\(\s*true\s*\)/i, 'no unrestricted WITH CHECK');
  assert.match(migration, /add column if not exists created_by uuid references auth\.users\(id\)/);
  assert.match(migration, /alter column created_by set default auth\.uid\(\)/, 'contributor identity is server-derived');
  assert.match(migration, /created_by = \(select auth\.uid\(\)\)/, 'mutations pinned to the authenticated actor');
  const predicateUses = migration.match(/public\.can_access_room_messages\(dressing_room_id\)/g) ?? [];
  assert.ok(predicateUses.length >= 4, 'every policy reuses the deployed participant predicate');
  assert.doesNotMatch(migration, /on public\.dressing_rooms/i, 'room administration untouched');
  assert.doesNotMatch(migration, /shared_room_memberships/i, 'no parallel membership predicate invented');
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
