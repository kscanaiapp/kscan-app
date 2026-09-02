-- Build 34 Dressing Rooms deep audit -- DR-P3-001.
--
-- DEFECT. public.get_item_reaction_counts(uuid[]) admits any caller for whom
-- EITHER the room is theirs OR *some* active share exists on that room:
--
--     dr.user_id = auth.uid()
--     or exists (select 1 from public.room_shares rs
--                where rs.room_id = dr.id and rs.is_active ...)
--
-- The second branch is a property of the ROOM, not of the caller, so it never
-- consulted the Dressing Room block relation. Every other read path was taught
-- the block in 20260806153233_dressing_room_user_blocking.sql and
-- 20260815233353_dressing_room_items_blocking.sql; this one was missed.
--
-- Proven against app staging (yzqjvdfgefveprobvvyw) on 2026-09-02 with three
-- synthetic accounts. After the room owner blocked a participant, that
-- participant read 0 rooms, 0 items, 0 messages and 0 reaction rows, and
-- resolve_dressing_room_collaboration_access returned 'unauthorized' -- yet
-- get_item_reaction_counts still returned all 4 reaction rows for an item in
-- the room they had just been blocked out of. A foreign authenticated account
-- with no relationship to the room got the same 4 rows.
--
-- IMPACT. A blocked account keeps a live read channel into a room it was
-- removed from: repeated polling of item ids it captured before the block
-- reports ongoing activity in that room. Aggregate counts only -- no identities
-- and no bodies -- and it needs the item UUIDs, so this is a residual read
-- channel rather than a disclosure of new content. It nonetheless contradicts
-- the in-app promise that a blocked account can no longer access shared
-- Dressing Rooms with you, which is the same class of gap
-- 20260809120000_contribution_block_enforcement.sql closed for contributions.
--
-- THE FIX. One additional conjunct on the share branch, transcribed from the
-- working dressing_room_items recipient policy so the two cannot disagree
-- about what "blocked" means.
--
-- ANONYMOUS CALLERS ARE DELIBERATELY UNAFFECTED. Link-share preview is an
-- anonymous surface by construction: get_item_reaction_counts holds EXECUTE for
-- anon, and app/(public)/rooms/[token].tsx fetches the preview over an
-- unauthenticated request, so the database is never told who is asking. With
-- auth.uid() null, internal.is_dressing_room_pair_blocked() matches no rows and
-- returns false, so `not false` leaves the predicate true and the public
-- preview keeps rendering counts exactly as before. Blocking an account can
-- therefore still not retract a raw share link -- revoking the link is what
-- does that -- and this migration does not claim otherwise. It closes the
-- AUTHENTICATED blocked-actor path, which is the one the block controls.
--
-- Owner branch, return type, language, volatility, security context,
-- search_path and grants are all preserved. Replacing the body is the whole
-- change; nothing that calls this function is dropped or recreated.

-- This migration reads internal.is_dressing_room_pair_blocked(), created by
-- 20260806153233_dressing_room_user_blocking.sql, which sorts earlier and so
-- always precedes this one in a from-scratch replay. The schema line keeps the
-- migration set replayable on its own terms (and satisfies the repo-wide guard
-- in __tests__/dressingRoomBlockingUi.test.js); the assertion after it turns a
-- missing helper into a readable failure instead of a bare "function does not
-- exist" surfacing later from inside this function.
create schema if not exists internal;

do $$
begin
  if to_regprocedure('internal.is_dressing_room_pair_blocked(uuid, uuid)') is null then
    raise exception
      'internal.is_dressing_room_pair_blocked(uuid,uuid) is missing; apply 20260806153233_dressing_room_user_blocking.sql first';
  end if;
end;
$$;

create or replace function public.get_item_reaction_counts(p_item_ids uuid[])
returns table(item_id uuid, reaction_type text, count integer)
language sql
security definer
set search_path to 'public'
as $function$
  with input_items as (
    select distinct dri.id as item_id
    from unnest(coalesce(p_item_ids, '{}'::uuid[])) as value
    join public.dressing_room_items dri on dri.id = value
    join public.dressing_rooms dr on dr.id = dri.dressing_room_id
    where value is not null
      and (
        dr.user_id = auth.uid()
        or (
          exists (
            select 1
            from public.room_shares rs
            where rs.room_id = dr.id
              and rs.is_active = true
              and rs.revoked_at is null
              and (rs.expires_at is null or rs.expires_at > now())
          )
          -- The account-level block, in either direction. A null auth.uid()
          -- (anonymous link-preview visitor) matches no block row, so this
          -- conjunct is true for them and the public preview is unchanged.
          and not internal.is_dressing_room_pair_blocked(dr.user_id, auth.uid())
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

-- Grants restated so the state is explicit rather than inherited from whatever
-- ran last. anon keeps EXECUTE: the public link preview depends on it, and the
-- predicate above is a no-op for an unauthenticated caller.
revoke all on function public.get_item_reaction_counts(uuid[]) from public;
grant execute on function public.get_item_reaction_counts(uuid[]) to anon;
grant execute on function public.get_item_reaction_counts(uuid[]) to authenticated;
grant execute on function public.get_item_reaction_counts(uuid[]) to service_role;

comment on function public.get_item_reaction_counts(uuid[]) is
  'Reaction counts for room items the caller may see: the room owner, or any caller while an active share exists AND no Dressing Room block stands between them and the room owner. Anonymous link-preview callers are unaffected (a null auth.uid() matches no block row).';
