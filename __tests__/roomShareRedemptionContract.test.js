const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');
const migrationFiles = fs.readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith('.sql')).sort();
const remediationFile = migrationFiles.find((file) =>
  file.endsWith('_room_share_redemption_contract_remediation.sql'),
);

assert.ok(remediationFile, 'room-share redemption remediation migration missing');

const remediation = fs.readFileSync(path.join(MIGRATIONS_DIR, remediationFile), 'utf8');
const qaCreationMigration = fs.readFileSync(
  path.join(MIGRATIONS_DIR, '20260708140542_increase_room_share_redemptions_to_10_for_testing.sql'),
  'utf8',
);
const rolePrivilegeMigration = fs.readFileSync(
  path.join(MIGRATIONS_DIR, '20260712020000_harden_app_role_privileges.sql'),
  'utf8',
);
const styleObjectsService = fs.readFileSync(path.join(ROOT, 'services', 'styleObjects.ts'), 'utf8');
const roomMessagesService = fs.readFileSync(path.join(ROOT, 'services', 'roomMessages.ts'), 'utf8');

test('remediation is forward-only and sorts immediately after the verified remote boundary', () => {
  assert.equal(remediationFile, '20260710000001_room_share_redemption_contract_remediation.sql');
  assert.ok(remediationFile > '20260709130346_android_backend_runtime_fixes.sql');
  assert.ok(remediationFile < '20260711000001_ai_stylist_looks_extension.sql');
});

test('final schema is nullable, defaults to 10, and accepts only NULL or positive integers', () => {
  assert.match(remediation, /alter column max_redemptions drop not null/);
  assert.match(remediation, /alter column max_redemptions set default 10/);
  assert.match(remediation, /constraint room_shares_max_redemptions_positive_check/);
  assert.match(remediation, /check \(max_redemptions is null or max_redemptions > 0\)/);
  assert.match(remediation, /validate constraint room_shares_max_redemptions_positive_check/);
  assert.doesNotMatch(remediation, /max_redemptions between 1 and 100|max_redemptions\s*<=\s*100/i);
  assert.doesNotMatch(remediation, /add column[^;]*max_redemptions[^;]*not null/i);
});

test('only the proven obsolete prerequisite constraint is removed', () => {
  assert.match(remediation, /drop constraint if exists room_shares_max_redemptions_check/);
  const drops = remediation.match(/drop constraint/gi) ?? [];
  assert.equal(drops.length, 1);
});

test('migration contains no room-share row rewrite', () => {
  assert.doesNotMatch(remediation, /\bupdate\s+public\.room_shares\b/i);
  assert.doesNotMatch(remediation, /\bdelete\s+from\s+public\.room_shares\b/i);
  assert.doesNotMatch(remediation, /\binsert\s+into\s+public\.room_shares\b/i);
});

test('database comment documents the dual semantics and new-row default', () => {
  assert.match(remediation, /NULL denotes an unlimited legacy room-share link\./);
  assert.match(remediation, /Positive integers denote redemption-capped links\./);
  assert.match(remediation, /New links default to 10 redemptions\./);
});

test('join RPC preserves unlimited NULL links and enforces numeric caps atomically', () => {
  assert.match(remediation, /security definer\s+set search_path = public/i);
  assert.match(remediation, /for update of rs/);
  assert.match(remediation, /if target_max_redemptions is not null then/);
  assert.match(remediation, /where p\.joined_via_share_id = target_share_id/);
  assert.match(remediation, /current_redemptions >= target_max_redemptions/);
  assert.doesNotMatch(remediation, /coalesce\(target_max_redemptions,\s*0\)/i);
});

test('new-link creation is capped while explicit positive table values remain allowed', () => {
  assert.match(qaCreationMigration, /max_redemptions\)\s*\n\s*values \([^;]*, 10\)/i);
  assert.match(remediation, /alter column max_redemptions set default 10/);
  assert.match(remediation, /max_redemptions is null or max_redemptions > 0/);
});

test('remediation preserves table RLS and grants and reasserts the existing RPC boundary', () => {
  assert.doesNotMatch(remediation, /alter table public\.room_shares (enable|disable|force|no force) row level security/i);
  assert.doesNotMatch(remediation, /create policy|drop policy/i);
  assert.doesNotMatch(remediation, /grant [^;]* on (table )?public\.room_shares/i);
  assert.match(remediation, /revoke all on function public\.join_room_via_share_token\(text\) from public/);
  assert.match(remediation, /revoke all on function public\.join_room_via_share_token\(text\) from anon/);
  assert.match(remediation, /grant execute on function public\.join_room_via_share_token\(text\) to authenticated/);
});

test('application consumers remain RPC-only and make no nullability assumption', () => {
  assert.match(styleObjectsService, /supabase\.rpc\('create_or_get_room_share'/);
  assert.match(roomMessagesService, /supabase\.rpc\('join_room_via_share_token'/);
  assert.doesNotMatch(styleObjectsService, /max_redemptions/);
  assert.doesNotMatch(roomMessagesService, /max_redemptions/);
  assert.doesNotMatch(rolePrivilegeMigration, /coalesce\(target_max_redemptions,\s*0\)/);
  assert.match(rolePrivilegeMigration, /if target_max_redemptions is not null then/);
  assert.match(remediation, /if target_max_redemptions is not null then/);
});
