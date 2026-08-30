-- Hostile audit for Dressing Room user blocking.
--
-- The canonical suite (dressing_room_user_blocking_test.sql) proves the feature
-- WORKS. This file attacks it: every assertion below is an attempt to reach
-- something the block is supposed to have cut off, or to corrupt the block
-- itself. A passing run here means the attack was refused, not that a happy
-- path succeeded.
--
-- Each RLS-dependent assertion switches role explicitly (`set local role
-- authenticated`) in addition to setting request.jwt.claim.sub, because the
-- role running this file is superuser-like and would otherwise BYPASSRLS and
-- silently prove nothing. The `anon` and no-role cases switch role for the same
-- reason: a denial observed as a superuser is not a denial.
--
-- The whole file runs in one transaction and is rolled back.

begin;

select plan(32);

-- ── Fixture ──────────────────────────────────────────────────────────────────
-- alice owns ROOM_A. bob and carol are participants. dave is unrelated to
-- everyone. mallory is the attacker with no relationship to any of them.

insert into auth.users (id, email)
values
  ('00000000-0000-0000-0000-000000000201', 'hostile-alice@example.invalid'),
  ('00000000-0000-0000-0000-000000000202', 'hostile-bob@example.invalid'),
  ('00000000-0000-0000-0000-000000000203', 'hostile-carol@example.invalid'),
  ('00000000-0000-0000-0000-000000000204', 'hostile-dave@example.invalid'),
  ('00000000-0000-0000-0000-000000000205', 'hostile-mallory@example.invalid');

insert into public.dressing_rooms (id, user_id, title)
values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000201', 'Hostile Room A');

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end;
$$;

-- Participants must arrive through a real share redemption: room access is
-- derived from the joined_via_share_id chain, so a hand-inserted participant
-- row would have no access to lose and the block assertions would be vacuous.
insert into public.room_shares (id, room_id, owner_id, share_token, max_redemptions)
values ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1',
        '00000000-0000-0000-0000-000000000201', 'pgtap_hostile_room_a', 10);

select pg_temp.act_as('00000000-0000-0000-0000-000000000202');
select public.join_room_via_share_token('pgtap_hostile_room_a');
select pg_temp.act_as('00000000-0000-0000-0000-000000000203');
select public.join_room_via_share_token('pgtap_hostile_room_a');

-- ── 1. Anonymous access is refused everywhere ────────────────────────────────

set local role anon;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '', true);

select throws_ok(
  $$ select public.block_dressing_room_user('00000000-0000-0000-0000-000000000202') $$,
  '42501', null,
  'anonymous cannot create a block'
);
select throws_ok(
  $$ select public.unblock_dressing_room_user('00000000-0000-0000-0000-000000000202') $$,
  '42501', null,
  'anonymous cannot remove a block'
);
select throws_ok(
  $$ select * from public.list_dressing_room_blocked_users() $$,
  '42501', null,
  'anonymous cannot enumerate blocks'
);
-- Not merely an empty result: anon has no privilege on the table at all, so
-- the read is refused before RLS is even consulted.
select throws_ok(
  $$ select 1 from public.dressing_room_user_blocks $$,
  '42501', null,
  'anonymous cannot read the block table at all'
);
select throws_ok(
  $$ select internal.is_dressing_room_pair_blocked(
       '00000000-0000-0000-0000-000000000201',
       '00000000-0000-0000-0000-000000000202') $$,
  '42501', null,
  'anonymous cannot call the internal predicate directly'
);
reset role;

-- ── 2. Self-block and malformed input are refused ────────────────────────────

set local role authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-000000000201');

select throws_ok(
  $$ select public.block_dressing_room_user('00000000-0000-0000-0000-000000000201') $$,
  '22023',
  'This Dressing Room interaction is unavailable',
  'a user cannot block themselves'
);
select throws_ok(
  $$ select public.block_dressing_room_user(null) $$,
  '22023',
  'This Dressing Room interaction is unavailable',
  'a null target is refused'
);
select throws_ok(
  $$ select public.block_dressing_room_user('00000000-0000-0000-0000-0000000009ff') $$,
  '42501',
  'This Dressing Room interaction is unavailable',
  'a target with no shared interaction is refused'
);
select throws_ok(
  $$ select public.block_dressing_room_user('00000000-0000-0000-0000-000000000204') $$,
  '42501',
  'This Dressing Room interaction is unavailable',
  'an unrelated real user cannot be blocked'
);
reset role;

-- ── 3. A real block takes effect ─────────────────────────────────────────────

set local role authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-000000000201');
select lives_ok(
  $$ select public.block_dressing_room_user('00000000-0000-0000-0000-000000000202') $$,
  'alice can block a participant she has interacted with'
);
select is(
  (select count(*)::int from public.dressing_room_user_blocks
    where blocker_user_id = '00000000-0000-0000-0000-000000000201'
      and blocked_user_id = '00000000-0000-0000-0000-000000000202'),
  1,
  'exactly one block row exists'
);

-- Repeating the block is safe and does not duplicate.
select lives_ok(
  $$ select public.block_dressing_room_user('00000000-0000-0000-0000-000000000202') $$,
  'a repeated block is idempotent, not an error'
);
select is(
  (select count(*)::int from public.dressing_room_user_blocks
    where blocker_user_id = '00000000-0000-0000-0000-000000000201'
      and blocked_user_id = '00000000-0000-0000-0000-000000000202'),
  1,
  'a repeated block still leaves exactly one row'
);
reset role;

-- ── 4. The blocked user loses access ─────────────────────────────────────────

set local role authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-000000000202');

select is(
  (select public.can_access_room_messages('00000000-0000-0000-0000-0000000000a1')),
  false,
  'a blocked participant can no longer read room messages'
);
select throws_ok(
  $$ select public.create_dressing_room_message(
       '00000000-0000-0000-0000-0000000000a1',
       'let me back in',
       '00000000-0000-0000-0000-0000000000c1',
       null) $$,
  null, null,
  'a blocked participant cannot post a message'
);
select is(
  (select left_at is not null from public.dressing_room_participants
    where dressing_room_id = '00000000-0000-0000-0000-0000000000a1'
      and user_id = '00000000-0000-0000-0000-000000000202'),
  true,
  'the blocked participant is marked as having left'
);
reset role;

-- ── 5. Cross-user isolation of the block records themselves ──────────────────

set local role authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-000000000202');
select is_empty(
  $$ select 1 from public.dressing_room_user_blocks $$,
  'the blocked user cannot see that a block exists'
);
select is_empty(
  $$ select 1 from public.list_dressing_room_blocked_users() $$,
  'the blocked user enumerates no blocks of their own'
);
reset role;

set local role authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-000000000205');
select is_empty(
  $$ select 1 from public.dressing_room_user_blocks $$,
  'an unrelated user reads no block rows'
);
-- UUID substitution: mallory names the real pair and still gets nothing.
select is_empty(
  $$ select 1 from public.dressing_room_user_blocks
     where blocker_user_id = '00000000-0000-0000-0000-000000000201'
       and blocked_user_id = '00000000-0000-0000-0000-000000000202' $$,
  'naming the exact blocker/blocked pair does not disclose the row'
);
-- Scoped to the caller's own blocks, so this succeeds and removes nothing.
-- What matters is that it cannot reach alice's row.
select is(
  (select (public.unblock_dressing_room_user('00000000-0000-0000-0000-000000000202') ->> 'removed')::boolean),
  false,
  'an unrelated user removes nothing when lifting someone else''s block'
);
reset role;
select is(
  (select count(*)::int from public.dressing_room_user_blocks),
  1,
  'the block survives the unrelated unblock attempt'
);
set local role authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-000000000205');
reset role;

-- Forging a block row directly, on someone else's behalf, is refused by RLS.
set local role authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-000000000205');
select throws_ok(
  $$ insert into public.dressing_room_user_blocks (blocker_user_id, blocked_user_id)
     values ('00000000-0000-0000-0000-000000000201',
             '00000000-0000-0000-0000-000000000203') $$,
  '42501',
  null,
  'a user cannot insert a block attributed to someone else'
);
select lives_ok(
  $$ delete from public.dressing_room_user_blocks
     where blocker_user_id = '00000000-0000-0000-0000-000000000201' $$,
  'a direct cross-user delete runs but sees no rows'
);
reset role;
select is(
  (select count(*)::int from public.dressing_room_user_blocks
    where blocker_user_id = '00000000-0000-0000-0000-000000000201'),
  1,
  'the targeted block row is still there after the direct delete attempt'
);
set local role authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-000000000205');
reset role;

-- ── 6. Unrelated participants are unaffected ─────────────────────────────────

set local role authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-000000000203');
select is(
  (select public.can_access_room_messages('00000000-0000-0000-0000-0000000000a1')),
  true,
  'a co-participant unrelated to the block keeps access'
);
select is(
  (select left_at is null from public.dressing_room_participants
    where dressing_room_id = '00000000-0000-0000-0000-0000000000a1'
      and user_id = '00000000-0000-0000-0000-000000000203'),
  true,
  'the unrelated co-participant was not marked as having left'
);
reset role;

-- ── 7. Unblock restores only what it should ──────────────────────────────────

set local role authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-000000000201');
select lives_ok(
  $$ select public.unblock_dressing_room_user('00000000-0000-0000-0000-000000000202') $$,
  'the blocker can lift their own block'
);
select is(
  (select count(*)::int from public.dressing_room_user_blocks
    where blocker_user_id = '00000000-0000-0000-0000-000000000201'),
  0,
  'the block row is gone'
);
-- Unblocking twice is safe.
select lives_ok(
  $$ select public.unblock_dressing_room_user('00000000-0000-0000-0000-000000000202') $$,
  'a repeated unblock is idempotent'
);
reset role;

set local role authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-000000000202');
select is(
  (select left_at is not null from public.dressing_room_participants
    where dressing_room_id = '00000000-0000-0000-0000-0000000000a1'
      and user_id = '00000000-0000-0000-0000-000000000202'),
  true,
  'unblocking does NOT silently restore the participant row'
);
select is(
  (select public.can_access_room_messages('00000000-0000-0000-0000-0000000000a1')),
  false,
  'unblocking alone does not restore room access — a fresh invitation is required'
);
reset role;

select * from finish();
rollback;
