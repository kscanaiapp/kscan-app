-- Hostile audit hardening for AI Stylist + StyleChat.
--
-- Corrective, additive migration only. It preserves Phase 1/Phase 2 migration
-- history and avoids destructive data conversion.

comment on table public.style_outfit_daily_usage is
  'Counts style-outfit-generate daily attempts reserved before provider calls; rows do not imply a successful valid outfit response.';

comment on column public.style_outfit_daily_usage.generations_used is
  'Reserved generation attempts used today. Provider failures and invalid/no-result responses may still consume an attempt by design.';

comment on function public.increment_style_outfit_daily_usage(integer) is
  'Atomically reserves one daily style-outfit-generate attempt for the authenticated user before provider execution.';

-- Saved-scan media path authority
-- saved_scans media is later resolved by server code as authorized private
-- media. Owner-scoped UPDATE RLS is not enough: a caller must not be able to
-- poison their own row with another user's object path and have privileged code
-- trust it. New/updated rows must use the deterministic path contract.
alter table public.saved_scans
  drop constraint if exists saved_scans_media_path_owner_contract;

alter table public.saved_scans
  add constraint saved_scans_media_path_owner_contract check (
    (storage_bucket is null and storage_path is null)
    or (
      storage_bucket = 'style-library-images'
      and storage_path = (user_id::text || '/saved-scans/' || id::text || '.jpg')
    )
  ) not valid;

-- Inspiration media has a random suffix rather than an id-derived path, but it
-- is still user-prefixed private media. Enforce the prefix and bucket for all
-- future inserts/updates while leaving pre-existing rows untouched.
alter table public.inspiration_items
  drop constraint if exists inspiration_items_media_path_owner_contract;

alter table public.inspiration_items
  add constraint inspiration_items_media_path_owner_contract check (
    storage_bucket = 'style-library-images'
    and storage_path ~ ('^' || user_id::text || '/inspirations/[A-Za-z0-9._-]+[.]jpg$')
  ) not valid;

-- The upload media identity is immutable after insert. Styling metadata may be
-- enriched later, and soft-delete may set deleted_at, but clients cannot retarget
-- an existing row to a different private object or silently undelete it.
create or replace function public.prevent_inspiration_item_media_rewrite()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.user_id is distinct from old.user_id
    or new.storage_bucket is distinct from old.storage_bucket
    or new.storage_path is distinct from old.storage_path
    or new.source is distinct from old.source
    or new.content_type is distinct from old.content_type
    or new.file_size_bytes is distinct from old.file_size_bytes
    or new.width is distinct from old.width
    or new.height is distinct from old.height
    or new.created_at is distinct from old.created_at then
    raise exception 'Inspiration media fields are immutable' using errcode = '42501';
  end if;

  if old.deleted_at is not null and new.deleted_at is null then
    raise exception 'Deleted inspiration items cannot be restored by update' using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke all on function public.prevent_inspiration_item_media_rewrite() from public;
revoke all on function public.prevent_inspiration_item_media_rewrite() from anon;
revoke all on function public.prevent_inspiration_item_media_rewrite() from authenticated;

drop trigger if exists inspiration_items_prevent_media_rewrite on public.inspiration_items;
create trigger inspiration_items_prevent_media_rewrite
before update on public.inspiration_items
for each row
execute function public.prevent_inspiration_item_media_rewrite();

-- Outfit decision race hardening
-- Lock the decision group before checking status and writing a vote. This
-- serializes vote changes with close/reopen/winner mutations, preventing a
-- vote from landing after the owner closes the decision.
create or replace function public.cast_outfit_decision_vote(
  p_group_id uuid,
  p_option_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  group_row public.outfit_decision_groups;
begin
  if current_user_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  select * into group_row
  from public.outfit_decision_groups
  where id = p_group_id
  for update;

  if not found or not public.can_access_room_messages(group_row.dressing_room_id) then
    raise exception 'Decision not found' using errcode = '42501';
  end if;

  if group_row.status <> 'open' then
    raise exception 'This decision is closed' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.outfit_decision_options o
    where o.id = p_option_id and o.group_id = p_group_id
  ) then
    raise exception 'Option not found' using errcode = '22023';
  end if;

  insert into public.outfit_decision_votes (group_id, option_id, user_id)
  values (p_group_id, p_option_id, current_user_id)
  on conflict (group_id, user_id)
  do update set option_id = excluded.option_id, updated_at = now();
end;
$$;

revoke all on function public.cast_outfit_decision_vote(uuid, uuid) from public;
revoke all on function public.cast_outfit_decision_vote(uuid, uuid) from anon;
grant execute on function public.cast_outfit_decision_vote(uuid, uuid) to authenticated;

-- Legacy public room preview hardening
-- Preserve the legacy JSON keys while stopping raw private Storage bucket/path
-- disclosure through the anon-callable preview RPC. Direct HTTP(S) image URLs
-- remain eligible; private uploaded images require a trusted server-side image
-- mediation path and are not exposed as object coordinates here. The item list
-- is capped to prevent oversized public responses.
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
    rs.room_id
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
  where dri.dressing_room_id = shared_room.room_id;

  select dri.image_url
  into cover_image_url
  from public.dressing_room_items dri
  where dri.dressing_room_id = shared_room.room_id
    and dri.image_url ~* '^https?://'
  order by dri.created_at desc
  limit 1;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', dri.id,
        'imageUrl',
          case
            when dri.image_url ~* '^https?://' then dri.image_url
            else null
          end,
        'imageStorageBucket', null,
        'imageStoragePath', null,
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
          nullif(left(regexp_replace(btrim(coalesce(dri.category, dri.snapshot_payload #>> '{metadata,category}', dri.snapshot_payload #>> '{category}', '')), '<[^>]*>', '', 'g'), 60), ''),
        'color',
          nullif(left(regexp_replace(btrim(coalesce(dri.snapshot_payload #>> '{metadata,color}', dri.snapshot_payload #>> '{color}', dri.snapshot_payload #>> '{attributes,color}', '')), '<[^>]*>', '', 'g'), 40), ''),
        'silhouette',
          nullif(left(regexp_replace(btrim(coalesce(dri.snapshot_payload #>> '{metadata,silhouette}', dri.snapshot_payload #>> '{silhouette}', dri.snapshot_payload #>> '{metadata,itemType}', '')), '<[^>]*>', '', 'g'), 60), '')
      )
      order by dri.created_at desc
    ),
    '[]'::jsonb
  )
  into preview_items
  from (
    select dri.*
    from public.dressing_room_items dri
    where dri.dressing_room_id = shared_room.room_id
    order by dri.created_at desc
    limit preview_item_limit
  ) dri;

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

-- Public decision preview bounds
-- Token validation remains unchanged, but the preview response is now bounded:
-- max 10 decisions, 3 options per decision, and 6 items per option.
create or replace function public.get_public_room_decision_preview(p_share_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  normalized_token text := nullif(btrim(coalesce(p_share_token, '')), '');
  target_room_id uuid;
  decisions jsonb := '[]'::jsonb;
begin
  if normalized_token is null or normalized_token !~ '^[A-Za-z0-9_-]+$' then
    return jsonb_build_object('status', 'malformed');
  end if;

  select rs.room_id into target_room_id
  from public.room_shares rs
  where rs.share_token = normalized_token
    and rs.access_level = 'view'
    and rs.is_active = true
    and rs.revoked_at is null
    and (rs.expires_at is null or rs.expires_at > now())
  limit 1;

  if target_room_id is null then
    return jsonb_build_object('status', 'unavailable');
  end if;

  select coalesce(jsonb_agg(decision_obj order by created_at desc), '[]'::jsonb)
  into decisions
  from (
    select
      g.created_at,
      jsonb_build_object(
        'groupId', g.id,
        'question', left(regexp_replace(coalesce(g.question, ''), '<[^>]*>', '', 'g'), 140),
        'status', g.status,
        'occasion', g.occasion,
        'chosenOptionId', g.chosen_option_id,
        'wearingConfirmed', g.wearing_confirmed_at is not null,
        'options', (
          select coalesce(jsonb_agg(
            jsonb_build_object(
              'optionId', o.id,
              'title', left(regexp_replace(coalesce(o.title, ''), '<[^>]*>', '', 'g'), 80),
              'explanation', left(regexp_replace(coalesce(o.explanation, ''), '<[^>]*>', '', 'g'), 400),
              'variation', o.variation,
              'sortOrder', o.sort_order,
              'voteCount', (
                select count(*)
                from public.outfit_decision_votes v
                where v.option_id = o.id
              ),
              'items', (
                select coalesce(jsonb_agg(
                  jsonb_build_object(
                    'title', left(regexp_replace(coalesce(oi.snapshot_payload ->> 'title', ''), '<[^>]*>', '', 'g'), 80),
                    'category', nullif(left(regexp_replace(btrim(coalesce(oi.snapshot_payload ->> 'category', '')), '<[^>]*>', '', 'g'), 60), ''),
                    'color', nullif(left(regexp_replace(btrim(coalesce(oi.snapshot_payload ->> 'color', '')), '<[^>]*>', '', 'g'), 40), ''),
                    'itemRole', left(regexp_replace(coalesce(oi.item_role, ''), '<[^>]*>', '', 'g'), 40),
                    'sortOrder', oi.sort_order,
                    'imageUrl', case when oi.image_url ~* '^https?://' then oi.image_url else null end
                  )
                  order by oi.sort_order asc
                ), '[]'::jsonb)
                from (
                  select oi.*
                  from public.outfit_decision_option_items oi
                  where oi.option_id = o.id
                  order by oi.sort_order asc, oi.created_at asc
                  limit 6
                ) oi
              )
            )
            order by o.sort_order asc
          ), '[]'::jsonb)
          from (
            select o.*
            from public.outfit_decision_options o
            where o.group_id = g.id
            order by o.sort_order asc, o.created_at asc
            limit 3
          ) o
        )
      ) as decision_obj
    from (
      select g.*
      from public.outfit_decision_groups g
      where g.dressing_room_id = target_room_id
      order by g.created_at desc
      limit 10
    ) g
  ) sub;

  return jsonb_build_object(
    'status', 'available',
    'decisions', decisions
  );
end;
$$;

revoke all on function public.get_public_room_decision_preview(text) from public;
grant execute on function public.get_public_room_decision_preview(text) to anon, authenticated;
