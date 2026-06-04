alter table public.dressing_rooms
add column if not exists room_note text null;

create or replace function public.normalize_dressing_room_note()
returns trigger
language plpgsql
as $$
declare
  trimmed_note text;
begin
  trimmed_note := nullif(btrim(coalesce(new.room_note, '')), '');

  if trimmed_note is null then
    new.room_note := null;
    return new;
  end if;

  if char_length(trimmed_note) > 500 then
    raise exception 'Room note must be 500 characters or fewer.' using errcode = '22023';
  end if;

  new.room_note := trimmed_note;
  return new;
end;
$$;

drop trigger if exists dressing_rooms_normalize_note on public.dressing_rooms;
create trigger dressing_rooms_normalize_note
before insert or update of room_note on public.dressing_rooms
for each row
execute function public.normalize_dressing_room_note();

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
  cover_image_url text := null;
  cover_bucket text := null;
  cover_path text := null;
begin
  if normalized_token is null
     or normalized_token !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  then
    return jsonb_build_object('status', 'malformed');
  end if;

  select
    rs.share_token,
    rs.created_at as shared_at,
    left(regexp_replace(coalesce(dr.title, ''), '<[^>]*>', '', 'g'), 100) as room_title,
    nullif(btrim(dr.room_note), '') as room_note
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
  into cover_image_url
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

  if cover_image_url is null then
    select
      dri.snapshot_payload #>> '{image,storageBucket}',
      dri.snapshot_payload #>> '{image,storagePath}'
    into cover_bucket, cover_path
    from public.dressing_room_items dri
    join public.room_shares rs
      on rs.room_id = dri.dressing_room_id
    where rs.share_token = normalized_token
      and rs.is_active = true
      and rs.revoked_at is null
      and (rs.expires_at is null or rs.expires_at > now())
      and dri.snapshot_payload #>> '{image,storageBucket}' is not null
      and dri.snapshot_payload #>> '{image,storagePath}' is not null
    order by dri.sort_order asc, dri.created_at asc
    limit 1;
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'imageUrl',
          case
            when dri.image_url ~* '^https?://' then dri.image_url
            else null
          end,
        'imageStorageBucket',
          dri.snapshot_payload #>> '{image,storageBucket}',
        'imageStoragePath',
          dri.snapshot_payload #>> '{image,storagePath}',
        'imageWidth',
          case
            when (dri.snapshot_payload #>> '{image,width}') ~ '^[0-9]+(\.[0-9]+)?$'
            then (dri.snapshot_payload #>> '{image,width}')::numeric
            else null
          end,
        'imageHeight',
          case
            when (dri.snapshot_payload #>> '{image,height}') ~ '^[0-9]+(\.[0-9]+)?$'
            then (dri.snapshot_payload #>> '{image,height}')::numeric
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
    'note', shared_room.room_note,
    'itemCount', public_item_count,
    'coverImageUrl', cover_image_url,
    'coverImageStorageBucket', cover_bucket,
    'coverImageStoragePath', cover_path,
    'sharedAt', shared_room.shared_at,
    'items', preview_items
  );
end;
$$;

revoke all on function public.get_public_room_preview(text) from public;
grant execute on function public.get_public_room_preview(text) to anon, authenticated;
