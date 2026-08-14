-- Runtime pgTAP coverage for the Shared with Me membership contract.
-- The transaction is rolled back, so no fixture data persists.

begin;
select no_plan();

insert into auth.users (id, email)
values
  ('00000000-0000-0000-0000-000000000001', 'room-owner@example.invalid'),
  ('00000000-0000-0000-0000-000000000002', 'recipient-a@example.invalid'),
  ('00000000-0000-0000-0000-000000000003', 'recipient-b@example.invalid'),
  ('00000000-0000-0000-0000-000000000004', 'recipient-delete@example.invalid');

insert into public.dressing_rooms (id, user_id, title)
values
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'Shared Room A'),
  ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'Shared Room B'),
  ('10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 'Empty Room'),
  ('10000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000001', 'Cap Room'),
  ('10000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000001', 'Delete Room');

insert into public.room_shares (
  id, room_id, owner_id, share_token, is_active, revoked_at, expires_at, max_redemptions
)
values
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'active-token-a', true, null, null, 10),
  ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'revoked-token-b', false, now(), null, 10),
  ('20000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'expired-token-b', true, null, now() - interval '1 hour', 10),
  ('20000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 'empty-token', true, null, null, 10),
  ('20000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000001', 'cap-one-token', true, null, null, 1),
  ('20000000-0000-0000-0000-000000000006', '10000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000001', 'delete-token', true, null, null, 10);

insert into public.dressing_room_items (
  id, dressing_room_id, source_type, snapshot_version, snapshot_payload, title, sort_order
)
values
  ('30000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'product_match', 1, '{}'::jsonb, 'Item 1', 0),
  ('30000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'product_match', 1, '{}'::jsonb, 'Item 2', 1);

-- Schema, lifecycle, grants, and overload safety.
select has_index(
  'public', 'dressing_room_participants',
  'dressing_room_participants_joined_via_share_id_idx',
  'live redemption lookup index is represented in migrations'
);
select has_index(
  'public', 'dressing_room_participants',
  'dressing_room_participants_share_user_idx',
  'live redemption recipient index is represented in migrations'
);
select has_table('public', 'shared_room_memberships', 'membership table exists');
select columns_are(
  'public',
  'shared_room_memberships',
  array['id', 'share_id', 'recipient_user_id', 'first_opened_at', 'last_accessed_at', 'removed_at', 'created_at', 'updated_at'],
  'membership table has only the approved columns'
);
select fk_ok(
  'public', 'shared_room_memberships', 'share_id',
  'public', 'room_shares', 'id',
  'share_id references room_shares'
);
select fk_ok(
  'public', 'shared_room_memberships', 'recipient_user_id',
  'auth', 'users', 'id',
  'recipient_user_id references auth.users'
);
select ok(
  exists (
    select 1 from pg_constraint
    where conrelid = 'public.shared_room_memberships'::regclass
      and contype = 'u'
      and pg_get_constraintdef(oid) like '%(share_id, recipient_user_id)%'
  ),
  'one membership is enforced per share and recipient'
);
select is(
  (select confdeltype from pg_constraint
   where conrelid = 'public.shared_room_memberships'::regclass
     and conname = 'shared_room_memberships_share_id_fkey'),
  'c'::"char",
  'share deletion cascades memberships'
);
select is(
  (select confdeltype from pg_constraint
   where conrelid = 'public.shared_room_memberships'::regclass
     and conname = 'shared_room_memberships_recipient_user_id_fkey'),
  'c'::"char",
  'recipient deletion cascades memberships'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.shared_room_memberships'::regclass),
  'RLS is enabled'
);
select is(
  (select count(*) from pg_policies
   where schemaname = 'public' and tablename = 'shared_room_memberships'),
  1::bigint,
  'only the recipient SELECT policy exists'
);
select is(
  (select count(*) from pg_policies
   where schemaname = 'public' and tablename = 'shared_room_memberships'
     and cmd in ('INSERT', 'UPDATE', 'DELETE')),
  0::bigint,
  'no direct mutation policy exists'
);
select is(
  (select count(*) from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'shared_room_memberships'
     and grantee = 'authenticated' and privilege_type = 'SELECT'),
  1::bigint,
  'authenticated has the reviewed SELECT grant needed for RLS policy evaluation'
);
select is(
  (select count(*) from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'shared_room_memberships'
     and (
       grantee = 'anon'
       or (grantee = 'authenticated' and privilege_type in ('INSERT', 'UPDATE', 'DELETE'))
     )),
  0::bigint,
  'anon has no table privilege and authenticated has no direct mutation privilege'
);
select is(
  (select count(*) from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'shared_room_memberships'
     and grantee = 'service_role'
     and privilege_type in ('SELECT', 'INSERT', 'UPDATE', 'DELETE')),
  4::bigint,
  'service role retains lifecycle CRUD'
);

select is(
  (select prosecdef from pg_proc where oid = 'public.set_shared_room_memberships_updated_at()'::regprocedure),
  false,
  'updated_at trigger is SECURITY INVOKER'
);
select is(
  has_function_privilege('authenticated', 'public.set_shared_room_memberships_updated_at()', 'execute'),
  false,
  'updated_at trigger function is not client executable'
);

select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in (
       'save_shared_room_for_me', 'list_shared_rooms_for_me',
       'touch_shared_room_for_me', 'remove_shared_room_for_me'
     )),
  4::bigint,
  'no weaker RPC overload is present'
);

select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in (
       'save_shared_room_for_me', 'list_shared_rooms_for_me',
       'touch_shared_room_for_me', 'remove_shared_room_for_me'
     )
     and p.prosecdef
     and p.proconfig @> array['search_path=pg_catalog']),
  4::bigint,
  'all four RPCs are SECURITY DEFINER with pg_catalog-only search paths'
);

select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in (
       'save_shared_room_for_me', 'list_shared_rooms_for_me',
       'touch_shared_room_for_me', 'remove_shared_room_for_me'
     )
     and has_function_privilege('authenticated', p.oid, 'execute')),
  4::bigint,
  'authenticated can execute exactly the intended RPCs'
);

select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in (
       'save_shared_room_for_me', 'list_shared_rooms_for_me',
       'touch_shared_room_for_me', 'remove_shared_room_for_me'
     )
     and (
       has_function_privilege('anon', p.oid, 'execute')
       or has_function_privilege('public', p.oid, 'execute')
       or has_function_privilege('service_role', p.oid, 'execute')
     )),
  0::bigint,
  'anon, PUBLIC, and service_role cannot execute recipient RPCs'
);

-- Function-level unauthenticated and anonymous denial.
select is(
  public.save_shared_room_for_me('active-token-a'),
  jsonb_build_object('status', 'unauthenticated'),
  'save returns a sanitized unauthenticated status'
);
select throws_ok(
  $$select * from public.list_shared_rooms_for_me()$$,
  '28000',
  'Authentication required',
  'list requires auth.uid()'
);

set local role anon;
select throws_ok(
  $$select public.save_shared_room_for_me('active-token-a')$$,
  '42501',
  null,
  'anon cannot execute save RPC'
);
reset role;

-- Save validation and owner no-op through the authenticated API role.
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000002', true);
select is(
  public.save_shared_room_for_me('bad token!'),
  jsonb_build_object('status', 'malformed'),
  'malformed token is rejected'
);
select is(
  public.save_shared_room_for_me('revoked-token-b'),
  jsonb_build_object('status', 'unavailable'),
  'revoked token is unavailable'
);
select is(
  public.save_shared_room_for_me('expired-token-b'),
  jsonb_build_object('status', 'unavailable'),
  'expired token is unavailable'
);
select is(
  public.save_shared_room_for_me('no-such-token'),
  jsonb_build_object('status', 'unavailable'),
  'unknown token is unavailable'
);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', true);
select is(
  public.save_shared_room_for_me('active-token-a'),
  jsonb_build_object('status', 'owner'),
  'owner gets an explicit no-op status'
);
reset role;
select is(
  (select count(*) from public.shared_room_memberships
   where recipient_user_id = '00000000-0000-0000-0000-000000000001'),
  0::bigint,
  'owner membership is not created'
);

-- Idempotent save and first-open preservation.
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000002', true);
select is(
  public.save_shared_room_for_me('active-token-a'),
  jsonb_build_object('status', 'saved'),
  'first save succeeds'
);
reset role;
create temporary table first_save_snapshot as
select first_opened_at, last_accessed_at
from public.shared_room_memberships
where share_id = '20000000-0000-0000-0000-000000000001'
  and recipient_user_id = '00000000-0000-0000-0000-000000000002';

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000002', true);
select is(
  public.save_shared_room_for_me('active-token-a'),
  jsonb_build_object('status', 'already_saved'),
  'repeat save is idempotent'
);
reset role;
select is(
  (select count(*) from public.shared_room_memberships
   where share_id = '20000000-0000-0000-0000-000000000001'
     and recipient_user_id = '00000000-0000-0000-0000-000000000002'),
  1::bigint,
  'repeat save keeps one row'
);
select is(
  (select srm.first_opened_at from public.shared_room_memberships srm
   where srm.share_id = '20000000-0000-0000-0000-000000000001'
     and srm.recipient_user_id = '00000000-0000-0000-0000-000000000002'),
  (select first_opened_at from first_save_snapshot),
  'repeat save preserves first_opened_at'
);
select ok(
  (select srm.last_accessed_at > snapshot.last_accessed_at
   from public.shared_room_memberships srm cross join first_save_snapshot snapshot
   where srm.share_id = '20000000-0000-0000-0000-000000000001'
     and srm.recipient_user_id = '00000000-0000-0000-0000-000000000002'),
  'repeat save advances last_accessed_at'
);

-- Listing is recipient-only, bounded, and sanitized.
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000002', true);
select results_eq(
  $$select share_token, title, item_count, status from public.list_shared_rooms_for_me()$$,
  $$values ('active-token-a'::text, 'Shared Room A'::text, 2::bigint, 'available'::text)$$,
  'recipient sees one available room with an exact item count'
);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000003', true);
select is(
  (select count(*) from public.list_shared_rooms_for_me()),
  0::bigint,
  'unrelated recipient sees no rows'
);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', true);
select is(
  (select count(*) from public.list_shared_rooms_for_me()),
  0::bigint,
  'owner cannot enumerate recipient memberships'
);
reset role;

-- Direct SELECT is allowed only through the recipient-scoped RLS policy;
-- direct mutations remain denied by the absence of grants and policies.
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000002', true);
select results_eq(
  $$select recipient_user_id from public.shared_room_memberships order by recipient_user_id$$,
  $$values ('00000000-0000-0000-0000-000000000002'::uuid)$$,
  'authenticated direct SELECT is restricted to the caller membership by RLS'
);
select throws_ok(
  $$insert into public.shared_room_memberships (share_id, recipient_user_id)
    values ('20000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000002')$$,
  '42501', null, 'authenticated direct INSERT is denied'
);
select throws_ok(
  $$update public.shared_room_memberships set removed_at = null$$,
  '42501', null, 'authenticated direct UPDATE is denied'
);
select throws_ok(
  $$delete from public.shared_room_memberships$$,
  '42501', null, 'authenticated direct DELETE is denied'
);
reset role;

-- Membership discovery is independent of the collaboration redemption cap.
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000002', true);
select is(
  public.save_shared_room_for_me('cap-one-token'),
  jsonb_build_object('status', 'saved'),
  'first recipient saves a cap-one share'
);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000003', true);
select is(
  public.save_shared_room_for_me('cap-one-token'),
  jsonb_build_object('status', 'saved'),
  'second recipient can also save without consuming participant cap'
);
reset role;
select is(
  (select count(*) from public.dressing_room_participants
   where joined_via_share_id = '20000000-0000-0000-0000-000000000005'),
  0::bigint,
  'saving creates no collaboration participant'
);

-- Remove, restore, touch, revocation, and stale-row cleanup.
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000002', true);
select is(
  public.remove_shared_room_for_me('active-token-a'),
  jsonb_build_object('status', 'removed'),
  'recipient removes an active membership'
);
select is(
  public.remove_shared_room_for_me('active-token-a'),
  jsonb_build_object('status', 'removed'),
  'repeat remove is idempotent'
);
select is(
  public.touch_shared_room_for_me('active-token-a'),
  jsonb_build_object('status', 'unavailable'),
  'touch does not restore a removed membership'
);
select is(
  public.save_shared_room_for_me('active-token-a'),
  jsonb_build_object('status', 'restored'),
  'reopening a still-active link restores membership'
);
select is(
  public.touch_shared_room_for_me('active-token-a'),
  jsonb_build_object('status', 'touched'),
  'touch succeeds for an active non-removed membership'
);
reset role;

update public.room_shares
set is_active = false, revoked_at = clock_timestamp()
where id = '20000000-0000-0000-0000-000000000001';

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000002', true);
select results_eq(
  $$select share_token, title, item_count, status, room_updated_at is null
    from public.list_shared_rooms_for_me()
    where share_token = 'active-token-a'$$,
  $$values ('active-token-a'::text, null::text, 0::bigint, 'unavailable'::text, true)$$,
  'revoked membership remains removable but exposes no room metadata'
);
select is(
  public.touch_shared_room_for_me('active-token-a'),
  jsonb_build_object('status', 'unavailable'),
  'revoked membership cannot be touched as active'
);
select is(
  public.save_shared_room_for_me('active-token-a'),
  jsonb_build_object('status', 'unavailable'),
  'revoked token cannot restore membership'
);
select is(
  public.remove_shared_room_for_me('active-token-a'),
  jsonb_build_object('status', 'removed'),
  'stale revoked membership can be removed'
);
select is(
  public.remove_shared_room_for_me('unknown-well-formed-token'),
  jsonb_build_object('status', 'removed'),
  'remove does not enumerate unknown well-formed tokens'
);
reset role;

-- Token rotation creates distinct membership state and never reactivates old state.
insert into public.room_shares (id, room_id, owner_id, share_token, is_active, max_redemptions)
values (
  '20000000-0000-0000-0000-000000000007',
  '10000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000001',
  'rotated-token-a',
  true,
  10
);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000002', true);
select is(
  public.save_shared_room_for_me('rotated-token-a'),
  jsonb_build_object('status', 'saved'),
  'rotated token creates a new membership'
);
reset role;
select is(
  (select count(*) from public.shared_room_memberships
   where recipient_user_id = '00000000-0000-0000-0000-000000000002'
     and share_id in (
       '20000000-0000-0000-0000-000000000001',
       '20000000-0000-0000-0000-000000000007'
     )),
  2::bigint,
  'old and rotated tokens have distinct rows'
);

-- Account-deletion transfer temporarily makes share owner non-canonical. Such a
-- link is unavailable and then cascades when the original Auth owner is deleted.
update public.dressing_rooms
set user_id = '00000000-0000-0000-0000-000000000003'
where id = '10000000-0000-0000-0000-000000000003';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000002', true);
select is(
  public.save_shared_room_for_me('empty-token'),
  jsonb_build_object('status', 'unavailable'),
  'ownership-stale share cannot create membership'
);
reset role;
update public.dressing_rooms
set user_id = '00000000-0000-0000-0000-000000000001'
where id = '10000000-0000-0000-0000-000000000003';

-- Recipient and parent deletion cascades.
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000004', true);
select is(
  public.save_shared_room_for_me('delete-token'),
  jsonb_build_object('status', 'saved'),
  'deletion fixture membership is saved'
);
reset role;
delete from auth.users where id = '00000000-0000-0000-0000-000000000004';
select is(
  (select count(*) from public.shared_room_memberships
   where recipient_user_id = '00000000-0000-0000-0000-000000000004'),
  0::bigint,
  'recipient account deletion cascades membership'
);

delete from public.room_shares where id = '20000000-0000-0000-0000-000000000005';
select is(
  (select count(*) from public.shared_room_memberships
   where share_id = '20000000-0000-0000-0000-000000000005'),
  0::bigint,
  'share deletion cascades memberships'
);

delete from public.dressing_rooms where id = '10000000-0000-0000-0000-000000000001';
select is(
  (select count(*) from public.shared_room_memberships
   where share_id in (
     '20000000-0000-0000-0000-000000000001',
     '20000000-0000-0000-0000-000000000007'
   )),
  0::bigint,
  'room deletion cascades through shares to memberships'
);

select * from finish();
rollback;
