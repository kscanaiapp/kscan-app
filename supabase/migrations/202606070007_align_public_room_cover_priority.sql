-- Forward migration: align public shared-room cover image priority to match mobile.
-- Changes ORDER BY in get_public_room_preview from
--   sort_order ASC, created_at ASC  (oldest / first-added item)
-- to
--   created_at DESC  (most recently added item)
-- for: (1) cover image_url selection, (2) cover storage-path fallback, and (3) items array ordering.
-- No new columns or fields are exposed.
-- Security-definer / RLS guarantees, grant/revoke, and token-validation logic are unchanged.

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

  -- Cover: most recently added item with a direct HTTP/S image URL.
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
  order by dri.created_at desc
  limit 1;

  -- Cover fallback: most recently added item with private storage image.
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
    order by dri.created_at desc
    limit 1;
  end if;

  -- Items: most recently added first, enabling ordered fallback on the website.
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', dri.id,
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
      order by dri.created_at desc
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
