alter table public.dressing_room_item_reactions
drop constraint if exists dressing_room_item_reactions_reaction_type_check;

alter table public.dressing_room_item_reactions
add constraint dressing_room_item_reactions_reaction_type_check
check (
  reaction_type in ('like', 'love', 'favorite', 'looking', 'thumbs_down')
);

create or replace function public.get_item_reaction_counts(p_item_ids uuid[])
returns table (
  item_id uuid,
  reaction_type text,
  count integer
)
language sql
security definer
set search_path = public
as $$
  with input_items as (
    select distinct value as item_id
    from unnest(coalesce(p_item_ids, '{}'::uuid[])) as value
    where value is not null
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
$$;

revoke all on function public.get_item_reaction_counts(uuid[]) from public;
grant execute on function public.get_item_reaction_counts(uuid[]) to anon, authenticated;
