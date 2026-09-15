-- Close an AUTHENTICATED cross-actor read path in
-- public.build_owned_item_snapshot(text, uuid, uuid).
--
-- WHAT WAS WRONG
-- --------------
-- The function is SECURITY DEFINER and takes the owner it should scope to as a
-- PARAMETER (`p_owner_id`). Its own defining migration
-- (20260711000001_ai_stylist_looks_extension.sql) states the contract in
-- words -- "Internal helper: invoked only from the SECURITY DEFINER RPCs
-- below" -- and revokes EXECUTE from `public` and from `anon`. It did not
-- revoke from `authenticated`, and this project's default privileges grant
-- EXECUTE on newly created public-schema functions, so the grant stood.
--
-- PostgREST exposes every executable public-schema function, so the helper was
-- reachable as POST /rest/v1/rpc/build_owned_item_snapshot by any signed-in
-- user. Because SECURITY DEFINER bypasses RLS and the only ownership filter is
-- the caller-supplied `p_owner_id`, User A holding a valid session could read
-- User B's saved-scan snapshot -- title, brand, colour, category, subcategory,
-- pattern, material, silhouette and image reference -- by passing B's scan id
-- and B's user id. Direct SELECT on public.saved_scans was, and remains,
-- correctly denied by RLS; this path went around it.
--
-- This is the same class the anon hardening lane closed in
-- 20260803214145_harden_public_rpc_execution_grants.sql, one role over: that
-- lane inventoried `anon` EXECUTE and left `authenticated` EXECUTE on
-- definer-with-owner-parameter helpers unexamined.
--
-- WHY THIS IS NOT A BEHAVIOUR CHANGE FOR ANY REAL CALLER
-- -----------------------------------------------------
-- The only callers are public.create_look_from_owned_items and
-- public.update_look_owned_items. Both are themselves SECURITY DEFINER, both
-- declare `current_user_id uuid := auth.uid()`, both raise when it is null, and
-- both pass exactly that value as `p_owner_id`. A SECURITY DEFINER function
-- executes as its owner, so neither depends on the caller's EXECUTE grant to
-- reach this helper. The repo contains no direct client caller (confirmed by
-- repo-wide grep over *.ts/*.tsx/*.sql).
--
-- Privilege- and body-only change. No table, column, policy, or unrelated
-- function is added, dropped, or altered.

-- 1. Remove the Data-API reachability. This alone closes the path.
revoke execute on function public.build_owned_item_snapshot(text, uuid, uuid) from authenticated;

-- 2. Defense in depth, inside the function, so that a future default-privilege
--    grant (exactly how this arose) cannot reopen it. Because every legitimate
--    caller already passes auth.uid() as p_owner_id, this guard is a no-op for
--    them and a hard stop for anyone else.
--
--    It returns NULL rather than raising, which is the value the function
--    already uses for "not yours / not available": both wrapper RPCs treat a
--    NULL snapshot as 'One or more selected items are unavailable' (42501), so
--    the refusal reaches the caller through the path they already handle and
--    reveals nothing about whether the row exists.
create or replace function public.build_owned_item_snapshot(
  p_source_type text,
  p_source_id uuid,
  p_owner_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  scan_row public.saved_scans;
  inspiration_row public.inspiration_items;
  meta jsonb;
begin
  -- ACTOR GATE. The owner this helper scopes to is a parameter, so it must be
  -- checked against the verified session rather than trusted. UNKNOWN stays
  -- UNKNOWN: a null auth.uid() matches nothing and returns null.
  if p_owner_id is null or auth.uid() is null or p_owner_id <> auth.uid() then
    return null;
  end if;

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

-- CREATE OR REPLACE resets the function's ACL to the defaults in force, so the
-- revokes are reasserted after the body change. Order matters: these must come
-- last.
revoke all on function public.build_owned_item_snapshot(text, uuid, uuid) from public;
revoke all on function public.build_owned_item_snapshot(text, uuid, uuid) from anon;
revoke all on function public.build_owned_item_snapshot(text, uuid, uuid) from authenticated;
