const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const migration = fs.readFileSync(
  path.join(ROOT, 'supabase', 'migrations', '20260716000001_shared_room_memberships.sql'),
  'utf8',
);

test('migration creates the shared_room_memberships table with required columns', () => {
  assert.match(migration, /create table if not exists public\.shared_room_memberships\s*\(/);
  assert.match(migration, /id\s+uuid primary key default gen_random_uuid\(\)/);
  assert.match(migration, /share_id\s+uuid not null references public\.room_shares\(id\) on delete cascade/);
  assert.match(migration, /recipient_user_id\s+uuid not null references auth\.users\(id\) on delete cascade/);
  assert.match(migration, /first_opened_at\s+timestamptz not null/);
  assert.match(migration, /last_accessed_at\s+timestamptz not null/);
  assert.match(migration, /removed_at\s+timestamptz null/);
  assert.match(migration, /created_at\s+timestamptz not null/);
  assert.match(migration, /updated_at\s+timestamptz not null/);
});

test('migration enforces one membership per recipient and share', () => {
  assert.match(
    migration,
    /constraint shared_room_memberships_share_recipient_key unique \(share_id, recipient_user_id\)/,
  );
});

test('migration does not duplicate private or room metadata in the membership table', () => {
  const tableMatch = migration.match(/create table if not exists public\.shared_room_memberships\s*\([\s\S]*?\);/);
  assert.ok(tableMatch, 'membership table definition found');
  const tableDef = tableMatch[0];
  assert.doesNotMatch(tableDef, /owner_id/);
  assert.doesNotMatch(tableDef, /room_id.*uuid.*references public\.dressing_rooms/);
  assert.doesNotMatch(tableDef, /share_token.*text/);
  assert.doesNotMatch(tableDef, /item_ids/);
  assert.doesNotMatch(tableDef, /storage_bucket/);
  assert.doesNotMatch(tableDef, /storage_path/);
});

test('migration creates the expected indexes', () => {
  assert.match(migration, /create index if not exists shared_room_memberships_recipient_idx/);
  assert.match(migration, /create index if not exists shared_room_memberships_recipient_active_idx/);
  assert.match(migration, /create index if not exists shared_room_memberships_share_idx/);
});

test('migration converges verified live participant redemption indexes', () => {
  assert.match(migration, /create index if not exists dressing_room_participants_joined_via_share_id_idx/);
  assert.match(migration, /on public\.dressing_room_participants \(joined_via_share_id\)/);
  assert.match(migration, /create index if not exists dressing_room_participants_share_user_idx/);
  assert.match(migration, /on public\.dressing_room_participants \(joined_via_share_id, user_id\)/);
});

test('RLS is enabled and anonymous access is denied', () => {
  assert.match(migration, /alter table public\.shared_room_memberships enable row level security/);
  assert.match(
    migration,
    /revoke all on table public\.shared_room_memberships\s+from public, anon, authenticated/,
  );
  assert.doesNotMatch(migration, /grant.*on public\.shared_room_memberships to anon/);
});

test('authenticated clients have no direct membership table privileges', () => {
  assert.match(
    migration,
    /revoke all on table public\.shared_room_memberships\s+from public, anon, authenticated/,
  );
  assert.doesNotMatch(
    migration,
    /grant\s+(?:select|insert|update|delete|all)[^;]*shared_room_memberships[^;]*to authenticated/i,
  );
});

test('recipient-only SELECT RLS remains as defense in depth without mutation policies', () => {
  assert.match(
    migration,
    /for select\s+to authenticated\s+using \([\s\S]*recipient_user_id = \(select auth\.uid\(\)\)[\s\S]*\)/,
  );
  assert.doesNotMatch(migration, /create policy[^;]*for insert/is);
  assert.doesNotMatch(migration, /create policy[^;]*for update/is);
  assert.doesNotMatch(migration, /create policy[^;]*for delete/is);
  // Owners must not gain read access merely because they own the room.
  const policy = migration.match(
    /create policy "Recipients can select own shared room memberships"[\s\S]*?\);/,
  )?.[0] ?? '';
  assert.doesNotMatch(policy, /dressing_rooms/);
});

test('updated_at trigger runs as invoker and is not a client-callable RPC', () => {
  assert.match(
    migration,
    /function public\.set_shared_room_memberships_updated_at\(\)[\s\S]*?security invoker[\s\S]*?set search_path = pg_catalog/,
  );
  assert.match(
    migration,
    /revoke all on function public\.set_shared_room_memberships_updated_at\(\)\s+from public, anon, authenticated, service_role/,
  );
  assert.doesNotMatch(
    migration,
    /grant execute on function public\.set_shared_room_memberships_updated_at/,
  );
});

test('save_shared_room_for_me is a security definer function with safe search_path', () => {
  assert.match(migration, /create or replace function public\.save_shared_room_for_me\(p_share_token text\)/);
  assert.match(migration, /security definer\s+set search_path = pg_catalog/s);
});

test('save_shared_room_for_me validates token shape and active share state', () => {
  assert.match(migration, /normalized_token !~ '\^\[A-Za-z0-9_-\]\+\$'/);
  assert.match(migration, /rs\.is_active = true/);
  assert.match(migration, /rs\.revoked_at is null/);
  assert.match(migration, /rs\.expires_at is null or rs\.expires_at > now\(\)/);
  assert.match(migration, /rs\.access_level = 'view'/);
  assert.match(migration, /dr\.user_id = rs\.owner_id/);
});

test('save_shared_room_for_me returns the required sanitized statuses', () => {
  // Dynamic statuses are assigned to result_status and returned once.
  for (const status of ['saved', 'already_saved', 'restored']) {
    assert.match(migration, new RegExp(`result_status := '${status}'`));
  }
  // Literal statuses are returned directly.
  for (const status of ['owner', 'unavailable', 'unauthenticated', 'malformed']) {
    assert.match(migration, new RegExp(`'status', '${status}'`));
  }
  assert.match(migration, /jsonb_build_object\('status', result_status\)/);
});

test('save_shared_room_for_me preserves first_opened_at and restores removed memberships', () => {
  assert.match(migration, /first_opened_at,[\s\S]*?event_time/);
  assert.match(migration, /removed_at = null/);
  assert.match(migration, /result_status := 'restored'/);
  assert.match(migration, /result_status := 'already_saved'/);
});

test('save_shared_room_for_me owner no-op is explicit', () => {
  assert.match(migration, /if target_share\.owner_id = current_user_id then/);
  assert.match(migration, /return jsonb_build_object\('status', 'owner'\)/);
});

test('save_shared_room_for_me serializes concurrent saves on the share row', () => {
  assert.match(migration, /for update of rs/);
  assert.match(migration, /constraint shared_room_memberships_share_recipient_key unique/);
  assert.match(migration, /from public\.shared_room_memberships as srm[\s\S]*?for update/);
});

test('list_shared_rooms_for_me is a bounded security-definer query', () => {
  assert.match(migration, /create or replace function public\.list_shared_rooms_for_me\(\)/);
  assert.match(migration, /language plpgsql\s+stable\s+security definer\s+set search_path = pg_catalog/s);
  assert.match(migration, /if current_user_id is null then\s+raise exception 'Authentication required'/s);
  assert.match(migration, /limit 100/);
});

test('list_shared_rooms_for_me scopes recipients and sanitizes unavailable shares', () => {
  assert.match(migration, /srm\.recipient_user_id = current_user_id/);
  assert.match(migration, /srm\.removed_at is null/);
  assert.match(migration, /rs\.is_active = true/);
  assert.match(migration, /rs\.revoked_at is null/);
  assert.match(migration, /when not rm\.is_available then 'unavailable'/);
  assert.match(migration, /when rm\.is_available then rm\.room_updated_at else null::timestamptz/);
  assert.match(migration, /when rm\.is_available then[\s\S]*?else null::text[\s\S]*?end as title/);
});

test('list_shared_rooms_for_me returns only safe list-renderable fields', () => {
  assert.match(migration, /share_token\s+text,/);
  assert.match(migration, /title\s+text,/);
  assert.match(migration, /item_count\s+bigint,/);
  assert.match(migration, /first_opened_at\s+timestamptz,/);
  assert.match(migration, /last_accessed_at\s+timestamptz,/);
  assert.match(migration, /status\s+text,/);

  // Scope the privacy check to the function body so design-time comments do
  // not false-positive the assertion.
  const listMatch = migration.match(/create or replace function public\.list_shared_rooms_for_me\(\)[\s\S]*?\$\$;/);
  assert.ok(listMatch, 'list_shared_rooms_for_me function body found');
  const listBody = listMatch[0];
  assert.doesNotMatch(listBody, /storage_bucket/);
  assert.doesNotMatch(listBody, /storage_path/);
  assert.doesNotMatch(listBody, /image_url/);
  // recipient_user_id is legitimately used in the WHERE filter (RLS) but must
  // not appear as a returned column.
  const returnsBlock = listBody.match(/returns table \([\s\S]*?\)/)?.[0] ?? '';
  assert.doesNotMatch(returnsBlock, /recipient_user_id/);
  assert.doesNotMatch(returnsBlock, /owner_id/);
  assert.doesNotMatch(returnsBlock, /room_id/);
});

test('list item counts are bounded to the recipient membership set', () => {
  assert.match(migration, /with recipient_memberships as materialized/);
  assert.match(
    migration,
    /select distinct rm\.room_id\s+from recipient_memberships as rm\s+where rm\.is_available/s,
  );
  assert.match(migration, /group by dri\.dressing_room_id/);
  assert.doesNotMatch(migration, /from public\.dressing_room_items dri\s+group by/s);
});

test('touch_shared_room_for_me requires active share and updates only last_accessed_at', () => {
  assert.match(migration, /create or replace function public\.touch_shared_room_for_me\(p_share_token text\)/);
  assert.match(migration, /set last_accessed_at = clock_timestamp\(\)/);
  assert.doesNotMatch(migration, /set first_opened_at =/);
  assert.match(migration, /removed_at is null/);
  assert.match(migration, /dr\.user_id = rs\.owner_id/);
});

test('remove_shared_room_for_me soft-deletes only the current recipient membership', () => {
  assert.match(migration, /create or replace function public\.remove_shared_room_for_me\(p_share_token text\)/);
  assert.match(migration, /set removed_at = clock_timestamp\(\)/);
  assert.match(migration, /recipient_user_id = current_user_id/);
  assert.doesNotMatch(migration, /update public\.room_shares.*is_active = false/s);
  assert.doesNotMatch(migration, /revoked_at = now\(\)/s);
});

test('remove does not enumerate well-formed tokens or require active shares', () => {
  const removeBody = migration.match(
    /create or replace function public\.remove_shared_room_for_me\(p_share_token text\)[\s\S]*?\$\$;/,
  )?.[0] ?? '';
  assert.match(removeBody, /return jsonb_build_object\('status', 'removed'\)/);
  assert.doesNotMatch(removeBody, /'status', 'unavailable'/);
  assert.doesNotMatch(removeBody, /rs\.is_active|rs\.revoked_at|rs\.expires_at/);
});

test('membership remains discovery-only and does not consume participant redemptions', () => {
  assert.match(migration, /does not join messaging/);
  assert.match(migration, /does not.*consume room_shares\.max_redemptions/s);
  assert.doesNotMatch(migration, /insert into public\.dressing_room_participants/);
  assert.doesNotMatch(migration, /can_access_room_messages/);
});

test('membership functions grant execute only to authenticated', () => {
  const normalized = migration.replace(/\s+/g, ' ');
  for (const fn of [
    'save_shared_room_for_me',
    'list_shared_rooms_for_me',
    'touch_shared_room_for_me',
    'remove_shared_room_for_me',
  ]) {
    const grantRe = new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to authenticated`);
    assert.match(normalized, grantRe, `${fn} granted to authenticated`);

    assert.match(
      normalized,
      new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\) from public, anon, authenticated, service_role`),
      `${fn} revoked from every non-owner role before the authenticated grant`,
    );
  }
});

test('all client RPCs use pg_catalog-only search paths and exact signatures', () => {
  for (const signature of [
    'save_shared_room_for_me\\(p_share_token text\\)',
    'list_shared_rooms_for_me\\(\\)',
    'touch_shared_room_for_me\\(p_share_token text\\)',
    'remove_shared_room_for_me\\(p_share_token text\\)',
  ]) {
    assert.match(
      migration,
      new RegExp(`function public\\.${signature}[\\s\\S]*?security definer[\\s\\S]*?set search_path = pg_catalog`),
    );
  }
});

test('migration includes rollback guidance', () => {
  assert.match(migration, /Rollback guidance/);
  assert.match(migration, /drop table if exists public\.shared_room_memberships cascade/);
  assert.match(migration, /drop function if exists public\.save_shared_room_for_me\(text\) cascade/);
  assert.match(migration, /drop function if exists public\.list_shared_rooms_for_me\(\) cascade/);
});
