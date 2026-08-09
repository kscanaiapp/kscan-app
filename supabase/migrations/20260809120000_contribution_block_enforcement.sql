-- Dressing Room blocking: close the item-contribution bypass.
--
-- APPLIED TO PRODUCTION wyyuqfdxucjksghsmhry ("KScan App Production") on
-- 2026-08-09 under owner authorization, recorded in the migration ledger as
-- version 20260809102805, name `contribution_block_enforcement`. The applied
-- version stamp differs from this filename because the deployment tool stamps
-- its own timestamp; that is the established convention for this project (see
-- the three Build 25 migrations applied 2026-08-08). Do not re-apply.
--
-- WHAT WAS WRONG
--
-- 20260806153233_dressing_room_user_blocking.sql retrofitted
-- internal.is_dressing_room_pair_blocked() into every messaging and access
-- path — resolve_dressing_room_collaboration_access(),
-- can_access_room_messages() (the RLS predicate on dressing_room_messages),
-- and join_room_via_share_token(). It did not reach
-- can_contribute_to_dressing_room(), which had been introduced earlier by
-- 20260725100000_shared_room_item_contributions.sql and is the predicate
-- behind three RLS policies on dressing_room_items:
--
--   "Active participants can insert room items"   (INSERT)
--   "Contributors can update own room items"      (UPDATE)
--   "Contributors can delete own room items"      (DELETE)
--
-- block_dressing_room_user() marks participant rows left_at = now() rather
-- than deleting them, and deliberately does not revoke the share
-- (unblock must not silently restore access; a fresh redemption is required).
-- can_contribute_to_dressing_room() checked neither left_at nor the block, so
-- a blocked participant still satisfied it for as long as the share stayed
-- active.
--
-- Net effect: after "Block user", the blocked account could no longer read or
-- send messages in the room, but could still INSERT items into it by calling
-- PostgREST directly. The in-app confirmation copy promises "They will no
-- longer be able to access shared Dressing Rooms with you", so this was a
-- harassment vector that contradicted a user-facing safety guarantee.
--
-- Verified read-only against production 2026-08-09: 0 block rows and 0
-- participants with left_at set, so no account was ever affected. The gap was
-- latent, not exploited.
--
-- THE FIX
--
-- Bring the contribution predicate in line with can_access_room_messages():
-- require an active (not-left) participant row, bind the share to the room
-- owner, and consult the same block helper. The owner branch is unchanged —
-- an owner always contributes to their own room, and an owner blocked by every
-- participant keeps their own room usable (this mirrors canView staying true
-- in resolve_dressing_room_collaboration_access).
--
-- Signature, volatility, security context, search_path and grants are all
-- preserved, so the three RLS policies keep working untouched and no policy is
-- dropped or recreated. Replacing the function body is the whole change.

-- This migration reads internal.is_dressing_room_pair_blocked(), created by
-- 20260806153233_dressing_room_user_blocking.sql, which sorts earlier and so
-- always precedes this one in a from-scratch replay. The schema line below
-- keeps the migration set replayable on its own terms (and satisfies the
-- repo-wide guard in __tests__/dressingRoomBlockingUi.test.js); the assertion
-- after it turns a missing helper into a readable failure instead of a bare
-- "function internal.is_dressing_room_pair_blocked does not exist" surfacing
-- later from inside an RLS predicate.
create schema if not exists internal;

do $$
begin
  if to_regprocedure('internal.is_dressing_room_pair_blocked(uuid, uuid)') is null then
    raise exception
      'internal.is_dressing_room_pair_blocked(uuid,uuid) is missing; apply 20260806153233_dressing_room_user_blocking.sql first';
  end if;
end;
$$;

create or replace function public.can_contribute_to_dressing_room(p_room_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and (
      exists (
        select 1
          from public.dressing_rooms dr
         where dr.id = p_room_id
           and dr.user_id = (select auth.uid())
      )
      or exists (
        select 1
          from public.dressing_room_participants drp
          join public.room_shares rs
            on rs.id = drp.joined_via_share_id
           and rs.room_id = p_room_id
          join public.dressing_rooms dr
            on dr.id = drp.dressing_room_id
         where drp.dressing_room_id = p_room_id
           and drp.user_id = (select auth.uid())
           -- A participant marked left (by a block, in either direction) is
           -- no longer a contributor. Added here; every other clause below
           -- already existed.
           and drp.left_at is null
           and rs.is_active = true
           and rs.revoked_at is null
           and (rs.expires_at is null or rs.expires_at > now())
           -- The share must have been issued by this room's current owner,
           -- matching can_access_room_messages().
           and rs.owner_id = dr.user_id
           and dr.user_id is distinct from (select auth.uid())
           -- The account-level block, in either direction.
           and not internal.is_dressing_room_pair_blocked(dr.user_id, drp.user_id)
      )
    );
$$;

-- Unchanged from 20260725100000; restated so the grant state is explicit
-- rather than inherited from whatever ran last.
revoke all on function public.can_contribute_to_dressing_room(uuid) from public;
revoke all on function public.can_contribute_to_dressing_room(uuid) from anon;
grant execute on function public.can_contribute_to_dressing_room(uuid) to authenticated;

comment on function public.can_contribute_to_dressing_room(uuid) is
  'Owner, or an active unblocked participant holding a live share issued by the current room owner. Backs the contributor INSERT/UPDATE/DELETE policies on dressing_room_items.';
