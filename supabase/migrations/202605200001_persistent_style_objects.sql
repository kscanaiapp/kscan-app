-- Persistent Dressing Rooms and Looks for K Scan.
-- The existing device-local Style Library remains separate and unchanged.

create extension if not exists pgcrypto;

create table if not exists public.dressing_rooms (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  description text,
  cover_image_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint dressing_rooms_title_not_blank check (length(btrim(title)) > 0)
);

create table if not exists public.dressing_room_items (
  id uuid primary key default gen_random_uuid(),
  dressing_room_id uuid not null references public.dressing_rooms(id) on delete cascade,
  source_type text,
  source_id text,
  snapshot_version integer not null default 1,
  snapshot_payload jsonb not null,
  title text,
  image_url text,
  brand text,
  category text,
  price_amount numeric(10,2),
  currency text,
  product_url text,
  notes text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint dressing_room_items_snapshot_object check (jsonb_typeof(snapshot_payload) = 'object'),
  constraint dressing_room_items_snapshot_version_positive check (snapshot_version > 0),
  constraint dressing_room_items_remote_image_only check (
    image_url is null
    or image_url ~* '^https://'
    or image_url ~* '^http://'
  )
);

create table if not exists public.looks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  dressing_room_id uuid references public.dressing_rooms(id) on delete set null,
  title text not null,
  description text,
  cover_image_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint looks_title_not_blank check (length(btrim(title)) > 0)
);

create table if not exists public.look_items (
  id uuid primary key default gen_random_uuid(),
  look_id uuid not null references public.looks(id) on delete cascade,
  source_dressing_room_item_id uuid references public.dressing_room_items(id) on delete set null,
  snapshot_version integer not null default 1,
  snapshot_payload jsonb not null,
  title text,
  image_url text,
  brand text,
  category text,
  product_url text,
  item_role text,
  sort_order integer not null default 0,
  layout_payload jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint look_items_snapshot_object check (jsonb_typeof(snapshot_payload) = 'object'),
  constraint look_items_snapshot_version_positive check (snapshot_version > 0),
  constraint look_items_remote_image_only check (
    image_url is null
    or image_url ~* '^https://'
    or image_url ~* '^http://'
  )
);

create index if not exists dressing_rooms_user_created_idx
on public.dressing_rooms (user_id, created_at desc);

create index if not exists dressing_rooms_user_updated_idx
on public.dressing_rooms (user_id, updated_at desc);

create index if not exists dressing_room_items_room_sort_idx
on public.dressing_room_items (dressing_room_id, sort_order asc);

create index if not exists dressing_room_items_room_created_idx
on public.dressing_room_items (dressing_room_id, created_at asc);

create index if not exists looks_user_created_idx
on public.looks (user_id, created_at desc);

create index if not exists looks_user_updated_idx
on public.looks (user_id, updated_at desc);

create index if not exists looks_room_created_idx
on public.looks (dressing_room_id, created_at desc);

create index if not exists look_items_look_sort_idx
on public.look_items (look_id, sort_order asc);

create or replace function public.set_style_objects_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists dressing_rooms_set_updated_at on public.dressing_rooms;
create trigger dressing_rooms_set_updated_at
before update on public.dressing_rooms
for each row
execute function public.set_style_objects_updated_at();

drop trigger if exists dressing_room_items_set_updated_at on public.dressing_room_items;
create trigger dressing_room_items_set_updated_at
before update on public.dressing_room_items
for each row
execute function public.set_style_objects_updated_at();

drop trigger if exists looks_set_updated_at on public.looks;
create trigger looks_set_updated_at
before update on public.looks
for each row
execute function public.set_style_objects_updated_at();

drop trigger if exists look_items_set_updated_at on public.look_items;
create trigger look_items_set_updated_at
before update on public.look_items
for each row
execute function public.set_style_objects_updated_at();

alter table public.dressing_rooms enable row level security;
alter table public.dressing_room_items enable row level security;
alter table public.looks enable row level security;
alter table public.look_items enable row level security;

drop policy if exists "Users can select own dressing rooms" on public.dressing_rooms;
create policy "Users can select own dressing rooms"
on public.dressing_rooms
for select
to authenticated
using (user_id = auth.uid());

drop policy if exists "Users can insert own dressing rooms" on public.dressing_rooms;
create policy "Users can insert own dressing rooms"
on public.dressing_rooms
for insert
to authenticated
with check (user_id = auth.uid());

drop policy if exists "Users can update own dressing rooms" on public.dressing_rooms;
create policy "Users can update own dressing rooms"
on public.dressing_rooms
for update
to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

drop policy if exists "Users can delete own dressing rooms" on public.dressing_rooms;
create policy "Users can delete own dressing rooms"
on public.dressing_rooms
for delete
to authenticated
using (user_id = auth.uid());

drop policy if exists "Users can select own dressing room items" on public.dressing_room_items;
create policy "Users can select own dressing room items"
on public.dressing_room_items
for select
to authenticated
using (
  exists (
    select 1 from public.dressing_rooms dr
    where dr.id = dressing_room_id
      and dr.user_id = auth.uid()
  )
);

drop policy if exists "Users can insert own dressing room items" on public.dressing_room_items;
create policy "Users can insert own dressing room items"
on public.dressing_room_items
for insert
to authenticated
with check (
  exists (
    select 1 from public.dressing_rooms dr
    where dr.id = dressing_room_id
      and dr.user_id = auth.uid()
  )
);

drop policy if exists "Users can update own dressing room items" on public.dressing_room_items;
create policy "Users can update own dressing room items"
on public.dressing_room_items
for update
to authenticated
using (
  exists (
    select 1 from public.dressing_rooms dr
    where dr.id = dressing_room_id
      and dr.user_id = auth.uid()
  )
)
with check (
  exists (
    select 1 from public.dressing_rooms dr
    where dr.id = dressing_room_id
      and dr.user_id = auth.uid()
  )
);

drop policy if exists "Users can delete own dressing room items" on public.dressing_room_items;
create policy "Users can delete own dressing room items"
on public.dressing_room_items
for delete
to authenticated
using (
  exists (
    select 1 from public.dressing_rooms dr
    where dr.id = dressing_room_id
      and dr.user_id = auth.uid()
  )
);

drop policy if exists "Users can select own looks" on public.looks;
create policy "Users can select own looks"
on public.looks
for select
to authenticated
using (user_id = auth.uid());

drop policy if exists "Users can insert own looks" on public.looks;
create policy "Users can insert own looks"
on public.looks
for insert
to authenticated
with check (
  user_id = auth.uid()
  and (
    dressing_room_id is null
    or exists (
      select 1 from public.dressing_rooms dr
      where dr.id = dressing_room_id
        and dr.user_id = auth.uid()
    )
  )
);

drop policy if exists "Users can update own looks" on public.looks;
create policy "Users can update own looks"
on public.looks
for update
to authenticated
using (user_id = auth.uid())
with check (
  user_id = auth.uid()
  and (
    dressing_room_id is null
    or exists (
      select 1 from public.dressing_rooms dr
      where dr.id = dressing_room_id
        and dr.user_id = auth.uid()
    )
  )
);

drop policy if exists "Users can delete own looks" on public.looks;
create policy "Users can delete own looks"
on public.looks
for delete
to authenticated
using (user_id = auth.uid());

drop policy if exists "Users can select own look items" on public.look_items;
create policy "Users can select own look items"
on public.look_items
for select
to authenticated
using (
  exists (
    select 1 from public.looks l
    where l.id = look_id
      and l.user_id = auth.uid()
  )
);

drop policy if exists "Users can insert own look items" on public.look_items;
create policy "Users can insert own look items"
on public.look_items
for insert
to authenticated
with check (
  exists (
    select 1 from public.looks l
    where l.id = look_id
      and l.user_id = auth.uid()
  )
);

drop policy if exists "Users can update own look items" on public.look_items;
create policy "Users can update own look items"
on public.look_items
for update
to authenticated
using (
  exists (
    select 1 from public.looks l
    where l.id = look_id
      and l.user_id = auth.uid()
  )
)
with check (
  exists (
    select 1 from public.looks l
    where l.id = look_id
      and l.user_id = auth.uid()
  )
);

drop policy if exists "Users can delete own look items" on public.look_items;
create policy "Users can delete own look items"
on public.look_items
for delete
to authenticated
using (
  exists (
    select 1 from public.looks l
    where l.id = look_id
      and l.user_id = auth.uid()
  )
);

create or replace function public.create_look_from_dressing_room_items(
  p_dressing_room_id uuid,
  p_title text,
  p_description text,
  p_item_ids uuid[]
)
returns public.looks
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  created_look public.looks;
  selected_count integer;
begin
  if current_user_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  if p_dressing_room_id is null then
    raise exception 'Dressing room is required' using errcode = '22023';
  end if;

  if length(btrim(coalesce(p_title, ''))) = 0 then
    raise exception 'Look title is required' using errcode = '22023';
  end if;

  if p_item_ids is null or array_length(p_item_ids, 1) is null then
    raise exception 'At least one item is required' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.dressing_rooms
    where id = p_dressing_room_id
      and user_id = current_user_id
  ) then
    raise exception 'Dressing room not found' using errcode = '42501';
  end if;

  select count(*)
  into selected_count
  from public.dressing_room_items dri
  where dri.dressing_room_id = p_dressing_room_id
    and dri.id = any(p_item_ids);

  if selected_count <> array_length(p_item_ids, 1) then
    raise exception 'One or more selected items are unavailable' using errcode = '42501';
  end if;

  insert into public.looks (user_id, dressing_room_id, title, description)
  values (current_user_id, p_dressing_room_id, btrim(p_title), nullif(btrim(coalesce(p_description, '')), ''))
  returning *
  into created_look;

  insert into public.look_items (
    look_id,
    source_dressing_room_item_id,
    snapshot_version,
    snapshot_payload,
    title,
    image_url,
    brand,
    category,
    product_url,
    sort_order
  )
  select
    created_look.id,
    dri.id,
    dri.snapshot_version,
    dri.snapshot_payload,
    dri.title,
    dri.image_url,
    dri.brand,
    dri.category,
    dri.product_url,
    selected.ordinality - 1
  from unnest(p_item_ids) with ordinality as selected(item_id, ordinality)
  join public.dressing_room_items dri
    on dri.id = selected.item_id
   and dri.dressing_room_id = p_dressing_room_id
  order by selected.ordinality;

  return created_look;
end;
$$;

revoke all on function public.create_look_from_dressing_room_items(uuid, text, text, uuid[]) from public;
grant execute on function public.create_look_from_dressing_room_items(uuid, text, text, uuid[]) to authenticated;
