begin;

select plan(48);

-- RLS-dependent assertions in this file explicitly `set local role authenticated`
-- around themselves (in addition to set_config('request.jwt.claim.sub', ...)):
-- the role that applies migrations/runs this file is typically a superuser-like
-- role with BYPASSRLS, so exercising RLS for real (not just SECURITY DEFINER
-- RPC checks, which enforce auth.uid() explicitly in code regardless of role)
-- requires actually switching role, not just the JWT claim GUC.

-- Disposable identities and rooms for runtime RPC/RLS verification. The
-- enclosing transaction is rolled back by this test file.
insert into auth.users (id, email)
values
  ('00000000-0000-0000-0000-000000000101', 'drub-owner1@example.invalid'),
  ('00000000-0000-0000-0000-000000000102', 'drub-p1@example.invalid'),
  ('00000000-0000-0000-0000-000000000103', 'drub-p2-unrelated@example.invalid'),
  ('00000000-0000-0000-0000-000000000104', 'drub-owner2@example.invalid'),
  ('00000000-0000-0000-0000-000000000105', 'drub-p3@example.invalid'),
  ('00000000-0000-0000-0000-000000000106', 'drub-owner3@example.invalid'),
  ('00000000-0000-0000-0000-000000000107', 'drub-p4@example.invalid'),
  ('00000000-0000-0000-0000-000000000108', 'drub-p5@example.invalid'),
  ('00000000-0000-0000-0000-000000000109', 'drub-unrelated-stranger@example.invalid');

-- ROOM1: owner1 + p1 + p2 (unrelated), same share link.
insert into public.dressing_rooms (id, user_id, title)
values ('10000000-0000-0000-0000-000000000101', '00000000-0000-0000-0000-000000000101', 'Blocking fixture room 1');

insert into public.room_shares (id, room_id, owner_id, share_token, max_redemptions)
values ('20000000-0000-0000-0000-000000000101', '10000000-0000-0000-0000-000000000101', '00000000-0000-0000-0000-000000000101', 'pgtap_block_room1', 10);

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000102', true);
select public.join_room_via_share_token('pgtap_block_room1');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000103', true);
select public.join_room_via_share_token('pgtap_block_room1');

-- ROOM2: owner2 + p3.
insert into public.dressing_rooms (id, user_id, title)
values ('10000000-0000-0000-0000-000000000102', '00000000-0000-0000-0000-000000000104', 'Blocking fixture room 2');

insert into public.room_shares (id, room_id, owner_id, share_token, max_redemptions)
values ('20000000-0000-0000-0000-000000000102', '10000000-0000-0000-0000-000000000102', '00000000-0000-0000-0000-000000000104', 'pgtap_block_room2', 10);

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000105', true);
select public.join_room_via_share_token('pgtap_block_room2');

-- ROOM3: owner3 + p4 + p5 (non-owner co-participants for case C).
insert into public.dressing_rooms (id, user_id, title)
values ('10000000-0000-0000-0000-000000000103', '00000000-0000-0000-0000-000000000106', 'Blocking fixture room 3');

insert into public.room_shares (id, room_id, owner_id, share_token, max_redemptions)
values ('20000000-0000-0000-0000-000000000103', '10000000-0000-0000-0000-000000000103', '00000000-0000-0000-0000-000000000106', 'pgtap_block_room3', 10);

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000107', true);
select public.join_room_via_share_token('pgtap_block_room3');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000108', true);
select public.join_room_via_share_token('pgtap_block_room3');

-- ── Table shape / privilege checks ───────────────────────────────────────

select ok(
  (select relrowsecurity from pg_class where oid = 'public.dressing_room_user_blocks'::regclass),
  'dressing_room_user_blocks RLS is enabled'
);

select is(
  (select count(*) from pg_policies where schemaname = 'public' and tablename = 'dressing_room_user_blocks'),
  3::bigint,
  'dressing_room_user_blocks has exactly select/insert/delete-own policies'
);

select is(
  (select count(*) from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'dressing_room_user_blocks' and grantee = 'anon'),
  0::bigint,
  'anon has no dressing_room_user_blocks privileges'
);

select is(
  (select pronamespace::regnamespace::text from pg_proc where proname = 'is_dressing_room_pair_blocked'),
  'internal',
  'is_dressing_room_pair_blocked lives in the unexposed internal schema'
);

select is(
  has_function_privilege('anon', 'internal.is_dressing_room_pair_blocked(uuid,uuid)', 'execute'),
  false,
  'anon cannot execute is_dressing_room_pair_blocked'
);

select is(
  has_function_privilege('anon', 'internal.lock_dressing_room_pair(uuid,uuid)', 'execute'),
  false,
  'anon cannot execute lock_dressing_room_pair'
);

select is(
  has_function_privilege('authenticated', 'internal.lock_dressing_room_pair(uuid,uuid)', 'execute'),
  false,
  'authenticated cannot execute lock_dressing_room_pair directly (owner-only internal helper)'
);

-- ── Create own block / self-block / forgery / idempotency ───────────────

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000101', true);
select throws_ok(
  $$select public.block_dressing_room_user('00000000-0000-0000-0000-000000000101')$$,
  '22023',
  null,
  'self-block is rejected'
);

select throws_ok(
  $$select public.block_dressing_room_user('00000000-0000-0000-0000-000000000109')$$,
  '42501',
  'This Dressing Room interaction is unavailable',
  'blocking a stranger with no Dressing Room interaction is rejected'
);

select lives_ok(
  $$select public.block_dressing_room_user('00000000-0000-0000-0000-000000000102')$$,
  'owner1 blocks p1 (a real participant) succeeds'
);

select is(
  (select count(*) from public.dressing_room_user_blocks
   where blocker_user_id = '00000000-0000-0000-0000-000000000101'
     and blocked_user_id = '00000000-0000-0000-0000-000000000102'),
  1::bigint,
  'exactly one block row was created'
);

select lives_ok(
  $$select public.block_dressing_room_user('00000000-0000-0000-0000-000000000102')$$,
  'duplicate block is idempotent (no error)'
);

select is(
  (select count(*) from public.dressing_room_user_blocks
   where blocker_user_id = '00000000-0000-0000-0000-000000000101'
     and blocked_user_id = '00000000-0000-0000-0000-000000000102'),
  1::bigint,
  'duplicate block did not create a second row'
);

-- Direct-table forgery attempt: cannot insert a block on someone else's behalf.
-- RLS must actually be enforced (not bypassed by a superuser role) to prove this.
set local role authenticated;
select throws_ok(
  $$insert into public.dressing_room_user_blocks (blocker_user_id, blocked_user_id)
    values ('00000000-0000-0000-0000-000000000109', '00000000-0000-0000-0000-000000000102')$$,
  '42501',
  null,
  'direct insert forging another account as blocker is denied by RLS'
);

-- ── Read/enumerate privacy (also requires the authenticated role for RLS) ─

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000101', true);
select is(
  (select count(*) from public.dressing_room_user_blocks),
  1::bigint,
  'owner1 can see the block row it created'
);

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000102', true);
select is(
  (select count(*) from public.dressing_room_user_blocks),
  0::bigint,
  'the blocked account (p1) cannot enumerate who blocked them'
);

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000109', true);
select is(
  (select count(*) from public.dressing_room_user_blocks),
  0::bigint,
  'an unrelated account cannot inspect the blocked pair'
);
reset role;

-- ── Unblock authorization ────────────────────────────────────────────────

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000102', true);
select is(
  (public.unblock_dressing_room_user('00000000-0000-0000-0000-000000000101')->>'removed')::boolean,
  false,
  'the blocked account cannot unblock (removes nothing; it did not create the row)'
);

select is(
  (select count(*) from public.dressing_room_user_blocks
   where blocker_user_id = '00000000-0000-0000-0000-000000000101'
     and blocked_user_id = '00000000-0000-0000-0000-000000000102'),
  1::bigint,
  'block row survives a non-blocker unblock attempt'
);

-- ── Owner blocks participant: message/room enforcement ───────────────────

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000102', true);
select is(
  (public.resolve_dressing_room_collaboration_access('10000000-0000-0000-0000-000000000101')->>'ok')::boolean,
  false,
  'blocked participant loses resolve_dressing_room_collaboration_access entirely'
);

select throws_ok(
  $$select public.create_dressing_room_message('10000000-0000-0000-0000-000000000101', 'hello', gen_random_uuid())$$,
  '42501',
  'Shared room is unavailable',
  'blocked participant cannot send a message via the RPC'
);

select throws_ok(
  $$select public.list_dressing_room_messages('10000000-0000-0000-0000-000000000101')$$,
  '42501',
  'Shared room is unavailable',
  'blocked participant cannot read messages via the RPC'
);

select is(
  public.can_access_room_messages('10000000-0000-0000-0000-000000000101'),
  false,
  'blocked participant is denied by can_access_room_messages (defense-in-depth RLS path)'
);

set local role authenticated;
select throws_ok(
  $$insert into public.dressing_room_messages (room_id, sender_id, body)
    values ('10000000-0000-0000-0000-000000000101', '00000000-0000-0000-0000-000000000102', 'bypass attempt')$$,
  '42501',
  null,
  'direct table insertion cannot bypass the block'
);
reset role;

select throws_ok(
  $$select public.join_room_via_share_token('pgtap_block_room1')$$,
  '42501',
  'Shared room is unavailable',
  'blocked participant cannot reopen the room by redeeming the existing link again'
);

-- Owner keeps the room and (empty) history; unaffected co-participant p2 is fine.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000101', true);
select is(
  (public.resolve_dressing_room_collaboration_access('10000000-0000-0000-0000-000000000101')->>'ok')::boolean,
  true,
  'owner retains room access after blocking a participant'
);

select ok(
  exists (select 1 from public.dressing_rooms where id = '10000000-0000-0000-0000-000000000101'),
  'owner''s room row itself is never deleted'
);

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000103', true);
select is(
  (public.resolve_dressing_room_collaboration_access('10000000-0000-0000-0000-000000000101')->>'ok')::boolean,
  true,
  'unrelated co-participant (p2) is unaffected by the owner-p1 block'
);

select lives_ok(
  $$select public.create_dressing_room_message('10000000-0000-0000-0000-000000000101', 'still here', gen_random_uuid())$$,
  'unrelated co-participant (p2) can still send messages'
);

-- New link from the same owner also cannot be redeemed while blocked.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000101', true);
select public.revoke_room_share('10000000-0000-0000-0000-000000000101');
insert into public.room_shares (id, room_id, owner_id, share_token, max_redemptions)
values ('20000000-0000-0000-0000-000000000199', '10000000-0000-0000-0000-000000000101', '00000000-0000-0000-0000-000000000101', 'pgtap_block_room1_newlink', 10);

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000102', true);
select throws_ok(
  $$select public.join_room_via_share_token('pgtap_block_room1_newlink')$$,
  '42501',
  'Shared room is unavailable',
  'a brand-new link from the same owner cannot be redeemed by the blocked account'
);

-- ── Unrelated Dressing Room is unaffected ────────────────────────────────

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000105', true);
select is(
  (public.resolve_dressing_room_collaboration_access('10000000-0000-0000-0000-000000000102')->>'ok')::boolean,
  true,
  'an unrelated Dressing Room (room2, p3/owner2) is unaffected by the owner1-p1 block'
);

-- ── Participant blocks owner: both directions denied, owner keeps history ─

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000105', true);
select lives_ok(
  $$select public.block_dressing_room_user('00000000-0000-0000-0000-000000000104')$$,
  'participant (p3) blocks the room owner (owner2)'
);

select is(
  (public.resolve_dressing_room_collaboration_access('10000000-0000-0000-0000-000000000102')->>'ok')::boolean,
  false,
  'p3 loses access to owner2''s room after blocking owner2'
);

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000104', true);
select is(
  (public.resolve_dressing_room_collaboration_access('10000000-0000-0000-0000-000000000102')->>'canMessage')::boolean,
  false,
  'owner2 cannot send new messages: the sole participant (p3) is blocked (message denial in both directions)'
);

select is(
  (public.resolve_dressing_room_collaboration_access('10000000-0000-0000-0000-000000000102')->>'ok')::boolean,
  true,
  'owner2 still has ok=true (room + history preserved) despite canMessage=false'
);

select lives_ok(
  $$select public.list_dressing_room_messages('10000000-0000-0000-0000-000000000102')$$,
  'owner2 can still read existing message history'
);

select throws_ok(
  $$select public.create_dressing_room_message('10000000-0000-0000-0000-000000000102', 'blocked send', gen_random_uuid())$$,
  '42501',
  'Shared room is unavailable',
  'owner2 cannot send a new message when the sole participant is blocked'
);

-- Neutral error: owner2 gets no indication of who blocked whom.
select throws_matching(
  $$select public.create_dressing_room_message('10000000-0000-0000-0000-000000000102', 'blocked send', gen_random_uuid())$$,
  '^Shared room is unavailable$',
  'the denial message is neutral and does not disclose block direction'
);

-- ── Unblock does not auto-restore access; fresh invitation works ─────────

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000105', true);
select is(
  (public.unblock_dressing_room_user('00000000-0000-0000-0000-000000000104')->>'removed')::boolean,
  true,
  'p3 (the blocker) can remove its own block'
);

select is(
  (public.resolve_dressing_room_collaboration_access('10000000-0000-0000-0000-000000000102')->>'ok')::boolean,
  false,
  'unblocking does NOT automatically restore p3''s old participant row / room access'
);

select lives_ok(
  $$select public.join_room_via_share_token('pgtap_block_room2')$$,
  'a fresh invitation (redeeming the still-active link again) restores access normally after unblock'
);

select is(
  (public.resolve_dressing_room_collaboration_access('10000000-0000-0000-0000-000000000102')->>'ok')::boolean,
  true,
  'p3 has normal access again only after the fresh redemption, not automatically from unblocking'
);

-- ── Non-owner blocks non-owner co-participant (case C) ────────────────────

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000107', true);
select lives_ok(
  $$select public.block_dressing_room_user('00000000-0000-0000-0000-000000000108')$$,
  'p4 (non-owner) blocks p5 (non-owner co-participant) in room3'
);

select is(
  (select left_at is not null from public.dressing_room_participants
   where dressing_room_id = '10000000-0000-0000-0000-000000000103'
     and user_id = '00000000-0000-0000-0000-000000000107'),
  true,
  'p4 (the blocker) voluntarily left room3 (left_at set on p4''s own row)'
);

select is(
  (select left_at from public.dressing_room_participants
   where dressing_room_id = '10000000-0000-0000-0000-000000000103'
     and user_id = '00000000-0000-0000-0000-000000000108'),
  null,
  'p5 (the target, a third party from the room''s perspective) was NOT removed from the room'
);

select is(
  (public.resolve_dressing_room_collaboration_access('10000000-0000-0000-0000-000000000103')->>'ok')::boolean,
  false,
  'p4 (blocker) no longer has access to room3 after voluntarily leaving'
);

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000108', true);
select is(
  (public.resolve_dressing_room_collaboration_access('10000000-0000-0000-0000-000000000103')->>'ok')::boolean,
  true,
  'p5 still has access to room3 (never removed by another participant''s block)'
);

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000106', true);
select is(
  (public.resolve_dressing_room_collaboration_access('10000000-0000-0000-0000-000000000103')->>'ok')::boolean,
  true,
  'room3''s owner is completely unaffected by a block between two of their participants'
);

-- ── Room-metadata (Shared with Me) visibility is also gated ──────────────

insert into public.dressing_rooms (id, user_id, title)
values ('10000000-0000-0000-0000-000000000104', '00000000-0000-0000-0000-000000000101', 'Blocking fixture room 4 (metadata path)');

insert into public.room_shares (id, room_id, owner_id, share_token, max_redemptions)
values ('20000000-0000-0000-0000-000000000104', '10000000-0000-0000-0000-000000000104', '00000000-0000-0000-0000-000000000101', 'pgtap_block_room4_meta', 10);

insert into public.shared_room_memberships (share_id, recipient_user_id)
values ('20000000-0000-0000-0000-000000000104', '00000000-0000-0000-0000-000000000102');

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000102', true);
select is(
  (select count(*) from public.dressing_rooms where id = '10000000-0000-0000-0000-000000000104'),
  0::bigint,
  'blocked account cannot see room metadata via the Shared-with-Me path either (owner1-p1 block already active)'
);
reset role;

-- ── Concurrency: lock ordering is deterministic regardless of call order ─

select is(
  (select case when '00000000-0000-0000-0000-000000000101' < '00000000-0000-0000-0000-000000000102'
    then hashtextextended('00000000-0000-0000-0000-000000000101:00000000-0000-0000-0000-000000000102', 0)
    else hashtextextended('00000000-0000-0000-0000-000000000102:00000000-0000-0000-0000-000000000101', 0)
   end),
  (select case when '00000000-0000-0000-0000-000000000102' < '00000000-0000-0000-0000-000000000101'
    then hashtextextended('00000000-0000-0000-0000-000000000102:00000000-0000-0000-0000-000000000101', 0)
    else hashtextextended('00000000-0000-0000-0000-000000000101:00000000-0000-0000-0000-000000000102', 0)
   end),
  'the sorted-pair lock key is identical regardless of argument order'
);

select * from finish();
rollback;
