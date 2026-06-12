-- =============================================================================
-- Migration: 202605240003_public_room_preview_image_storage_metadata.sql
-- =============================================================================
-- Purpose:
--   Enhances public.get_public_room_preview(text) to return private storage
--   metadata alongside each item and at root level. This allows the website
--   server layer to generate signed URLs without an extra DB round-trip.
--
-- New fields added to the returned JSONB:
--   Root-level:
--     coverImageStorageBucket  text | null
--     coverImageStoragePath    text | null
--   Per item in the "items" array:
--     imageStorageBucket       text | null
--     imageStoragePath         text | null
--
-- All existing fields and all security controls are preserved verbatim.
--
-- Base: live pg_get_functiondef output (project yzqjvdfgefveprobvvyw,
--       captured 2026-05-24). Supersedes draft based on 202605240001.
--
-- SAFETY:
--   - Does NOT expose snapshot_payload raw blobs.
--   - Does NOT expose user_id, owner_id, room_id, or dressing_room_id.
--   - Does NOT weaken UUID token validation.
--   - Does NOT loosen RLS.
--   - SECURITY DEFINER and SET search_path TO 'public' preserved verbatim.
--   - No DROP FUNCTION required; signature unchanged (p_share_token text ->
--     RETURNS jsonb), so CREATE OR REPLACE is safe.
--
-- FORWARD-ONLY. Do not edit historical migrations.
-- Do NOT apply without reviewing SHARE_ROOM_V1_APPLY_PACKAGE.md.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.get_public_room_preview(p_share_token text)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $function$
DECLARE
  normalized_token     text    := nullif(btrim(coalesce(p_share_token, '')), '');
  shared_room          record;
  preview_items        jsonb   := '[]'::jsonb;
  public_item_count    integer := 0;
  cover_image          text    := null;
  cover_storage_bucket text    := null;
  cover_storage_path   text    := null;
BEGIN
  -- Reject blank or non-UUID tokens immediately
  IF normalized_token IS NULL
     OR normalized_token !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  THEN
    RETURN jsonb_build_object('status', 'malformed');
  END IF;

  -- Resolve token to a room (public-safe fields only)
  SELECT
    rs.share_token,
    rs.created_at AS shared_at,
    left(regexp_replace(coalesce(dr.title, ''), '<[^>]*>', '', 'g'), 100) AS room_title
  INTO shared_room
  FROM public.room_shares rs
  JOIN public.dressing_rooms dr
    ON dr.id = rs.room_id
  WHERE rs.share_token = normalized_token
    AND rs.access_level = 'view'
    AND rs.is_active = true
    AND rs.revoked_at IS NULL
    AND (rs.expires_at IS NULL OR rs.expires_at > now())
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'unavailable');
  END IF;

  SELECT count(*)
  INTO public_item_count
  FROM public.dressing_room_items dri
  JOIN public.room_shares rs
    ON rs.room_id = dri.dressing_room_id
  WHERE rs.share_token = normalized_token
    AND rs.is_active = true
    AND rs.revoked_at IS NULL
    AND (rs.expires_at IS NULL OR rs.expires_at > now());

  SELECT dri.image_url
  INTO cover_image
  FROM public.dressing_room_items dri
  JOIN public.room_shares rs
    ON rs.room_id = dri.dressing_room_id
  WHERE rs.share_token = normalized_token
    AND rs.is_active = true
    AND rs.revoked_at IS NULL
    AND (rs.expires_at IS NULL OR rs.expires_at > now())
    AND dri.image_url ~* '^https?://'
  ORDER BY dri.sort_order ASC, dri.created_at ASC
  LIMIT 1;

  -- NEW: Resolve cover image private storage metadata.
  -- Selects storageBucket + storagePath from the first item (by sort_order,
  -- then created_at) that has both fields present. The website layer uses
  -- these to generate a signed URL server-side via the Supabase admin client.
  SELECT
    nullif(btrim(coalesce(dri.snapshot_payload #>> '{image,storageBucket}', '')), ''),
    nullif(btrim(coalesce(dri.snapshot_payload #>> '{image,storagePath}',   '')), '')
  INTO cover_storage_bucket, cover_storage_path
  FROM public.dressing_room_items dri
  JOIN public.room_shares rs
    ON rs.room_id = dri.dressing_room_id
  WHERE rs.share_token = normalized_token
    AND rs.is_active = true
    AND rs.revoked_at IS NULL
    AND (rs.expires_at IS NULL OR rs.expires_at > now())
    AND nullif(btrim(coalesce(dri.snapshot_payload #>> '{image,storageBucket}', '')), '') IS NOT NULL
    AND nullif(btrim(coalesce(dri.snapshot_payload #>> '{image,storagePath}',   '')), '') IS NOT NULL
  ORDER BY dri.sort_order ASC, dri.created_at ASC
  LIMIT 1;

  -- Build items array.
  -- imageStorageBucket and imageStoragePath are NEW; all other fields unchanged.
  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'imageUrl',
          CASE
            WHEN dri.image_url ~* '^https?://' THEN dri.image_url
            ELSE null
          END,
        'category',
          nullif(btrim(coalesce(
            dri.category,
            dri.snapshot_payload #>> '{metadata,category}',
            dri.snapshot_payload #>> '{category}',
            ''
          )), ''),
        'color',
          nullif(btrim(coalesce(
            dri.snapshot_payload #>> '{metadata,color}',
            dri.snapshot_payload #>> '{color}',
            dri.snapshot_payload #>> '{attributes,color}',
            ''
          )), ''),
        'silhouette',
          nullif(btrim(coalesce(
            dri.snapshot_payload #>> '{metadata,silhouette}',
            dri.snapshot_payload #>> '{silhouette}',
            dri.snapshot_payload #>> '{metadata,itemType}',
            ''
          )), ''),
        'imageStorageBucket',
          nullif(btrim(coalesce(dri.snapshot_payload #>> '{image,storageBucket}', '')), ''),
        'imageStoragePath',
          nullif(btrim(coalesce(dri.snapshot_payload #>> '{image,storagePath}',   '')), '')
      )
      ORDER BY dri.sort_order ASC, dri.created_at ASC
    ),
    '[]'::jsonb
  )
  INTO preview_items
  FROM public.dressing_room_items dri
  JOIN public.room_shares rs
    ON rs.room_id = dri.dressing_room_id
  WHERE rs.share_token = normalized_token
    AND rs.is_active = true
    AND rs.revoked_at IS NULL
    AND (rs.expires_at IS NULL OR rs.expires_at > now());

  RETURN jsonb_build_object(
    'status',                  'available',
    'shareToken',              shared_room.share_token,
    'roomTitle',               nullif(btrim(shared_room.room_title), ''),
    'itemCount',               public_item_count,
    'coverImageUrl',           cover_image,
    'coverImageStorageBucket', cover_storage_bucket,
    'coverImageStoragePath',   cover_storage_path,
    'sharedAt',                shared_room.shared_at,
    'items',                   preview_items
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_public_room_preview(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_room_preview(text) TO anon, authenticated;
