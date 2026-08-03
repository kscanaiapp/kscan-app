-- Perimeter hardening: remove unintended anon/public EXECUTE on public-schema
-- functions, and close an unauthenticated cross-user read path in
-- get_item_reaction_counts WITHOUT breaking the legitimate anonymous
-- public-room-preview caller (app/(public)/rooms/[token].tsx calls this RPC
-- unauthenticated via services/styleObjects.ts:587-589).
--
-- Context: this project's default privileges grant EXECUTE on newly created
-- public-schema functions to anon/public unless explicitly revoked (already
-- observed once and fixed for the provider_request_* functions in
-- 20260803020100_provider_request_security_revoke_anon.sql). This migration
-- applies the same revoke to the remaining pre-existing RPCs that have no
-- legitimate anonymous caller.
--
-- Target: yzqjvdfgefveprobvvyw (staging) ONLY. Do not run against production.

-- These RPCs already internally raise on auth.uid() IS NULL, so the anon
-- grant was never actually exploitable -- this is defense-in-depth, matching
-- the pattern already established for the provider_request_* functions, not
-- a fix for an active vulnerability. None of these have any anonymous
-- caller anywhere in the app (confirmed by repo-wide grep).
revoke execute on function public.check_and_increment_stylechat_burst(integer) from anon;
revoke execute on function public.create_look_from_dressing_room_items(uuid, text, text, uuid[]) from anon;
revoke execute on function public.create_or_get_room_share(uuid) from anon;
revoke execute on function public.revoke_room_share(uuid) from anon;
revoke execute on function public.upsert_style_memory_event(text, text, text, date, jsonb, numeric, jsonb) from anon;
revoke execute on function public.ensure_privacy_settings() from anon;
revoke execute on function public.increment_style_chat_usage() from anon;
revoke execute on function public.increment_stylechat_daily_usage() from anon;
revoke execute on function public.get_stylechat_daily_usage() from anon;

-- Trigger functions: PUBLIC execute is unused (triggers always execute as
-- the defining role regardless of caller grants; direct invocation would
-- fail anyway on a missing NEW/OLD record) but should not be left grantable.
revoke execute on function public.enforce_minor_privacy_defaults() from public;
revoke execute on function public.handle_new_user() from public;
revoke execute on function public.handle_new_user_privacy() from public;
revoke execute on function public.normalize_dressing_room_note() from public;
revoke execute on function public.set_profiles_updated_at() from public;
revoke execute on function public.set_provider_request_limits_updated_at() from public;
revoke execute on function public.set_style_objects_updated_at() from public;
revoke execute on function public.set_updated_at() from public;
revoke execute on function public.update_privacy_settings_updated_at() from public;

-- get_item_reaction_counts had NO access control at all (no auth.uid()
-- check, unlike every other RPC in this schema) -- any caller, including
-- anon, could pass arbitrary item UUIDs from any user's dressing room and
-- get back reaction counts. FIX: restrict to items whose dressing room is
-- either owned by the caller (authenticated path) OR currently has an
-- active, non-revoked, non-expired share (the legitimate anonymous
-- room-preview path) -- mirrors the predicate already used by
-- get_public_room_preview. anon keeps EXECUTE (required for the public
-- room-preview screen); the function body is now the actual gate.
create or replace function public.get_item_reaction_counts(p_item_ids uuid[])
returns table(item_id uuid, reaction_type text, count integer)
language sql
security definer
set search_path to 'public'
as $function$
  with input_items as (
    select distinct dri.id as item_id
    from unnest(coalesce(p_item_ids, '{}'::uuid[])) as value
    join public.dressing_room_items dri on dri.id = value
    join public.dressing_rooms dr on dr.id = dri.dressing_room_id
    where value is not null
      and (
        dr.user_id = auth.uid()
        or exists (
          select 1
          from public.room_shares rs
          where rs.room_id = dr.id
            and rs.is_active = true
            and rs.revoked_at is null
            and (rs.expires_at is null or rs.expires_at > now())
        )
      )
  ),
  reaction_types as (
    select value as reaction_type
    from (values ('like'), ('love'), ('looking'), ('thumbs_down')) as reactions(value)
  ),
  counts as (
    select
      drir.item_id,
      drir.reaction_type,
      count(*)::integer as reaction_count
    from public.dressing_room_item_reactions drir
    join input_items ii
      on ii.item_id = drir.item_id
    group by drir.item_id, drir.reaction_type
  )
  select
    ii.item_id,
    rt.reaction_type,
    coalesce(c.reaction_count, 0)::integer as count
  from input_items ii
  cross join reaction_types rt
  left join counts c
    on c.item_id = ii.item_id
   and c.reaction_type = rt.reaction_type
  order by ii.item_id, rt.reaction_type;
$function$;
