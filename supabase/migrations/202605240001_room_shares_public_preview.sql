-- Share Room v1: token-based, public-safe Dressing Room previews.
-- Private room and item tables remain protected by their existing RLS policies.

create extension if not exists pgcrypto;

create table if not exists public.room_shares (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.dressing_rooms(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  share_token text not null,
  access_level text not null default 'view',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revoked_at timestamptz null,
  expires_at timestamptz null,
  constraint room_shares_access_level_check check (access_level in ('view', 'comment', 'edit')),
  constraint room_shares_share_token_not_blank check (length(btrim(share_token)) > 0)
);

create unique index if not exists room_shares_share_token_key
on public.room_shares (share_token);

create index if not exists room_shares_room_id_idx
on public.room_shares (room_id);

create index if not exists room_shares_owner_id_idx
on public.room_shares (owner_id);

create unique index if not exists room_shares_one_active_per_room_owner
on public.room_shares (room_id, owner_id)
where is_active = true;

drop trigger if exists room_shares_set_updated_at on public.room_shares;
create trigger room_shares_set_updated_at
before update on public.room_shares
for each row
execute function public.set_style_objects_updated_at();

alter table public.room_shares enable row level security;

drop policy if exists "Users can select own room shares" on public.room_shares;
create policy "Users can select own room shares"
on public.room_shares
for select
to authenticated
using (owner_id = auth.uid());

grant select on public.room_shares to authenticated;

create or replace function public.create_or_get_room_share(p_room_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  existing_token text;
  new_token text;
begin
  if current_user_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  if p_room_id is null then
    raise exception 'Dressing room is required' using errcode = '22023';
  end if;

  if not exists (
    select 1
    from public.dressing_rooms dr
    where dr.id = p_room_id
      and dr.user_id = current_user_id
  ) then
    raise exception 'Dressing room not found' using errcode = '42501';
  end if;

  select rs.share_token
  into existing_token
  from public.room_shares rs
  where rs.room_id = p_room_id
    and rs.owner_id = current_user_id
    and rs.is_active = true
    and rs.revoked_at is null
    and (rs.expires_at is null or rs.expires_at > now())
  order by rs.created_at desc
  limit 1;

  if existing_token is not null then
    return existing_token;
  end if;

  new_token := gen_random_uuid()::text;

  begin
    insert into public.room_shares (room_id, owner_id, share_token, access_level)
    values (p_room_id, current_user_id, new_token, 'view')
    returning share_token into existing_token;
  exception
    when unique_violation then
      select rs.share_token
      into existing_token
      from public.room_shares rs
      where rs.room_id = p_room_id
        and rs.owner_id = current_user_id
        and rs.is_active = true
        and rs.revoked_at is null
        and (rs.expires_at is null or rs.expires_at > now())
      order by rs.created_at desc
      limit 1;
  end;

  if existing_token is null then
    raise exception 'Unable to create shared room link' using errcode = '40001';
  end if;

  return existing_token;
end;
$$;

revoke all on function public.create_or_get_room_share(uuid) from public;
grant execute on function public.create_or_get_room_share(uuid) to authenticated;

create or replace function public.revoke_room_share(p_room_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  affected_count integer := 0;
begin
  if current_user_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  if p_room_id is null then
    raise exception 'Dressing room is required' using errcode = '22023';
  end if;

  if not exists (
    select 1
    from public.dressing_rooms dr
    where dr.id = p_room_id
      and dr.user_id = current_user_id
  ) then
    raise exception 'Dressing room not found' using errcode = '42501';
  end if;

  update public.room_shares
  set
    is_active = false,
    revoked_at = now()
  where room_id = p_room_id
    and owner_id = current_user_id
    and is_active = true;

  get diagnostics affected_count = row_count;
  return affected_count > 0;
end;
$$;

revoke all on function public.revoke_room_share(uuid) from public;
grant execute on function public.revoke_room_share(uuid) to authenticated;

create or replace function public.get_public_room_preview(p_share_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_token text := nullif(btrim(coalesce(p_share_token, '')), '');
  shared_room record;
  preview_items jsonb := '[]'::jsonb;
  public_item_count integer := 0;
  cover_image text := null;
begin
  if normalized_token is null or normalized_token !~ '^[A-Za-z0-9_-]+$' then
    return jsonb_build_object('status', 'malformed');
  end if;

  select
    rs.share_token,
    rs.created_at as shared_at,
    left(regexp_replace(coalesce(dr.title, ''), '<[^>]*>', '', 'g'), 100) as room_title
  into shared_room
  from public.room_shares rs
  join public.dressing_rooms dr
    on dr.id = rs.room_id
  where rs.share_token = normalized_token
    and rs.access_level = 'view'
    and rs.is_active = true
    and rs.revoked_at is null
    and (rs.expires_at is null or rs.expires_at > now())
  limit 1;

  if not found then
    return jsonb_build_object('status', 'unavailable');
  end if;

  select count(*)
  into public_item_count
  from public.dressing_room_items dri
  join public.room_shares rs
    on rs.room_id = dri.dressing_room_id
  where rs.share_token = normalized_token
    and rs.is_active = true
    and rs.revoked_at is null
    and (rs.expires_at is null or rs.expires_at > now());

  select dri.image_url
  into cover_image
  from public.dressing_room_items dri
  join public.room_shares rs
    on rs.room_id = dri.dressing_room_id
  where rs.share_token = normalized_token
    and rs.is_active = true
    and rs.revoked_at is null
    and (rs.expires_at is null or rs.expires_at > now())
    and dri.image_url ~* '^https?://'
  order by dri.sort_order asc, dri.created_at asc
  limit 1;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'imageUrl',
          case
            when dri.image_url ~* '^https?://' then dri.image_url
            else null
          end,
        'category',
          nullif(btrim(coalesce(dri.category, dri.snapshot_payload #>> '{metadata,category}', dri.snapshot_payload #>> '{category}', '')), ''),
        'color',
          nullif(btrim(coalesce(dri.snapshot_payload #>> '{metadata,color}', dri.snapshot_payload #>> '{color}', dri.snapshot_payload #>> '{attributes,color}', '')), ''),
        'silhouette',
          nullif(btrim(coalesce(dri.snapshot_payload #>> '{metadata,silhouette}', dri.snapshot_payload #>> '{silhouette}', dri.snapshot_payload #>> '{metadata,itemType}', '')), '')
      )
      order by dri.sort_order asc, dri.created_at asc
    ),
    '[]'::jsonb
  )
  into preview_items
  from public.dressing_room_items dri
  join public.room_shares rs
    on rs.room_id = dri.dressing_room_id
  where rs.share_token = normalized_token
    and rs.is_active = true
    and rs.revoked_at is null
    and (rs.expires_at is null or rs.expires_at > now());

  return jsonb_build_object(
    'status', 'available',
    'shareToken', shared_room.share_token,
    'roomTitle', nullif(btrim(shared_room.room_title), ''),
    'itemCount', public_item_count,
    'coverImageUrl', cover_image,
    'sharedAt', shared_room.shared_at,
    'items', preview_items
  );
end;
$$;

revoke all on function public.get_public_room_preview(text) from public;
grant execute on function public.get_public_room_preview(text) to anon, authenticated;
