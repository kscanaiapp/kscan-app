-- Forward migration: expose snapshot storage bucket/path for shared room items.
-- Enables server-side signed URL generation for private style-library-images storage.
-- Storage paths are consumed by the website server only and never forwarded to the browser.

create or replace function public.get_public_room_preview(p_share_token text)
returns jsonb
language plpgsql
security definer
set search_path = 'public'
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

  -- Cover: prefer public http/https image_url; fall back to private storage path
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
