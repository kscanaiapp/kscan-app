-- B34-SEC-001 staging reconciliation: bind anonymous reaction-count reads to
-- the exact live share token. This file mirrors the statement recorded in the
-- staging ledger at version 20260916233708; it does not query or alter any
-- other environment and does not rewrite migration history.

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
