-- AI Stylist expansion: extend public.looks and public.look_items for
-- owned-closet outfits (manual + AI) alongside existing Dressing Room Looks.
--
-- MIGRATION SOURCE ONLY — not applied to any remote environment in this build.
--
-- Design rules honored here:
--   * Existing columns, records, RPCs, and RLS are preserved unchanged.
--   * looks.source is nullable; legacy rows stay NULL and are treated as
--     'dressing_room' by the application. No destructive backfill.
--   * look_items keeps source_dressing_room_item_id and gains concrete
--     nullable foreign keys for owned-item sources (saved_scans,
--     inspiration_items) plus a source_type discriminator.
--   * Looks are created/updated atomically via SECURITY DEFINER RPCs that
--     validate ownership of every remote source row, enforce 2–6 items,
--     reject duplicates, and build bounded snapshots server-side.
--   * Deleting a Look never deletes closet items; deleting a source item
--     never deletes the Look (FKs are ON DELETE SET NULL; snapshots keep the
--     Look renderable).

-- ── looks: outfit context columns ─────────────────────────────────────────────

alter table public.looks
  add column if not exists source text
    check (source is null or source in ('dressing_room', 'manual', 'ai')),
  add column if not exists occasion text
    check (occasion is null or occasion in ('casual', 'work', 'date', 'event', 'travel', 'other')),
  add column if not exists dress_code text
    check (dress_code is null or dress_code in ('relaxed', 'smart_casual', 'dressy', 'formal')),
  add column if not exists setting text
    check (setting is null or setting in ('indoor', 'outdoor', 'both')),
  add column if not exists context_note text
    check (context_note is null or length(btrim(context_note)) <= 280),
  add column if not exists explanation text
    check (explanation is null or length(btrim(explanation)) <= 400),
  add column if not exists prompt_version text
    check (prompt_version is null or length(btrim(prompt_version)) <= 16),
  add column if not exists contract_version text
    check (contract_version is null or length(btrim(contract_version)) <= 16);

comment on column public.looks.source is
  'Look origin: dressing_room (legacy rows are NULL and treated as dressing_room), manual (owned-closet builder), ai (AI Stylist suggestion saved by the owner).';

-- ── look_items: concrete owned-item source references ────────────────────────

alter table public.look_items
  add column if not exists source_type text
    check (
      source_type is null
      or source_type in ('dressing_room_item', 'saved_scan', 'inspiration_item')
    ),
  add column if not exists source_saved_scan_id uuid
    references public.saved_scans(id) on delete set null,
  add column if not exists source_inspiration_item_id uuid
    references public.inspiration_items(id) on delete set null;

comment on column public.look_items.source_type is
  'Item origin discriminator. Legacy rows are NULL and treated as dressing_room_item.';

-- One concrete source per item (legacy rows have all owned-source refs NULL).
alter table public.look_items
  drop constraint if exists look_items_single_owned_source;
alter table public.look_items
  add constraint look_items_single_owned_source check (
    (source_saved_scan_id is null) or (source_inspiration_item_id is null)
  );

create index if not exists look_items_source_saved_scan_idx
  on public.look_items (source_saved_scan_id)
  where source_saved_scan_id is not null;

create index if not exists look_items_source_inspiration_idx
  on public.look_items (source_inspiration_item_id)
  where source_inspiration_item_id is not null;

create index if not exists looks_user_source_idx
  on public.looks (user_id, source);

-- ── Shared snapshot builder for owned items (snapshot version 2) ─────────────
-- Bounded, versioned snapshot: only display/understanding fields. Never copies
-- analysis_result blobs, product arrays, prompts, or account metadata. Never
-- duplicates image binaries — storage references only.

create or replace function public.build_owned_item_snapshot(
  p_source_type text,
  p_source_id uuid,
  p_owner_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  scan_row public.saved_scans;
  inspiration_row public.inspiration_items;
  meta jsonb;
begin
  if p_source_type = 'saved_scan' then
    select * into scan_row
    from public.saved_scans
    where id = p_source_id
      and user_id = p_owner_id
      and deleted_at is null;

    if not found then
      return null;
    end if;

    meta := coalesce(scan_row.analysis_result -> 'metadata', '{}'::jsonb);

    return jsonb_build_object(
      'snapshotVersion', 2,
      'sourceType', 'saved_scan',
      'sourceId', scan_row.id,
      'title', coalesce(nullif(btrim(coalesce(scan_row.title, '')), ''), nullif(btrim(coalesce(meta ->> 'category', '')), ''), 'Saved scan'),
      'category', nullif(btrim(coalesce(meta ->> 'category', '')), ''),
      'subcategory', nullif(btrim(coalesce(meta ->> 'subcategory', meta ->> 'itemType', '')), ''),
      'brand', nullif(btrim(coalesce(meta ->> 'brand', '')), ''),
      'color', nullif(btrim(coalesce(meta ->> 'color', meta ->> 'color_palette', '')), ''),
      'pattern', nullif(btrim(coalesce(meta ->> 'pattern', '')), ''),
      'material', nullif(btrim(coalesce(meta ->> 'material_estimate', meta ->> 'material', '')), ''),
      'silhouette', nullif(btrim(coalesce(meta ->> 'silhouette', '')), ''),
      -- Display reference only. Saved-scan images are device-local in the
      -- current cloud model; no binary is copied or uploaded here.
      'imageUri', nullif(btrim(coalesce(scan_row.thumbnail_uri, scan_row.image_uri, '')), ''),
      'image', null
    );
  elsif p_source_type = 'inspiration_item' then
    select * into inspiration_row
    from public.inspiration_items
    where id = p_source_id
      and user_id = p_owner_id
      and deleted_at is null;

    if not found then
      return null;
    end if;

    return jsonb_build_object(
      'snapshotVersion', 2,
      'sourceType', 'inspiration_item',
      'sourceId', inspiration_row.id,
      'title', coalesce(nullif(btrim(coalesce(inspiration_row.note, '')), ''), 'Inspiration'),
      'category', null,
      'brand', null,
      'color', null,
      'image', jsonb_build_object(
        'storageBucket', inspiration_row.storage_bucket,
        'storagePath', inspiration_row.storage_path
      )
    );
  end if;

  return null;
end;
$$;

revoke all on function public.build_owned_item_snapshot(text, uuid, uuid) from public;
revoke all on function public.build_owned_item_snapshot(text, uuid, uuid) from anon;
-- Internal helper: invoked only from the SECURITY DEFINER RPCs below.

-- ── Atomic owned-item Look creation ───────────────────────────────────────────
-- p_items: jsonb array of { "sourceType": "saved_scan" | "inspiration_item",
--                           "sourceId": "<uuid>", "role": "<garment role|null>" }
-- Ordered; position in the array is the deterministic zero-based sort order.

create or replace function public.create_look_from_owned_items(
  p_title text,
  p_description text,
  p_source text,
  p_occasion text,
  p_dress_code text,
  p_setting text,
  p_context_note text,
  p_explanation text,
  p_prompt_version text,
  p_contract_version text,
  p_items jsonb
)
returns public.looks
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  created_look public.looks;
  item_count integer;
  distinct_count integer;
  entry jsonb;
  entry_index integer := 0;
  entry_source_type text;
  entry_source_id uuid;
  entry_role text;
  entry_snapshot jsonb;
  cover_url text := null;
begin
  if current_user_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  if length(btrim(coalesce(p_title, ''))) = 0 then
    raise exception 'Look title is required' using errcode = '22023';
  end if;

  if p_source is null or p_source not in ('manual', 'ai') then
    raise exception 'Invalid look source' using errcode = '22023';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'Items are required' using errcode = '22023';
  end if;

  item_count := jsonb_array_length(p_items);
  if item_count < 2 or item_count > 6 then
    raise exception 'A Look needs between 2 and 6 items' using errcode = '22023';
  end if;

  select count(distinct (elem ->> 'sourceType') || ':' || (elem ->> 'sourceId'))
  into distinct_count
  from jsonb_array_elements(p_items) elem;

  if distinct_count <> item_count then
    raise exception 'Duplicate items are not allowed in a Look' using errcode = '22023';
  end if;

  insert into public.looks (
    user_id, dressing_room_id, title, description,
    source, occasion, dress_code, setting, context_note, explanation,
    prompt_version, contract_version
  )
  values (
    current_user_id,
    null,
    btrim(p_title),
    nullif(btrim(coalesce(p_description, '')), ''),
    p_source,
    nullif(btrim(coalesce(p_occasion, '')), ''),
    nullif(btrim(coalesce(p_dress_code, '')), ''),
    nullif(btrim(coalesce(p_setting, '')), ''),
    nullif(btrim(coalesce(p_context_note, '')), ''),
    nullif(btrim(coalesce(p_explanation, '')), ''),
    nullif(btrim(coalesce(p_prompt_version, '')), ''),
    nullif(btrim(coalesce(p_contract_version, '')), '')
  )
  returning * into created_look;

  for entry in select * from jsonb_array_elements(p_items)
  loop
    entry_source_type := entry ->> 'sourceType';
    entry_role := nullif(btrim(coalesce(entry ->> 'role', '')), '');

    if entry_source_type not in ('saved_scan', 'inspiration_item') then
      raise exception 'Unsupported item source' using errcode = '22023';
    end if;

    begin
      entry_source_id := (entry ->> 'sourceId')::uuid;
    exception when others then
      raise exception 'Invalid item reference' using errcode = '22023';
    end;

    -- Ownership + availability validation happens inside the snapshot builder.
    entry_snapshot := public.build_owned_item_snapshot(entry_source_type, entry_source_id, current_user_id);
    if entry_snapshot is null then
      raise exception 'One or more selected items are unavailable' using errcode = '42501';
    end if;

    insert into public.look_items (
      look_id,
      source_dressing_room_item_id,
      source_type,
      source_saved_scan_id,
      source_inspiration_item_id,
      snapshot_version,
      snapshot_payload,
      title,
      image_url,
      storage_bucket,
      storage_path,
      brand,
      category,
      item_role,
      sort_order
    )
    values (
      created_look.id,
      null,
      entry_source_type,
      case when entry_source_type = 'saved_scan' then entry_source_id else null end,
      case when entry_source_type = 'inspiration_item' then entry_source_id else null end,
      2,
      entry_snapshot,
      entry_snapshot ->> 'title',
      case
        when (entry_snapshot ->> 'imageUri') ~* '^https?://' then entry_snapshot ->> 'imageUri'
        else null
      end,
      entry_snapshot #>> '{image,storageBucket}',
      entry_snapshot #>> '{image,storagePath}',
      entry_snapshot ->> 'brand',
      entry_snapshot ->> 'category',
      entry_role,
      entry_index
    );

    -- Cover rule: first ordered item with a safe remote image reference.
    if cover_url is null and (entry_snapshot ->> 'imageUri') ~* '^https?://' then
      cover_url := entry_snapshot ->> 'imageUri';
    end if;

    entry_index := entry_index + 1;
  end loop;

  if cover_url is not null then
    update public.looks set cover_image_url = cover_url where id = created_look.id
    returning * into created_look;
  end if;

  return created_look;
end;
$$;

revoke all on function public.create_look_from_owned_items(text, text, text, text, text, text, text, text, text, text, jsonb) from public;
revoke all on function public.create_look_from_owned_items(text, text, text, text, text, text, text, text, text, text, jsonb) from anon;
grant execute on function public.create_look_from_owned_items(text, text, text, text, text, text, text, text, text, text, jsonb) to authenticated;

-- ── Atomic owned-item Look update (metadata + full item replacement) ──────────

create or replace function public.update_look_owned_items(
  p_look_id uuid,
  p_title text,
  p_description text,
  p_occasion text,
  p_dress_code text,
  p_setting text,
  p_context_note text,
  p_items jsonb
)
returns public.looks
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  target_look public.looks;
  item_count integer;
  distinct_count integer;
  entry jsonb;
  entry_index integer := 0;
  entry_source_type text;
  entry_source_id uuid;
  entry_role text;
  entry_snapshot jsonb;
  cover_url text := null;
begin
  if current_user_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  select * into target_look
  from public.looks
  where id = p_look_id
    and user_id = current_user_id
  for update;

  if not found then
    raise exception 'Look not found' using errcode = '42501';
  end if;

  if target_look.source is null or target_look.source = 'dressing_room' then
    raise exception 'This Look cannot be edited here' using errcode = '22023';
  end if;

  if length(btrim(coalesce(p_title, ''))) = 0 then
    raise exception 'Look title is required' using errcode = '22023';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'Items are required' using errcode = '22023';
  end if;

  item_count := jsonb_array_length(p_items);
  if item_count < 2 or item_count > 6 then
    raise exception 'A Look needs between 2 and 6 items' using errcode = '22023';
  end if;

  select count(distinct (elem ->> 'sourceType') || ':' || (elem ->> 'sourceId'))
  into distinct_count
  from jsonb_array_elements(p_items) elem;

  if distinct_count <> item_count then
    raise exception 'Duplicate items are not allowed in a Look' using errcode = '22023';
  end if;

  delete from public.look_items where look_id = target_look.id;

  for entry in select * from jsonb_array_elements(p_items)
  loop
    entry_source_type := entry ->> 'sourceType';
    entry_role := nullif(btrim(coalesce(entry ->> 'role', '')), '');

    if entry_source_type not in ('saved_scan', 'inspiration_item') then
      raise exception 'Unsupported item source' using errcode = '22023';
    end if;

    begin
      entry_source_id := (entry ->> 'sourceId')::uuid;
    exception when others then
      raise exception 'Invalid item reference' using errcode = '22023';
    end;

    entry_snapshot := public.build_owned_item_snapshot(entry_source_type, entry_source_id, current_user_id);
    if entry_snapshot is null then
      raise exception 'One or more selected items are unavailable' using errcode = '42501';
    end if;

    insert into public.look_items (
      look_id, source_type, source_saved_scan_id, source_inspiration_item_id,
      snapshot_version, snapshot_payload, title, image_url,
      storage_bucket, storage_path, brand, category, item_role, sort_order
    )
    values (
      target_look.id,
      entry_source_type,
      case when entry_source_type = 'saved_scan' then entry_source_id else null end,
      case when entry_source_type = 'inspiration_item' then entry_source_id else null end,
      2,
      entry_snapshot,
      entry_snapshot ->> 'title',
      case
        when (entry_snapshot ->> 'imageUri') ~* '^https?://' then entry_snapshot ->> 'imageUri'
        else null
      end,
      entry_snapshot #>> '{image,storageBucket}',
      entry_snapshot #>> '{image,storagePath}',
      entry_snapshot ->> 'brand',
      entry_snapshot ->> 'category',
      entry_role,
      entry_index
    );

    if cover_url is null and (entry_snapshot ->> 'imageUri') ~* '^https?://' then
      cover_url := entry_snapshot ->> 'imageUri';
    end if;

    entry_index := entry_index + 1;
  end loop;

  update public.looks
  set
    title = btrim(p_title),
    description = nullif(btrim(coalesce(p_description, '')), ''),
    occasion = nullif(btrim(coalesce(p_occasion, '')), ''),
    dress_code = nullif(btrim(coalesce(p_dress_code, '')), ''),
    setting = nullif(btrim(coalesce(p_setting, '')), ''),
    context_note = nullif(btrim(coalesce(p_context_note, '')), ''),
    cover_image_url = cover_url
  where id = target_look.id
  returning * into target_look;

  return target_look;
end;
$$;

revoke all on function public.update_look_owned_items(uuid, text, text, text, text, text, text, jsonb) from public;
revoke all on function public.update_look_owned_items(uuid, text, text, text, text, text, text, jsonb) from anon;
grant execute on function public.update_look_owned_items(uuid, text, text, text, text, text, text, jsonb) to authenticated;
