-- B34-SEC-001 — get_item_reaction_counts() let an authenticated caller read
-- reaction counts for rooms they hold no access to, including after removal.
--
-- WHAT WAS WRONG
--
-- The non-owner branch of public.get_item_reaction_counts(uuid[]) asked only
-- whether the room HAS a live share:
--
--   exists (select 1 from public.room_shares rs
--            where rs.room_id = dr.id and rs.is_active and rs.revoked_at is null
--              and (rs.expires_at is null or rs.expires_at > now()))
--
-- "a share exists" is not "this caller holds it". The function is SECURITY
-- DEFINER and granted to both anon and authenticated, so that predicate was the
-- entire authorization boundary for every non-owner. Proven on staging
-- (yzqjvdfgefveprobvvyw) against synthetic fixtures, with the table's own RLS as
-- the control — same principal, same item, opposite answers:
--
--   anon, no JWT                 dressing_room_items -> 0 rows   rpc -> like=1,looking=0,love=0,thumbs_down=0
--   authenticated non-member     dressing_room_items -> 0 rows   rpc -> like=1,looking=0,love=0,thumbs_down=0
--   authenticated REMOVED member dressing_room_items -> 0 rows   rpc -> like=1,looking=0,love=0,thumbs_down=0
--
-- and the negative control (share revoked, anon) correctly returned no rows,
-- confirming share liveness was the only gate.
--
-- The removed-member row is the defect that matters. Removal is supposed to end
-- access; RLS honours that and this function did not, so a removed recipient
-- kept a live view of an owner's room activity for as long as the share stayed
-- up. 20260902130000_reaction_counts_honour_dressing_room_block.sql closed the
-- same shape of hole for BLOCKED users; removal was simply missed by that pass.
--
-- THE FIX, AND WHY IT IS SHAPED THIS WAY
--
-- Anonymous callers keep the existing predicate, deliberately. The public share
-- screen (app/(public)/rooms/[token].tsx) is unauthenticated by design and
-- reaches this RPC through services/styleObjects.ts with item ids only; there is
-- no token parameter to bind to and adding one would require a client change.
-- An anonymous caller has no identity to check, so the capability IS the share
-- link: they learn these item ids from get_public_room_preview(token) in the
-- first place, and the negative control above shows revoking the share closes
-- the read. That is the same bound get_public_room_preview already operates
-- under and the same one security/scripts/anon-grant-guard.js records for this
-- function. Unchanged, and now stated explicitly instead of being the accidental
-- consequence of one predicate serving two caller classes.
--
-- Authenticated non-owners are the tightened case. They must now hold live
-- access under one of the two recipient models this schema actually has:
--
--   public.shared_room_memberships     save_shared_room_for_me / "Shared with me"
--   public.dressing_room_participants  join_room_via_share_token, via the
--                                      governed can_access_room_messages()
--
-- Both are required to be live (removed_at / left_at null, share active,
-- unrevoked, unexpired), and can_access_room_messages() carries the block check
-- already. The union cannot lock out a legitimate reader: a caller who can see
-- these items at all satisfies one of the two, because those are the same two
-- predicates that gate the items themselves.
--
-- Signature, return type, volatility and grants are unchanged, so no caller
-- contract moves. search_path is tightened from 'public' to pg_catalog, public
-- to match can_access_room_messages() and internal.is_dressing_room_pair_blocked()
-- — every identifier in the body is already schema-qualified, so this only
-- removes the possibility of a public-schema object shadowing a builtin.

create or replace function public.get_item_reaction_counts(p_item_ids uuid[])
returns table(item_id uuid, reaction_type text, count integer)
language sql
security definer
set search_path = pg_catalog, public
as $function$
  with caller as (
    select (select auth.uid()) as uid
  ),
  input_items as (
    select distinct dri.id as item_id
    from unnest(coalesce(p_item_ids, '{}'::uuid[])) as value
    join public.dressing_room_items dri on dri.id = value
    join public.dressing_rooms dr on dr.id = dri.dressing_room_id
    cross join caller
    where value is not null
      and (
        dr.user_id = caller.uid
        or (
          case
            when caller.uid is null then
              -- Anonymous public-preview reader. The share link is the
              -- capability; liveness of the share is the whole bound.
              exists (
                select 1
                from public.room_shares rs
                where rs.room_id = dr.id
                  and rs.is_active = true
                  and rs.revoked_at is null
                  and (rs.expires_at is null or rs.expires_at > now())
              )
            else
              -- Authenticated non-owner: must currently hold access under one
              -- of the two governed recipient models.
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

-- Restated so the grant state is explicit rather than inherited from whatever
-- ran last. Unchanged from 20260803214145_harden_public_rpc_execution_grants.sql:
-- anon EXECUTE is deliberate and is recorded in
-- security/scripts/anon-grant-guard.js.
revoke all on function public.get_item_reaction_counts(uuid[]) from public;
grant execute on function public.get_item_reaction_counts(uuid[]) to anon;
grant execute on function public.get_item_reaction_counts(uuid[]) to authenticated;

comment on function public.get_item_reaction_counts(uuid[]) is
  'Aggregate reaction counts. Owner, or an anonymous reader of a live share (public preview), or an authenticated caller holding live access via shared_room_memberships or can_access_room_messages(). Removed and blocked recipients are excluded.';
