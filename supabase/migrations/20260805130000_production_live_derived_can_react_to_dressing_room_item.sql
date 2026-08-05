-- PRODUCTION-LIVE-DERIVED migration. This is NOT a recovered historical migration.
--
-- WHAT THIS IS. `public.can_react_to_dressing_room_item(uuid)` exists in the
-- production database, but no migration anywhere in this repository creates it.
-- Object-level comparison of the rebuilt baseline against production found it as
-- the single production function with no source of any kind — it is absent from
-- git history, from deleted branches, and from
-- supabase_migrations.schema_migrations.statements. It reached staging only
-- because production-lineage migrations that reference it were applied.
--
-- PROVENANCE. The body, return type, volatility, security mode, search_path and
-- execute grants below were read on 2026-08-05 from production
-- (wyyuqfdxucjksghsmhry) via `pg_get_functiondef` and `has_function_privilege`,
-- read-only. They are reproduced verbatim. Nothing is inferred, and no claim is
-- made that this file is the migration that originally created the function —
-- that migration does not exist and is not being fabricated.
--
-- WHY IT MATTERS. Without this file the baseline is not reproducible from source:
-- rebuilding either the shadow database or the staging project from
-- supabase/migrations alone yields a backend missing a function that the
-- dressing-room reaction RLS policies call. Adding it closes the last
-- source-authority gap found in Phase 1.
--
-- Production live attributes reproduced here:
--   returns          boolean
--   language         sql
--   volatility       STABLE
--   security         SECURITY DEFINER
--   search_path      public
--   owner            postgres
--   EXECUTE          anon=false, authenticated=true, service_role=true

create or replace function public.can_react_to_dressing_room_item(p_item_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select exists (
    select 1
    from public.dressing_room_items dri
    where dri.id = p_item_id
      and public.can_access_room_messages(dri.dressing_room_id)
  );
$function$;

-- Grants reproduce production exactly: anon holds no EXECUTE, authenticated and
-- service_role do. The revoke from PUBLIC is required because this project's
-- default privileges otherwise grant EXECUTE on new public-schema functions to
-- PUBLIC (which anon inherits) -- the same gap the
-- harden_public_rpc_execution_grants migrations closed for the other RPCs.
revoke all on function public.can_react_to_dressing_room_item(uuid) from public;
revoke all on function public.can_react_to_dressing_room_item(uuid) from anon;
grant execute on function public.can_react_to_dressing_room_item(uuid) to authenticated;
grant execute on function public.can_react_to_dressing_room_item(uuid) to service_role;

comment on function public.can_react_to_dressing_room_item(uuid) is
  'Production-live-derived 2026-08-05: definition read read-only from production; no historical migration source exists.';
