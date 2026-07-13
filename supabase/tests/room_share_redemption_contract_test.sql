begin;

select plan(43);

-- Disposable identities and rooms for runtime RPC verification. The enclosing
-- transaction is rolled back by this test file.
insert into auth.users (id, email)
values
  ('00000000-0000-0000-0000-000000000001', 'room-share-owner@example.invalid'),
  ('00000000-0000-0000-0000-000000000002', 'room-share-p1@example.invalid'),
  ('00000000-0000-0000-0000-000000000003', 'room-share-p2@example.invalid'),
  ('00000000-0000-0000-0000-000000000004', 'room-share-p3@example.invalid');

insert into auth.users (id, email)
select
  ('00000000-0000-0000-0000-' || lpad(participant_number::text, 12, '0'))::uuid,
  'room-share-p' || participant_number::text || '@example.invalid'
from generate_series(5, 12) as participant_number;

insert into public.dressing_rooms (id, user_id, title)
values
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'Unlimited contract fixture'),
  ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'Cap two contract fixture'),
  ('10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 'Schema contract fixture'),
  ('10000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000001', 'Cap ten contract fixture');

insert into public.room_shares (id, room_id, owner_id, share_token, max_redemptions)
values
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'pgtap_unlimited', null),
  ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'pgtap_cap_2', 2),
  ('20000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000001', 'pgtap_cap_10', 10);

select ok(
  exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'room_shares' and column_name = 'max_redemptions'
  ),
  'max_redemptions exists'
);

select is(
  (select is_nullable from information_schema.columns
   where table_schema = 'public' and table_name = 'room_shares' and column_name = 'max_redemptions'),
  'YES',
  'max_redemptions is nullable'
);

select is(
  (select column_default::text from information_schema.columns
   where table_schema = 'public' and table_name = 'room_shares' and column_name = 'max_redemptions'),
  '10',
  'max_redemptions defaults to 10'
);

select ok(
  (select pg_get_constraintdef(oid)
   from pg_constraint
   where conrelid = 'public.room_shares'::regclass
     and conname = 'room_shares_max_redemptions_positive_check')
    ~* 'max_redemptions IS NULL.*max_redemptions > 0',
  'final CHECK accepts NULL or a positive integer'
);

select ok(
  not exists (
    select 1 from pg_constraint
    where conrelid = 'public.room_shares'::regclass
      and conname = 'room_shares_max_redemptions_check'
  ),
  'obsolete upper-bound CHECK is absent'
);

select is(
  col_description(
    'public.room_shares'::regclass,
    (select ordinal_position from information_schema.columns
     where table_schema = 'public' and table_name = 'room_shares' and column_name = 'max_redemptions')
  ),
  'NULL denotes an unlimited legacy room-share link. Positive integers denote redemption-capped links. New links default to 10 redemptions.',
  'column comment documents dual semantics'
);

select lives_ok(
  $$insert into public.room_shares (room_id, owner_id, share_token, is_active, max_redemptions)
    values ('10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 'pgtap_accept_null', false, null)$$,
  'NULL is accepted'
);

select lives_ok(
  $$insert into public.room_shares (room_id, owner_id, share_token, is_active, max_redemptions)
    values ('10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 'pgtap_accept_1', false, 1)$$,
  'cap 1 is accepted'
);

select lives_ok(
  $$insert into public.room_shares (room_id, owner_id, share_token, is_active, max_redemptions)
    values ('10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 'pgtap_accept_2', false, 2)$$,
  'cap 2 is accepted'
);

select lives_ok(
  $$insert into public.room_shares (room_id, owner_id, share_token, is_active, max_redemptions)
    values ('10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 'pgtap_accept_10', false, 10)$$,
  'cap 10 is accepted'
);

select throws_ok(
  $$insert into public.room_shares (room_id, owner_id, share_token, is_active, max_redemptions)
    values ('10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 'pgtap_reject_0', false, 0)$$,
  '23514',
  null,
  'zero is rejected'
);

select throws_ok(
  $$insert into public.room_shares (room_id, owner_id, share_token, is_active, max_redemptions)
    values ('10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 'pgtap_reject_negative', false, -1)$$,
  '23514',
  null,
  'negative values are rejected'
);

select lives_ok(
  $$insert into public.room_shares (room_id, owner_id, share_token, is_active)
    values ('10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 'pgtap_default_10', false)$$,
  'omitting max_redemptions creates a capped row'
);

select is(
  (select max_redemptions from public.room_shares where share_token = 'pgtap_default_10'),
  10,
  'omitted max_redemptions resolves to 10'
);

-- Simulate the verified partial remote shape and apply the same final column
-- operations. The value fingerprint proves the convergence DDL rewrites no row.
create temporary table room_shares_partial_state (
  id integer primary key,
  max_redemptions integer
);

insert into room_shares_partial_state (id, max_redemptions)
values (1, null), (2, 2), (3, 10);

create temporary table room_shares_partial_before as
select md5(string_agg(id::text || ':' || coalesce(max_redemptions::text, '<NULL>'), '|' order by id)) as fingerprint
from room_shares_partial_state;

alter table room_shares_partial_state
  alter column max_redemptions drop not null,
  alter column max_redemptions set default 10;

alter table room_shares_partial_state
  add constraint room_shares_partial_positive_check
  check (max_redemptions is null or max_redemptions > 0);

select is(
  (select attnotnull from pg_attribute
   where attrelid = 'pg_temp.room_shares_partial_state'::regclass and attname = 'max_redemptions'),
  false,
  'partial-state convergence preserves nullability'
);

select is(
  (select pg_get_expr(adbin, adrelid)
   from pg_attrdef
   where adrelid = 'pg_temp.room_shares_partial_state'::regclass
     and adnum = (select attnum from pg_attribute
                  where attrelid = 'pg_temp.room_shares_partial_state'::regclass and attname = 'max_redemptions')),
  '10',
  'partial-state convergence sets default 10'
);

select ok(
  (select pg_get_constraintdef(oid)
   from pg_constraint
   where conrelid = 'pg_temp.room_shares_partial_state'::regclass
     and conname = 'room_shares_partial_positive_check')
    ~* 'max_redemptions IS NULL.*max_redemptions > 0',
  'partial-state convergence installs the same positive-or-NULL CHECK'
);

select is(
  (select md5(string_agg(id::text || ':' || coalesce(max_redemptions::text, '<NULL>'), '|' order by id))
   from room_shares_partial_state),
  (select fingerprint from room_shares_partial_before),
  'partial-state convergence preserves every row value'
);

select is(
  (select pg_get_expr(adbin, adrelid)
   from pg_attrdef
   where adrelid = 'pg_temp.room_shares_partial_state'::regclass
     and adnum = (select attnum from pg_attribute
                  where attrelid = 'pg_temp.room_shares_partial_state'::regclass and attname = 'max_redemptions')),
  (select column_default::text from information_schema.columns
   where table_schema = 'public' and table_name = 'room_shares' and column_name = 'max_redemptions'),
  'clean and partial-state defaults converge'
);

select is(
  not (select attnotnull from pg_attribute
       where attrelid = 'pg_temp.room_shares_partial_state'::regclass and attname = 'max_redemptions'),
  (select is_nullable = 'YES' from information_schema.columns
   where table_schema = 'public' and table_name = 'room_shares' and column_name = 'max_redemptions'),
  'clean and partial-state nullability converge'
);

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000002', true);
select is(
  public.join_room_via_share_token('pgtap_unlimited'),
  '10000000-0000-0000-0000-000000000001'::uuid,
  'first legacy NULL redemption succeeds'
);

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000003', true);
select is(
  public.join_room_via_share_token('pgtap_unlimited'),
  '10000000-0000-0000-0000-000000000001'::uuid,
  'second legacy NULL redemption succeeds'
);

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000004', true);
select is(
  public.join_room_via_share_token('pgtap_unlimited'),
  '10000000-0000-0000-0000-000000000001'::uuid,
  'legacy NULL redemption remains unlimited beyond two participants'
);

select is(
  (select count(*) from public.dressing_room_participants
   where joined_via_share_id = '20000000-0000-0000-0000-000000000001'),
  3::bigint,
  'legacy NULL share records all three participants'
);

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000002', true);
select is(
  public.join_room_via_share_token('pgtap_cap_2'),
  '10000000-0000-0000-0000-000000000002'::uuid,
  'first cap-2 redemption succeeds'
);

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000003', true);
select is(
  public.join_room_via_share_token('pgtap_cap_2'),
  '10000000-0000-0000-0000-000000000002'::uuid,
  'second cap-2 redemption succeeds'
);

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000004', true);
select throws_ok(
  $$select public.join_room_via_share_token('pgtap_cap_2')$$,
  '42501',
  'Shared room is full',
  'third cap-2 redemption is rejected'
);

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000002', true);
select is(
  public.join_room_via_share_token('pgtap_cap_2'),
  '10000000-0000-0000-0000-000000000002'::uuid,
  'existing cap-2 participant can reopen idempotently'
);

select is(
  (select count(*) from public.dressing_room_participants
   where joined_via_share_id = '20000000-0000-0000-0000-000000000002'),
  2::bigint,
  'cap-2 share remains capped at exactly two participants'
);

select lives_ok(
  $$do $test$
    declare
      participant_number integer;
    begin
      for participant_number in 2..11 loop
        perform set_config(
          'request.jwt.claim.sub',
          '00000000-0000-0000-0000-' || lpad(participant_number::text, 12, '0'),
          true
        );
        perform public.join_room_via_share_token('pgtap_cap_10');
      end loop;
    end
  $test$;$$,
  'the first ten cap-10 redemptions succeed'
);

select is(
  (select count(*) from public.dressing_room_participants
   where joined_via_share_id = '20000000-0000-0000-0000-000000000003'),
  10::bigint,
  'cap-10 share records exactly ten participants'
);

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000012', true);
select throws_ok(
  $$select public.join_room_via_share_token('pgtap_cap_10')$$,
  '42501',
  'Shared room is full',
  'the eleventh cap-10 redemption is rejected'
);

select is(
  (select relrowsecurity from pg_class where oid = 'public.room_shares'::regclass),
  true,
  'room_shares RLS remains enabled'
);

select is(
  (select count(*) from pg_policies where schemaname = 'public' and tablename = 'room_shares'),
  1::bigint,
  'room_shares owner policy count is unchanged'
);

select is(
  (select count(*) from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'room_shares' and grantee = 'anon'),
  0::bigint,
  'anonymous room_shares table privileges remain absent'
);

select is(
  (select prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'join_room_via_share_token'
     and pg_get_function_identity_arguments(p.oid) = 'p_share_token text'),
  true,
  'join RPC remains SECURITY DEFINER'
);

select ok(
  (select proconfig @> array['search_path=public'] from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'join_room_via_share_token'
     and pg_get_function_identity_arguments(p.oid) = 'p_share_token text'),
  'join RPC retains hardened search_path'
);

select is(
  has_function_privilege('public', 'public.join_room_via_share_token(text)', 'execute'),
  false,
  'PUBLIC cannot execute the join RPC'
);

select is(
  has_function_privilege('anon', 'public.join_room_via_share_token(text)', 'execute'),
  false,
  'anon cannot execute the join RPC'
);

select is(
  has_function_privilege('authenticated', 'public.join_room_via_share_token(text)', 'execute'),
  true,
  'authenticated can execute the guarded join RPC'
);

select ok(
  (select pg_get_functiondef(p.oid) ilike '%if target_max_redemptions is not null then%'
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'join_room_via_share_token'
     and pg_get_function_identity_arguments(p.oid) = 'p_share_token text'),
  'join RPC explicitly branches only for numeric caps'
);

select ok(
  (select pg_get_functiondef(p.oid) not ilike '%coalesce(target_max_redemptions%'
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'join_room_via_share_token'
     and pg_get_function_identity_arguments(p.oid) = 'p_share_token text'),
  'join RPC never maps NULL to zero'
);

select ok(
  (select pg_get_functiondef(p.oid) ~* 'max_redemptions[^;]*10'
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'create_or_get_room_share'
     and pg_get_function_identity_arguments(p.oid) = 'p_room_id uuid'),
  'new-link RPC explicitly creates cap-10 links'
);

select * from finish();
rollback;
