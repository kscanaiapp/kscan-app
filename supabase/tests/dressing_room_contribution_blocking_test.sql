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
-- Assertions 1-4 are the defect itself. 5-8 are the non-regressions that make
-- the repair safe: owner, unrelated participant, stranger, and re-redemption.
--
-- Requires 20260809120000_contribution_block_enforcement.sql to be applied.

-- 8 assertions follow. Keep this count in sync when adding or removing one:
-- pgTAP reports a plan mismatch (not a failure) when they diverge, which is
-- easy to read past in CI output.
select plan(8);

insert into auth.users (id, email)
values
  ('00000000-0000-0000-0000-000000000201', 'contrib-owner@example.invalid'),
  ('00000000-0000-0000-0000-000000000202', 'contrib-blocked@example.invalid'),
  ('00000000-0000-0000-0000-000000000203', 'contrib-other@example.invalid'),
  ('00000000-0000-0000-0000-000000000204', 'contrib-stranger@example.invalid');

insert into public.dressing_rooms (id, user_id, title)
values ('10000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000000201', 'Contribution fixture room');

insert into public.room_shares (id, room_id, owner_id, share_token, max_redemptions)
values ('20000000-0000-0000-0000-000000000201', '10000000-0000-0000-0000-000000000201',
        '00000000-0000-0000-0000-000000000201', 'pgtap_contrib_room', 10);

-- Both participants redeem the same live share.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000202', true);
select public.join_room_via_share_token('pgtap_contrib_room');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000203', true);
select public.join_room_via_share_token('pgtap_contrib_room');

-- ── Baseline: an unblocked participant contributes ──────────────────────────
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000202', true);
select ok(
  public.can_contribute_to_dressing_room('10000000-0000-0000-0000-000000000201'),
  'an unblocked participant on a live share may contribute'
);

-- ── The owner blocks that participant ───────────────────────────────────────
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000201', true);
select public.block_dressing_room_user('00000000-0000-0000-0000-000000000202');

-- The share is deliberately NOT revoked by a block, so this is the exact state
-- the bypass depended on.
select ok(
  exists (
    select 1 from public.room_shares
     where id = '20000000-0000-0000-0000-000000000201'
       and is_active = true
       and revoked_at is null
  ),
  'blocking leaves the share itself active (unblock must not auto-restore access)'
);

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000202', true);
select ok(
  not public.can_contribute_to_dressing_room('10000000-0000-0000-0000-000000000201'),
  'GP-004: a blocked participant may NOT contribute items despite the live share'
);

-- RLS is the real boundary, so assert it and not only the helper.
set local role authenticated;
select throws_ok(
  $$insert into public.dressing_room_items (dressing_room_id, created_by)
    values ('10000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000000202')$$,
  '42501',
  null,
  'GP-004: the contributor INSERT policy rejects a blocked participant'
);
reset role;

-- ── Non-regressions ─────────────────────────────────────────────────────────
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000203', true);
select ok(
  public.can_contribute_to_dressing_room('10000000-0000-0000-0000-000000000201'),
  'a different, unblocked participant in the same room is unaffected'
);

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000201', true);
select ok(
  public.can_contribute_to_dressing_room('10000000-0000-0000-0000-000000000201'),
  'the owner still contributes to their own room after blocking someone'
);

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000204', true);
select ok(
  not public.can_contribute_to_dressing_room('10000000-0000-0000-0000-000000000201'),
  'an account that never joined may not contribute'
);

-- ── Unblock alone must not restore contribution ─────────────────────────────
-- block_dressing_room_user() marks left_at permanently; only a fresh
-- redemption while unblocked clears it. Deleting the block row must therefore
-- not be enough on its own.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000201', true);
select public.unblock_dressing_room_user('00000000-0000-0000-0000-000000000202');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000202', true);
select ok(
  not public.can_contribute_to_dressing_room('10000000-0000-0000-0000-000000000201'),
  'unblocking alone does not restore contribution; a fresh redemption is required'
);

select * from finish();
rollback;
