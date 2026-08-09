begin;

-- GP-004 — a blocked account must not be able to contribute items.
--
-- WHY THIS FILE EXISTS SEPARATELY. dressing_room_user_blocking_test.sql covers
-- the paths the blocking migration touched (messages, access resolution, share
-- redemption). It does not touch can_contribute_to_dressing_room(), and that
-- coverage gap is precisely why the item-contribution bypass survived: the
-- predicate was introduced by 20260725100000_shared_room_item_contributions.sql
-- and never revisited when blocking landed in 20260806153233.
--
-- Requires 20260809120000_contribution_block_enforcement.sql to be applied.
-- Applied to production wyyuqfdxucjksghsmhry on 2026-08-09 as ledger version
-- 20260809102805 (name: contribution_block_enforcement).
--
-- The eight assertions map one-to-one onto the eight required behaviours:
--   1 owner may contribute to their own room
--   2 active unblocked participant may contribute
--   3 unrelated stranger may not contribute
--   4 participant with left_at set may not contribute (no block involved)
--   5 blocked participant may not contribute
--   6 direct INSERT by a blocked participant is rejected by RLS itself
--   7 unblocking alone does not restore contribution
--   8 a fresh share redemption after unblock does restore it

-- 8 assertions follow. Keep this count in sync when adding or removing one:
-- pgTAP reports a plan mismatch (not a failure) when they diverge, which is
-- easy to read past in CI output.
select plan(8);

insert into auth.users (id, email)
values
  ('00000000-0000-0000-0000-000000000201', 'contrib-owner@example.invalid'),
  ('00000000-0000-0000-0000-000000000202', 'contrib-blocked@example.invalid'),
  ('00000000-0000-0000-0000-000000000203', 'contrib-departed@example.invalid'),
  ('00000000-0000-0000-0000-000000000204', 'contrib-stranger@example.invalid');

insert into public.dressing_rooms (id, user_id, title)
values ('10000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000000201', 'Contribution fixture room');

insert into public.room_shares (id, room_id, owner_id, share_token, max_redemptions)
values ('20000000-0000-0000-0000-000000000201', '10000000-0000-0000-0000-000000000201',
        '00000000-0000-0000-0000-000000000201', 'pgtap_contrib_room', 10);

-- Both participants redeem the same live share through the real RPC.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000202', true);
select public.join_room_via_share_token('pgtap_contrib_room');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000203', true);
select public.join_room_via_share_token('pgtap_contrib_room');

-- ── 1. Owner ────────────────────────────────────────────────────────────────
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000201', true);
select ok(
  public.can_contribute_to_dressing_room('10000000-0000-0000-0000-000000000201'),
  'the owner may contribute to their own room'
);

-- ── 2. Active unblocked participant ─────────────────────────────────────────
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000202', true);
select ok(
  public.can_contribute_to_dressing_room('10000000-0000-0000-0000-000000000201'),
  'an active unblocked participant on a live share may contribute'
);

-- ── 3. Unrelated stranger ───────────────────────────────────────────────────
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000204', true);
select ok(
  not public.can_contribute_to_dressing_room('10000000-0000-0000-0000-000000000201'),
  'an account that never joined may not contribute'
);

-- ── 4. Departed participant, no block anywhere ──────────────────────────────
-- Isolates the left_at guard from the block guard: this participant is not
-- blocked by anyone, they simply are not an active member any more.
update public.dressing_room_participants
   set left_at = now()
 where user_id = '00000000-0000-0000-0000-000000000203'
   and dressing_room_id = '10000000-0000-0000-0000-000000000201';

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000203', true);
select ok(
  not public.can_contribute_to_dressing_room('10000000-0000-0000-0000-000000000201'),
  'a participant whose membership has ended may not contribute, block or no block'
);

-- ── 5. Blocked participant ──────────────────────────────────────────────────
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000201', true);
select public.block_dressing_room_user('00000000-0000-0000-0000-000000000202');

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000202', true);
select ok(
  not public.can_contribute_to_dressing_room('10000000-0000-0000-0000-000000000201'),
  'GP-004: a blocked participant may not contribute despite the share staying live'
);

-- ── 6. RLS is the real boundary, so assert the policy and not only the helper.
-- snapshot_payload is NOT NULL with no default, so it must be supplied or the
-- insert would fail 23502 for an unrelated reason and prove nothing.
set local role authenticated;
select throws_ok(
  $$insert into public.dressing_room_items
      (dressing_room_id, created_by, snapshot_payload)
    values ('10000000-0000-0000-0000-000000000201',
            '00000000-0000-0000-0000-000000000202',
            '{}'::jsonb)$$,
  '42501',
  null,
  'GP-004: the contributor INSERT policy rejects a blocked participant'
);
reset role;

-- ── 7. Unblock alone must not restore contribution ──────────────────────────
-- block_dressing_room_user() marks left_at permanently; only a fresh
-- redemption while unblocked clears it, so deleting the block row is not
-- enough on its own.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000201', true);
select public.unblock_dressing_room_user('00000000-0000-0000-0000-000000000202');

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000202', true);
select ok(
  not public.can_contribute_to_dressing_room('10000000-0000-0000-0000-000000000201'),
  'unblocking alone does not restore contribution; a fresh redemption is required'
);

-- ── 8. The intended recovery path does work ─────────────────────────────────
-- join_room_via_share_token() clears left_at for a previously-departed
-- participant when the pair is not blocked. The repair must not have made
-- legitimate re-entry impossible.
select public.join_room_via_share_token('pgtap_contrib_room');
select ok(
  public.can_contribute_to_dressing_room('10000000-0000-0000-0000-000000000201'),
  'a fresh share redemption after unblock restores contribution'
);

select * from finish();
rollback;
