// Outfit decision (room voting) contract tests (AI Stylist expansion).
// Static contract checks over migration source, services, UI, and the
// account-deletion processor.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const migration = fs.readFileSync(
  path.join(ROOT, 'supabase', 'migrations', '20260711000002_outfit_decision_rooms.sql'),
  'utf8',
);
const auditMigrationFile = fs.readdirSync(path.join(ROOT, 'supabase', 'migrations'))
  .find((file) => file.endsWith('_audit_hardening_ai_stylist_stylechat.sql'));
assert.ok(auditMigrationFile, 'audit hardening migration missing');
const auditMigration = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', auditMigrationFile), 'utf8');
const rolePrivilegeMigrationFile = fs.readdirSync(path.join(ROOT, 'supabase', 'migrations'))
  .find((file) => file.endsWith('_harden_app_role_privileges.sql'));
assert.ok(rolePrivilegeMigrationFile, 'role privilege hardening migration missing');
const rolePrivilegeMigration = fs.readFileSync(
  path.join(ROOT, 'supabase', 'migrations', rolePrivilegeMigrationFile),
  'utf8',
);
const roomShareRemediationMigrationFile = fs.readdirSync(path.join(ROOT, 'supabase', 'migrations'))
  .find((file) => file.endsWith('_room_share_redemption_contract_remediation.sql'));
assert.ok(roomShareRemediationMigrationFile, 'room-share redemption remediation migration missing');
const roomShareRemediationMigration = fs.readFileSync(
  path.join(ROOT, 'supabase', 'migrations', roomShareRemediationMigrationFile),
  'utf8',
);
const service = fs.readFileSync(path.join(ROOT, 'services', 'outfitDecisions.ts'), 'utf8');
const section = fs.readFileSync(
  path.join(ROOT, 'components', 'dressing-rooms', 'OutfitDecisionSection.tsx'),
  'utf8',
);
const publicScreen = fs.readFileSync(
  path.join(ROOT, 'app', '(public)', 'rooms', '[token].tsx'),
  'utf8',
);
const ownerScreen = fs.readFileSync(
  path.join(ROOT, 'app', 'dressing-rooms', '[id].tsx'),
  'utf8',
);
const deletionScript = fs.readFileSync(
  path.join(ROOT, 'scripts', 'process-deletion-request.js'),
  'utf8',
);

test('share flow supports one Look and multiple (2-3) options in one decision group', () => {
  assert.match(migration, /look_count < 1 or look_count > 3/);
  assert.match(migration, /share_looks_to_outfit_decision/);
  assert.match(service, /lookIds\.length < 1 \|\| input\.lookIds\.length > 3/);
  // Duplicate Looks inside one share are rejected.
  assert.match(migration, /Duplicate Looks are not allowed/);
});

test('only the room owner can share a decision', () => {
  assert.match(migration, /dr\.user_id = current_user_id[\s\S]*?Dressing room not found/);
});

test('snapshots are immutable: no client write policies, writes flow through RPCs only', () => {
  for (const table of [
    'outfit_decision_groups',
    'outfit_decision_options',
    'outfit_decision_option_items',
    'outfit_decision_votes',
  ]) {
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`));
    // SELECT-only grants; no insert/update/delete grants or policies.
    assert.doesNotMatch(migration, new RegExp(`grant (insert|update|delete)[^;]*on public\\.${table}`));
    assert.doesNotMatch(migration, new RegExp(`create policy [^;]*on public\\.${table}\\s*for (insert|update|delete)`, 'i'));
  }
  // Option snapshots copy look_items at share time; source edits never rewrite them.
  assert.match(migration, /li\.snapshot_payload/);
});

test('one vote per participant per group with atomic vote change', () => {
  assert.match(migration, /constraint outfit_decision_votes_group_user_key unique \(group_id, user_id\)/);
  assert.match(migration, /on conflict \(group_id, user_id\)\s*\n?\s*do update set option_id = excluded\.option_id/);
});

test('composite FK guarantees the voted option belongs to the same group', () => {
  assert.match(migration, /constraint outfit_decision_options_id_group_key unique \(id, group_id\)/);
  assert.match(migration, /foreign key \(option_id, group_id\)\s*\n?\s*references public\.outfit_decision_options \(id, group_id\)/);
  // Chosen winner also constrained to the same group.
  assert.match(migration, /foreign key \(chosen_option_id, id\)\s*\n?\s*references public\.outfit_decision_options \(id, group_id\)/);
});

test('aggregate counts come from a definer RPC; voter identities are never enumerated', () => {
  assert.match(migration, /get_outfit_decision_vote_counts/);
  assert.match(migration, /count\(v\.id\)::bigint/);
  // Vote SELECT policy: own row only.
  assert.match(migration, /"Users can read own outfit decision votes"[\s\S]*?using \(user_id = auth\.uid\(\)\)/);
});

test('reactions remain a separate system from votes', () => {
  // The migration never alters, drops, or repoints the reactions table
  // (a comment documenting the separation is expected and allowed).
  assert.doesNotMatch(migration, /(alter table|drop (table|policy)|create policy)[^;]*dressing_room_item_reactions/i);
  assert.doesNotMatch(migration, /insert into public\.dressing_room_item_reactions/);
  assert.doesNotMatch(service, /reaction_type|setItemReaction/);
  assert.doesNotMatch(section, /setItemReaction|ItemReactions/);
});

test('owner-only winner selection and wearing state, enforced server-side', () => {
  assert.match(migration, /set_outfit_decision_state/);
  assert.match(migration, /join public\.dressing_rooms dr on dr\.id = g\.dressing_room_id\s*\n?\s*where g\.id = p_group_id\s*\n?\s*and dr\.user_id = current_user_id/);
  assert.match(migration, /Only the room owner can decide/);
  assert.match(migration, /'choose_winner'/);
  assert.match(migration, /'confirm_wearing'/);
  // Wearing requires a chosen option first.
  assert.match(migration, /Choose an option first/);
  // UI hides owner controls from participants but the server is authoritative.
  assert.match(section, /role === 'owner'/);
});

test('voting requires room access and an open decision; closed decisions reject votes', () => {
  assert.match(migration, /cast_outfit_decision_vote/);
  assert.match(migration, /can_access_room_messages\(group_row\.dressing_room_id\)/);
  assert.match(migration, /group_row\.status <> 'open'/);
  assert.match(migration, /This decision is closed/);
  assert.match(auditMigration, /create or replace function public\.cast_outfit_decision_vote/);
  assert.match(auditMigration, /where id = p_group_id\s*\n\s*for update/);
});

test('public preview is read-only, token-gated, and excludes voter identity', () => {
  assert.match(migration, /get_public_room_decision_preview/);
  // Revocation and expiry respected exactly like the legacy preview.
  assert.match(migration, /rs\.is_active = true[\s\S]*?rs\.revoked_at is null[\s\S]*?rs\.expires_at is null or rs\.expires_at > now\(\)/);
  const previewFn = migration.slice(migration.indexOf('get_public_room_decision_preview'));
  assert.doesNotMatch(previewFn, /user_id'|'createdBy'|created_by'/);
  assert.doesNotMatch(previewFn, /'voterIds'|'voters'/);
  assert.match(previewFn, /'voteCount'/);
  // Legacy public preview contract untouched by this migration.
  assert.doesNotMatch(migration, /create or replace function public\.get_public_room_preview\b/);
  // Public visitors have no vote controls; join is required to vote.
  assert.match(publicScreen, /isAuthenticated && joinedRoomId \? \(\s*<OutfitDecisionSection/);
  assert.match(publicScreen, /PublicDecisionPreview/);
  assert.doesNotMatch(
    publicScreen.slice(publicScreen.indexOf('function PublicDecisionPreview'), publicScreen.indexOf('function ErrorState')),
    /castOutfitDecisionVote|VOTE/,
  );
  assert.match(auditMigration, /create or replace function public\.get_public_room_decision_preview/);
  assert.match(auditMigration, /limit 10/);
  assert.match(auditMigration, /limit 3/);
  assert.match(auditMigration, /limit 6/);
});

test('share-token redemption limit is enforced in the join RPC', () => {
  // Remediation precedes the prerequisite chain, which must preserve the final
  // nullable/unlimited contract.
  assert.doesNotMatch(rolePrivilegeMigration, /max_redemptions integer not null/);
  assert.doesNotMatch(rolePrivilegeMigration, /coalesce\(target_max_redemptions,\s*0\)/);
  assert.match(rolePrivilegeMigration, /if target_max_redemptions is not null then/);
  assert.match(roomShareRemediationMigration, /alter column max_redemptions drop not null/);
  assert.match(roomShareRemediationMigration, /alter column max_redemptions set default 10/);
  assert.match(roomShareRemediationMigration, /max_redemptions is null or max_redemptions > 0/);
  assert.match(roomShareRemediationMigration, /create or replace function public\.join_room_via_share_token/);
  assert.match(roomShareRemediationMigration, /for update of rs/);
  assert.match(roomShareRemediationMigration, /if target_max_redemptions is not null then/);
  assert.match(roomShareRemediationMigration, /current_redemptions >= target_max_redemptions/);
  assert.match(roomShareRemediationMigration, /Shared room is full/);
  assert.match(roomShareRemediationMigration, /Reopening an already-joined room is idempotent/);
  assert.doesNotMatch(roomShareRemediationMigration, /coalesce\(target_max_redemptions,\s*0\)/);
});

test('deletion semantics: room cascade, voter-only cascade, creator SET NULL', () => {
  assert.match(migration, /dressing_room_id uuid not null references public\.dressing_rooms\(id\) on delete cascade/);
  assert.match(migration, /group_id uuid not null references public\.outfit_decision_groups\(id\) on delete cascade/);
  assert.match(migration, /option_id uuid not null references public\.outfit_decision_options\(id\) on delete cascade/);
  assert.match(migration, /user_id uuid not null references auth\.users\(id\) on delete cascade/);
  assert.match(migration, /created_by uuid references auth\.users\(id\) on delete set null/);
  // Source Look deletion preserves the option snapshot.
  assert.match(migration, /source_look_id uuid references public\.looks\(id\) on delete set null/);
});

test('account-deletion contract covers all new tables', () => {
  for (const table of [
    'outfit_decision_groups',
    'outfit_decision_options',
    'outfit_decision_option_items',
    'outfit_decision_votes',
    'style_outfit_daily_usage',
    'style_outfit_burst_usage',
  ]) {
    assert.match(deletionScript, new RegExp(`table: '${table}'`));
  }
  assert.match(deletionScript, /outfit_decision_groups', column: 'created_by', action: 'auth_delete_set_null'/);
  assert.match(deletionScript, /outfit_decision_votes', column: 'user_id', action: 'auth_delete_cascade'/);
});

test('vote UI supports voting, vote change, counts, chosen and wearing states', () => {
  assert.match(section, /castOutfitDecisionVote/);
  assert.match(section, /myVote \? 'VOTED' : 'VOTE'/);
  assert.match(section, /vote_count|voteCount/);
  assert.match(section, /CHOSEN/);
  assert.match(section, /I'm wearing Look \$\{chosenIndex \+ 1\}/);
  assert.match(section, /I'M WEARING THIS/);
  // One in-flight mutation guard.
  assert.match(section, /if \(mutatingGroupId\) return/);
});

test('owner screen renders decisions owner-gated; shared screen participant-gated', () => {
  assert.match(ownerScreen, /aiStylistDecisionsEnabled && roomId \? \(\s*<OutfitDecisionSection roomId=\{roomId\} role="owner"/);
  assert.match(ownerScreen, /room\.userId === user\.id/);
  assert.match(publicScreen, /role="participant"/);
});
