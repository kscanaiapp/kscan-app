-- Public shared-room previews historically enumerated only dressing_room_items,
-- while owner-uploaded room inspirations are stored in inspiration_items and
-- attached through dressing_room_inspiration_items. Extend the existing
-- read-only preview contract across both authoritative item domains without
-- exposing private storage coordinates or changing any persisted records.

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
  preview_item_limit integer := 24;
  cover_image_url text := null;
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
    left(regexp_replace(coalesce(nullif(btrim(dr.room_note), ''), ''), '<[^>]*>', '', 'g'), 500) as room_note,
    rs.room_id,
    dr.user_id as room_owner_id
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

  with combined_items as (
    select
      dri.id as source_id,
      'dressing_room_item'::text as source_type,
      0 as source_rank,
      dri.created_at,
      case when dri.image_url ~* '^https?://' then dri.image_url else null end as image_url,
      case
        when (dri.snapshot_payload #>> '{image,width}') ~ '^[0-9]+(\.[0-9]+)?$'
        then (dri.snapshot_payload #>> '{image,width}')::numeric
        else null
      end as image_width,
      case
        when (dri.snapshot_payload #>> '{image,height}') ~ '^[0-9]+(\.[0-9]+)?$'
        then (dri.snapshot_payload #>> '{image,height}')::numeric
        else null
      end as image_height,
      nullif(left(regexp_replace(btrim(coalesce(dri.category, dri.snapshot_payload #>> '{metadata,category}', dri.snapshot_payload #>> '{category}', '')), '<[^>]*>', '', 'g'), 60), '') as category,
      nullif(left(regexp_replace(btrim(coalesce(dri.snapshot_payload #>> '{metadata,color}', dri.snapshot_payload #>> '{color}', dri.snapshot_payload #>> '{attributes,color}', '')), '<[^>]*>', '', 'g'), 40), '') as color,
      nullif(left(regexp_replace(btrim(coalesce(dri.snapshot_payload #>> '{metadata,silhouette}', dri.snapshot_payload #>> '{silhouette}', dri.snapshot_payload #>> '{metadata,itemType}', '')), '<[^>]*>', '', 'g'), 60), '') as silhouette,
      null::text as title,
      case
        when dri.image_url ~* '^https?://' then 'url:' || dri.image_url
        when coalesce(nullif(btrim(dri.storage_bucket), ''), nullif(btrim(dri.snapshot_payload #>> '{image,storageBucket}'), '')) is not null
         and coalesce(nullif(btrim(dri.storage_path), ''), nullif(btrim(dri.snapshot_payload #>> '{image,storagePath}'), '')) is not null
        then 'storage:'
          || coalesce(nullif(btrim(dri.storage_bucket), ''), nullif(btrim(dri.snapshot_payload #>> '{image,storageBucket}'), ''))
          || '/'
          || coalesce(nullif(btrim(dri.storage_path), ''), nullif(btrim(dri.snapshot_payload #>> '{image,storagePath}'), ''))
        else 'dressing_room_item:' || dri.id::text
      end as media_identity
    from public.dressing_room_items dri
    where dri.dressing_room_id = shared_room.room_id

    union all

    select
      ii.id as source_id,
      'inspiration_item'::text as source_type,
      1 as source_rank,
      drii.created_at,
      null::text as image_url,
      ii.width::numeric as image_width,
      ii.height::numeric as image_height,
      nullif(left(regexp_replace(btrim(coalesce(ii.category, '')), '<[^>]*>', '', 'g'), 60), '') as category,
      nullif(left(regexp_replace(btrim(coalesce(ii.color, '')), '<[^>]*>', '', 'g'), 40), '') as color,
      nullif(left(regexp_replace(btrim(coalesce(ii.silhouette, '')), '<[^>]*>', '', 'g'), 60), '') as silhouette,
      null::text as title,
      'storage:' || ii.storage_bucket || '/' || ii.storage_path as media_identity
    from public.dressing_room_inspiration_items drii
    join public.inspiration_items ii
      on ii.id = drii.inspiration_id
     and ii.user_id = drii.user_id
    where drii.room_id = shared_room.room_id
      and drii.user_id = shared_room.room_owner_id
      and drii.deleted_at is null
      and ii.deleted_at is null
  ),
  deduplicated_items as (
    select combined_items.*
    from (
      select
        combined_items.*,
        row_number() over (
          partition by media_identity
          order by source_rank asc, created_at desc, source_id asc
        ) as duplicate_rank
      from combined_items
    ) combined_items
    where duplicate_rank = 1
  ),
  ranked_items as (
    select
      deduplicated_items.*,
      row_number() over (
        order by created_at desc, source_rank asc, source_id asc
      ) as preview_position
    from deduplicated_items
  )
  select
    count(*)::integer,
    (array_agg(image_url order by preview_position) filter (where image_url is not null))[1],
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', source_id,
          'sourceId', source_id,
          'sourceType', source_type,
          'imageUrl', image_url,
          'imageStorageBucket', null,
          'imageStoragePath', null,
          'imageWidth', image_width,
          'imageHeight', image_height,
          'category', category,
          'color', color,
          'silhouette', silhouette,
          'title', title
        )
        order by preview_position
      ) filter (where preview_position <= preview_item_limit),
      '[]'::jsonb
    )
  into public_item_count, cover_image_url, preview_items
  from ranked_items;

  return jsonb_build_object(
    'status', 'available',
    'shareToken', shared_room.share_token,
    'roomTitle', nullif(btrim(shared_room.room_title), ''),
    'note', nullif(btrim(shared_room.room_note), ''),
    'itemCount', public_item_count,
    'coverImageUrl', cover_image_url,
    'coverImageStorageBucket', null,
    'coverImageStoragePath', null,
    'sharedAt', shared_room.shared_at,
    'maxItemsReturned', preview_item_limit,
    'isCapped', public_item_count > preview_item_limit,
    'items', preview_items
  );
end;
$$;

revoke all on function public.get_public_room_preview(text) from public;
grant execute on function public.get_public_room_preview(text) to anon, authenticated;
