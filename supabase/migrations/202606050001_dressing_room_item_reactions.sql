create table if not exists public.dressing_room_item_reactions (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.dressing_room_items(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  reaction_type text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint dressing_room_item_reactions_reaction_type_check check (
    reaction_type in ('like', 'love', 'favorite', 'looking')
  ),
  constraint dressing_room_item_reactions_item_user_key unique (item_id, user_id)
);

create index if not exists idx_dressing_room_item_reactions_item_type
on public.dressing_room_item_reactions (item_id, reaction_type);

drop trigger if exists dressing_room_item_reactions_set_updated_at on public.dressing_room_item_reactions;
create trigger dressing_room_item_reactions_set_updated_at
before update on public.dressing_room_item_reactions
for each row
execute function public.set_style_objects_updated_at();

alter table public.dressing_room_item_reactions enable row level security;

drop policy if exists "Users can select own dressing room item reactions" on public.dressing_room_item_reactions;
create policy "Users can select own dressing room item reactions"
on public.dressing_room_item_reactions
for select
to authenticated
using (user_id = auth.uid());

drop policy if exists "Users can insert own dressing room item reactions" on public.dressing_room_item_reactions;
create policy "Users can insert own dressing room item reactions"
on public.dressing_room_item_reactions
for insert
to authenticated
with check (user_id = auth.uid());

drop policy if exists "Users can update own dressing room item reactions" on public.dressing_room_item_reactions;
create policy "Users can update own dressing room item reactions"
on public.dressing_room_item_reactions
for update
to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

drop policy if exists "Users can delete own dressing room item reactions" on public.dressing_room_item_reactions;
create policy "Users can delete own dressing room item reactions"
on public.dressing_room_item_reactions
for delete
to authenticated
using (user_id = auth.uid());

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
    from (values ('like'), ('love'), ('favorite'), ('looking')) as reactions(value)
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
