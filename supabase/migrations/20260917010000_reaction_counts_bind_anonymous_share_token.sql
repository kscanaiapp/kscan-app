-- B34-SEC-003 (supersedes/corrects #431's B34-SEC-001 form before production
-- promotion) — bind the anonymous branch of public.get_item_reaction_counts()
-- to the SPECIFIC live share the caller holds, not to "does this room have any
-- live share at all".
--
-- WHAT WAS STILL WRONG AFTER #431
--
-- #431 (applied to staging as reaction_counts_require_live_room_access)
-- correctly closed the authenticated non-owner leak: a removed member or an
-- unrelated authenticated account can no longer read reaction counts while
-- presenting their JWT. But the anonymous branch it left in place authorizes
-- on:
--
--   exists (a live room_shares row for this ROOM)
--
-- with no binding to any per-caller credential. The RPC takes only item ids,
-- no token. So the SAME removed member (or unrelated account, or anyone who
-- simply retains the item ids from before) just omits the Authorization header
-- -- auth.uid() becomes null -- and lands in the anonymous branch, which asks
-- nothing about who is calling. As long as the room has ANY live share
-- (routine; owners create public shares for reasons unrelated to any one
-- removed recipient), the removed-member fix #431 shipped is fully bypassed by
-- dropping the JWT. Removing identity must never be a privilege-escalation
-- path, and here it was one: "authenticated non-member" and "anonymous" must
-- not be reachable by the same caller with two different outcomes.
--
-- THE FIX
--
-- The anonymous branch now requires the caller to present the SAME live share
-- token get_public_room_preview(p_share_token) validates, checked against
-- room_shares.share_token for this specific room -- not merely that some share
-- exists. A stranger, a removed member, or anyone else who does not hold that
-- exact token gets nothing, exactly like get_public_room_preview already
-- behaves. A caller who legitimately holds the room's live share token --
-- because they opened or were sent the public share link -- keeps working:
-- that is the actual capability the public-share surface grants, and it is
-- unchanged. This is the same "share liveness is the bound" contract #431
-- described, just actually bound to the token rather than to room state alone.
--
-- This requires a parameter the anonymous public-share screen must pass.
-- app/(public)/rooms/[token].tsx already has the token in scope (it is the
-- route param) and is updated in the same change to thread it through
-- getItemReactionCounts(). No other caller is affected: the authenticated
-- in-app screen (app/dressing-rooms/[id].tsx) never had a token to send and
-- does not need one -- it resolves entirely through the authenticated branch,
-- which this migration does not change.
--
-- The one-argument signature is dropped outright rather than overloaded: two
-- coexisting signatures (uuid[] and uuid[], text) would let PostgREST resolve
-- to whichever overload matches the arguments a caller happens to send,
-- silently reviving the old anonymous predicate for any caller (including a
-- stale client) that still calls with item ids only. There must be exactly one
-- definition of this function.

drop function if exists public.get_item_reaction_counts(uuid[]);

create or replace function public.get_item_reaction_counts(
  p_item_ids uuid[],
  p_share_token text default null
)
returns table(item_id uuid, reaction_type text, count integer)
language sql
security definer
set search_path = pg_catalog, public
as $function$
  with caller as (
    select (select auth.uid()) as uid
  ),
  normalized_token as (
    select nullif(btrim(coalesce(p_share_token, '')), '') as token
  ),
  input_items as (
    select distinct dri.id as item_id
    from unnest(coalesce(p_item_ids, '{}'::uuid[])) as value
    join public.dressing_room_items dri on dri.id = value
    join public.dressing_rooms dr on dr.id = dri.dressing_room_id
    cross join caller
    cross join normalized_token
    where value is not null
      and (
        dr.user_id = caller.uid
        or (
          case
            when caller.uid is null then
              -- Anonymous public-preview reader must present the SAME live
              -- share token get_public_room_preview() validates for this
              -- room -- not merely "a" live share on it.
              normalized_token.token is not null
              and exists (
                select 1
                from public.room_shares rs
                where rs.room_id = dr.id
                  and rs.share_token = normalized_token.token
                  and rs.is_active = true
                  and rs.revoked_at is null
                  and (rs.expires_at is null or rs.expires_at > now())
              )
            else
              -- Authenticated non-owner: must currently hold access under one
              -- of the two governed recipient models. (#431 / B34-SEC-001)
              (
                exists (
                  select 1
                  from public.shared_room_memberships m
                  join public.room_shares rs on rs.id = m.share_id
                  where rs.room_id = dr.id
                    and m.recipient_user_id = caller.uid
                    and m.removed_at is null
                    and rs.is_active = true
                    and rs.revoked_at is null
                    and (rs.expires_at is null or rs.expires_at > now())
                )
                or public.can_access_room_messages(dr.id)
              )
              and not internal.is_dressing_room_pair_blocked(dr.user_id, caller.uid)
          end
        )
      )
  ),
  reaction_types as (
    select value as reaction_type
    from (values ('like'), ('love'), ('looking'), ('thumbs_down')) as reactions(value)
  ),
  counts as (
    select
      drir.item_id,
      drir.reaction_type,
      count(*)::integer as reaction_count
    from public.dressing_room_item_reactions drir
    join input_items ii
      on ii.item_id = drir.item_id
    group by drir.item_id, drir.reaction_type
  )
  select
    ii.item_id,
    rt.reaction_type,
    coalesce(c.reaction_count, 0)::integer as count
  from input_items ii
  cross join reaction_types rt
  left join counts c
    on c.item_id = ii.item_id
   and c.reaction_type = rt.reaction_type
  order by ii.item_id, rt.reaction_type;
$function$;

revoke all on function public.get_item_reaction_counts(uuid[], text) from public;
grant execute on function public.get_item_reaction_counts(uuid[], text) to anon;
grant execute on function public.get_item_reaction_counts(uuid[], text) to authenticated;

comment on function public.get_item_reaction_counts(uuid[], text) is
  'Aggregate reaction counts. Owner, an authenticated caller holding live access via shared_room_memberships or can_access_room_messages(), or an anonymous reader presenting the specific live share token for this room. Removed, blocked, and token-less anonymous callers are excluded.';
