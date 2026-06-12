-- inspiration_items: user-owned, cloud-backed inspiration uploads
-- Source is always 'upload' for this build (no camera capture, no URL import).
-- Rows are soft-deleted; hard-delete is not performed in this build.
-- Storage objects live under {userId}/inspirations/ in the style-library-images bucket,
-- which already carries per-user folder RLS.
create table if not exists public.inspiration_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  storage_bucket text not null,
  storage_path text not null,
  source text not null default 'upload' check (source in ('upload')),
  original_filename text null,
  content_type text null check (content_type in ('image/jpeg', 'image/png', 'image/webp')),
  file_size_bytes integer null check (file_size_bytes is null or file_size_bytes <= 10485760),
  width integer null,
  height integer null,
  note text null check (note is null or length(trim(note)) <= 200),
  created_at timestamptz not null default now(),
  deleted_at timestamptz null
);

create index if not exists idx_inspiration_items_user_created
  on public.inspiration_items(user_id, created_at desc)
  where deleted_at is null;

alter table public.inspiration_items enable row level security;

create policy "inspiration_items_insert"
  on public.inspiration_items for insert
  with check (user_id = auth.uid());

create policy "inspiration_items_select"
  on public.inspiration_items for select
  using (user_id = auth.uid() and deleted_at is null);

-- UPDATE is allowed only for soft-delete (setting deleted_at).
-- Application code must never set deleted_at to null once set.
create policy "inspiration_items_update"
  on public.inspiration_items for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- dressing_room_inspiration_items: attaches an inspiration_items row to a room.
-- Unique constraint prevents duplicate attachments.
-- Removing from a room soft-deletes the link row only; the inspiration_items row is unaffected.
create table if not exists public.dressing_room_inspiration_items (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.dressing_rooms(id) on delete cascade,
  inspiration_id uuid not null references public.inspiration_items(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  deleted_at timestamptz null,
  unique(room_id, inspiration_id)
);

create index if not exists idx_dressing_room_inspiration_room_created
  on public.dressing_room_inspiration_items(room_id, created_at desc)
  where deleted_at is null;

alter table public.dressing_room_inspiration_items enable row level security;

create policy "dressing_room_inspiration_insert"
  on public.dressing_room_inspiration_items for insert
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.dressing_rooms dr
      where dr.id = room_id and dr.user_id = auth.uid()
    )
  );

create policy "dressing_room_inspiration_select"
  on public.dressing_room_inspiration_items for select
  using (
    user_id = auth.uid()
    and deleted_at is null
    and exists (
      select 1 from public.dressing_rooms dr
      where dr.id = room_id and dr.user_id = auth.uid()
    )
  );

-- UPDATE is allowed only for soft-delete on link rows.
create policy "dressing_room_inspiration_update"
  on public.dressing_room_inspiration_items for update
  using (
    user_id = auth.uid()
    and exists (
      select 1 from public.dressing_rooms dr
      where dr.id = room_id and dr.user_id = auth.uid()
    )
  )
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.dressing_rooms dr
      where dr.id = room_id and dr.user_id = auth.uid()
    )
  );
