-- Private cloud storage for explicitly saved scan inspiration images.
-- This does not cloud-sync the local Style Library; images are uploaded only
-- when the user chooses Add Scan to Dressing Room.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'style-library-images',
  'style-library-images',
  false,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

alter table public.dressing_room_items
  add column if not exists storage_bucket text,
  add column if not exists storage_path text;

alter table public.look_items
  add column if not exists storage_bucket text,
  add column if not exists storage_path text;

create index if not exists dressing_room_items_storage_idx
on public.dressing_room_items (storage_bucket, storage_path)
where storage_path is not null;

create index if not exists look_items_storage_idx
on public.look_items (storage_bucket, storage_path)
where storage_path is not null;

drop policy if exists "Users can read own style library images" on storage.objects;
create policy "Users can read own style library images"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'style-library-images'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "Users can upload own style library images" on storage.objects;
create policy "Users can upload own style library images"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'style-library-images'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "Users can update own style library images" on storage.objects;
create policy "Users can update own style library images"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'style-library-images'
  and (storage.foldername(name))[1] = auth.uid()::text
)
with check (
  bucket_id = 'style-library-images'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "Users can delete own style library images" on storage.objects;
create policy "Users can delete own style library images"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'style-library-images'
  and (storage.foldername(name))[1] = auth.uid()::text
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
    storage_bucket,
    storage_path,
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
    dri.storage_bucket,
    dri.storage_path,
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
