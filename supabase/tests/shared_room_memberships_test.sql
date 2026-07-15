-- pgTAP behavioral tests for shared_room_memberships.
--
-- Run inside a Supabase project with pgTAP enabled:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/shared_room_memberships_test.sql
--
-- The test wraps every scenario in a transaction and rolls back, so no fixture
-- data is persisted.

begin;

select plan(62);

-- ── Test fixtures ─────────────────────────────────────────────────────────────
insert into auth.users (id, email)
values
  ('00000000-0000-0000-0000-000000000001', 'room-owner@example.invalid'),
  ('00000000-0000-0000-0000-000000000002', 'recipient-a@example.invalid'),
  ('00000000-0000-0000-0000-000000000003', 'recipient-b@example.invalid');

insert into public.dressing_rooms (id, user_id, title)
values
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'Owner Room'),
  ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'Shared Room A'),
  ('10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 'Shared Room B');

-- Active share for Shared Room A
insert into public.room_shares (id, room_id, owner_id, share_token, is_active)
values ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'active-token-a', true);

-- Revoked share for Shared Room B
insert into public.room_shares (id, room_id, owner_id, share_token, is_active, revoked_at)
values ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 'revoked-token-b', false, now());

-- Expired share
insert into public.room_shares (id, room_id, owner_id, share_token, is_active, expires_at)
values ('20000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 'expired-token-b', true, now() - interval '1 hour');

-- Add a few items so "active" vs "empty" can be distinguished.
insert into public.dressing_room_items (id, dressing_room_id, source_type, snapshot_version, snapshot_payload, title, sort_order)
values
  ('30000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'product_match', 1, '{}'::jsonb, 'Item 1', 0),
  ('30000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', 'product_match', 1, '{}'::jsonb, 'Item 2', 1);

-- ── Schema assertions ──────────────────────────────────────────────────────────

select ok(
  exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'shared_room_memberships'
  ),
  'shared_room_memberships table exists'
);

select columns_are(
  'public', 'shared_room_memberships',
  array['id', 'share_id', 'recipient_user_id', 'first_opened_at', 'last_accessed_at', 'removed_at', 'created_at', 'updated_at'],
  'membership table has the expected columns'
);

select ok(
  (select relrowsecurity from pg_class where oid = 'public.shared_room_memberships'::regclass),
  'RLS is enabled on shared_room_memberships'
);

select ok(
  exists (
    select 1 from pg_constraint
    where conrelid = 'public.shared_room_memberships'::regclass
      and contype = 'u'
      and pg_get_constraintdef(oid) like '%(share_id, recipient_user_id)%'
  ),
  'unique constraint on (share_id, recipient_user_id) exists'
);

select fk_ok(
  'public', 'shared_room_memberships', 'share_id',
  'public', 'room_shares', 'id',
  'share_id references room_shares(id)'
);

select fk_ok(
  'public', 'shared_room_memberships', 'recipient_user_id',
  'auth', 'users', 'id',
  'recipient_user_id references auth.users(id)'
);

select ok(
  exists (
    select 1 from pg_indexes
    where schemaname = 'public' and tablename = 'shared_room_memberships'
      and indexname = 'shared_room_memberships_recipient_idx'
  ),
  'recipient index exists'
);

select ok(
  exists (
    select 1 from pg_indexes
    where schemaname = 'public' and tablename = 'shared_room_memberships'
      and indexname = 'shared_room_memberships_recipient_active_idx'
  ),
  'recipient active index exists'
);

select ok(
  exists (
    select 1 from pg_indexes
    where schemaname = 'public' and tablename = 'shared_room_memberships'
      and indexname = 'shared_room_memberships_share_idx'
  ),
  'share index exists'
);

-- ── Grant / RLS assertions ─────────────────────────────────────────────────────

select is(
  (select count(*) from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'shared_room_memberships' and grantee = 'anon'),
  0::bigint,
  'anon has no direct table grants'
);

select is(
  (select count(*) from information_schema.table_privileges
   where table_schema = 'public' and table_name = 'shared_room_memberships'
     and grantee = 'authenticated'
     and privilege_type in ('SELECT', 'INSERT', 'UPDATE')),
  3::bigint,
  'authenticated has select/insert/update grants'
);

select is(
  (select count(*) from information_schema.table_privileges
   where table_schema = 'public' and table_name = 'shared_room_memberships'
     and grantee = 'authenticated'
     and privilege_type = 'DELETE'),
  0::bigint,
  'authenticated has no delete grant'
);

-- ── Function existence and security ────────────────────────────────────────────

select has_function(
  'public', 'save_shared_room_for_me', array['text'],
  'save_shared_room_for_me function exists'
);

select has_function(
  'public', 'list_shared_rooms_for_me', array[],
  'list_shared_rooms_for_me function exists'
);

select has_function(
  'public', 'touch_shared_room_for_me', array['text'],
  'touch_shared_room_for_me function exists'
);

select has_function(
  'public', 'remove_shared_room_for_me', array['text'],
  'remove_shared_room_for_me function exists'
);

select is(
  (select prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'save_shared_room_for_me'
     and pg_get_function_identity_arguments(p.oid) = 'p_share_token text'),
  true,
  'save_shared_room_for_me is SECURITY DEFINER'
);

select ok(
  (select proconfig @> array['search_path=public'] from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'save_shared_room_for_me'
     and pg_get_function_identity_arguments(p.oid) = 'p_share_token text'),
  'save_shared_room_for_me has safe search_path'
);

select is(
  has_function_privilege('public', 'public.save_shared_room_for_me(text)', 'execute'),
  false,
  'PUBLIC cannot execute save_shared_room_for_me'
);

select is(
  has_function_privilege('anon', 'public.save_shared_room_for_me(text)', 'execute'),
  false,
  'anon cannot execute save_shared_room_for_me'
);

select is(
  has_function_privilege('authenticated', 'public.save_shared_room_for_me(text)', 'execute'),
  true,
  'authenticated can execute save_shared_room_for_me'
);

-- ── SAVE behavior ──────────────────────────────────────────────────────────────

-- Unauthenticated
select is(
  public.save_shared_room_for_me('active-token-a'),
  jsonb_build_object('status', 'unauthenticated'),
  'unauthenticated caller receives unauthenticated status'
);

-- Malformed token
perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000002', true);
select is(
  public.save_shared_room_for_me('bad token!'),
  jsonb_build_object('status', 'malformed'),
  'malformed token rejected'
);

-- Revoked token
select is(
  public.save_shared_room_for_me('revoked-token-b'),
  jsonb_build_object('status', 'unavailable'),
  'revoked token unavailable'
);

-- Expired token
select is(
  public.save_shared_room_for_me('expired-token-b'),
  jsonb_build_object('status', 'unavailable'),
  'expired token unavailable'
);

-- Unknown token
select is(
  public.save_shared_room_for_me('no-such-token'),
  jsonb_build_object('status', 'unavailable'),
  'unknown token unavailable'
);

-- Owner no-op
perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', true);
select is(
  public.save_shared_room_for_me('active-token-a'),
  jsonb_build_object('status', 'owner'),
  'owner opening own share receives owner status'
);

select is(
  (select count(*) from public.shared_room_memberships where recipient_user_id = '00000000-0000-0000-0000-000000000001'),
  0::bigint,
  'owner membership row is not created'
);

-- First recipient save
perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000002', true);
select is(
  public.save_shared_room_for_me('active-token-a'),
  jsonb_build_object('status', 'saved'),
  'first recipient save returns saved'
);

select is(
  (select count(*) from public.shared_room_memberships where recipient_user_id = '00000000-0000-0000-0000-000000000002'),
  1::bigint,
  'one membership row created for recipient A'
);

-- Duplicate save
select is(
  public.save_shared_room_for_me('active-token-a'),
  jsonb_build_object('status', 'already_saved'),
  'duplicate save returns already_saved'
);

select is(
  (select count(*) from public.shared_room_memberships where recipient_user_id = '00000000-0000-0000-0000-000000000002'),
  1::bigint,
  'duplicate save does not create a second row'
);

select ok(
  (select first_opened_at = (select first_opened_at from public.shared_room_memberships where recipient_user_id = '00000000-0000-0000-0000-000000000002'))
  and (select last_accessed_at > first_opened_at from public.shared_room_memberships where recipient_user_id = '00000000-0000-0000-0000-000000000002'),
  'first_opened_at preserved and last_accessed_at advanced on duplicate save'
);

-- Second recipient on same share
perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000003', true);
select is(
  public.save_shared_room_for_me('active-token-a'),
  jsonb_build_object('status', 'saved'),
  'recipient B can save the same share'
);

-- ── LIST behavior ──────────────────────────────────────────────────────────────

perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000002', true);
select results_eq(
  $$select share_token, title, status from public.list_shared_rooms_for_me()$$,
  $$values ('active-token-a'::text, 'Shared Room A'::text, 'active'::text)$$,
  'recipient A sees their shared room with active status'
);

perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000003', true);
select results_eq(
  $$select share_token, title, status from public.list_shared_rooms_for_me()$$,
  $$values ('active-token-a'::text, 'Shared Room A'::text, 'active'::text)$$,
  'recipient B sees the same shared room'
);

-- Owner cannot inspect recipient memberships
perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', true);
select is(
  (select count(*) from public.list_shared_rooms_for_me()),
  0::bigint,
  'owner sees no shared_room_memberships entries'
);

-- Direct RLS: owner select on table returns zero rows.
select is(
  (select count(*) from public.shared_room_memberships),
  0::bigint,
  'owner direct select on membership table returns zero rows'
);

-- ── REMOVE / RESTORE behavior ──────────────────────────────────────────────────

perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000002', true);
select is(
  public.remove_shared_room_for_me('active-token-a'),
  jsonb_build_object('status', 'removed'),
  'recipient A removes the room'
);

select is(
  (select count(*) from public.list_shared_rooms_for_me()),
  0::bigint,
  'removed room no longer appears in list'
);

select is(
  (select removed_at is not null from public.shared_room_memberships where recipient_user_id = '00000000-0000-0000-0000-000000000002'),
  true,
  'removed_at is set on the membership row'
);

-- Remove is idempotent
select is(
  public.remove_shared_room_for_me('active-token-a'),
  jsonb_build_object('status', 'removed'),
  'repeated remove is safe'
);

-- Reopening restores
select is(
  public.save_shared_room_for_me('active-token-a'),
  jsonb_build_object('status', 'restored'),
  'reopening active share restores removed membership'
);

select is(
  (select removed_at is null from public.shared_room_memberships where recipient_user_id = '00000000-0000-0000-0000-000000000002'),
  true,
  'restored membership has removed_at cleared'
);

-- Remove does not revoke the share
select is(
  (select is_active from public.room_shares where share_token = 'active-token-a'),
  true,
  'share remains active after recipient removal'
);

-- Remove by recipient A does not affect recipient B
perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000003', true);
select is(
  (select count(*) from public.list_shared_rooms_for_me()),
  1::bigint,
  'recipient B still sees the room after A removes it'
);

-- ── TOUCH behavior ─────────────────────────────────────────────────────────────

perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000002', true);
select is(
  public.touch_shared_room_for_me('active-token-a'),
  jsonb_build_object('status', 'touched'),
  'touch updates last_accessed_at'
);

select ok(
  (select first_opened_at < last_accessed_at from public.shared_room_memberships where recipient_user_id = '00000000-0000-0000-0000-000000000002'),
  'touch advances last_accessed_at while preserving first_opened_at'
);

-- Touch on revoked token
perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000003', true);
select is(
  public.touch_shared_room_for_me('revoked-token-b'),
  jsonb_build_object('status', 'unavailable'),
  'touch on revoked token returns unavailable'
);

-- ── TOKEN ROTATION ─────────────────────────────────────────────────────────────

-- Simulate rotation: revoke old share, create new one with new token for the same room.
update public.room_shares
set is_active = false, revoked_at = now()
where share_token = 'active-token-a';

insert into public.room_shares (id, room_id, owner_id, share_token, is_active)
values ('20000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'new-token-a', true);

perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000002', true);
select is(
  public.save_shared_room_for_me('active-token-a'),
  jsonb_build_object('status', 'unavailable'),
  'old revoked token cannot restore access'
);

select is(
  public.save_shared_room_for_me('new-token-a'),
  jsonb_build_object('status', 'saved'),
  'new token creates a distinct membership'
);

select is(
  (select count(*) from public.shared_room_memberships where recipient_user_id = '00000000-0000-0000-0000-000000000002'),
  2::bigint,
  'recipient has separate memberships for old and new share tokens'
);

-- ── ROOM DELETION CASCADE ──────────────────────────────────────────────────────

-- The old share row was already revoked; deleting the room must cascade.
delete from public.dressing_rooms where id = '10000000-0000-0000-0000-000000000002';

select is(
  (select count(*) from public.shared_room_memberships where share_id in ('20000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000004')),
  0::bigint,
  'room deletion cascades to memberships via share FK'
);

select * from finish();
rollback;
