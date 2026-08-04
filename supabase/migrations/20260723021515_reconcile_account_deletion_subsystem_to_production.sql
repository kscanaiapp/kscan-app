-- FORWARD-ONLY RECONCILIATION. THIS IS NOT HISTORICAL SQL.
--
-- This migration was authored on 2026-08-04. It does not reproduce, and does not
-- claim to reproduce, whatever statements were originally applied to production at
-- version 20260723021514 (account_deletion_security_hardening). Production's
-- migration history row for that version holds a placeholder -- the literal text
-- "-- applied from 20260723021145_..._security_hardening.sql via file contents in
-- follow-up if needed" plus "select 1;" -- so the original artefact is unrecoverable.
--
-- WHY IT EXISTS: the historical file 20260723021145_account_deletion_security_hardening.sql
-- cannot execute after 20260722191013_account_deletion_lifecycle.sql. It issues
-- CREATE OR REPLACE on public.schedule_deletion_retry_or_fail with a different return
-- type (text -> boolean), which PostgreSQL rejects:
--     ERROR: cannot change return type of existing function
-- Proven by shadow apply on a faithful staging baseline, 2026-08-04.
--
-- WHAT IT DOES: the historical migration is a superseded superset. Almost everything
-- it created is re-created correctly by the two byte-exact, production-recovered
-- migrations that follow it -- 20260723021635 (device sessions, which drops and
-- recreates revoke_user_sessions) and 20260723021735 (claim/retry/peek v2, which drops
-- and recreates schedule_deletion_retry_or_fail). Only three objects are unique to it,
-- and migration 20260723021635 cannot be applied without the first of them, because its
-- RLS policy calls public.is_active_account() and a policy expression requires the
-- function to exist at CREATE time.
--
-- Every definition below is derived from PRODUCTION LIVE SCHEMA
-- (project wyyuqfdxucjksghsmhry), captured read-only via pg_get_functiondef() and
-- pg_policy on 2026-08-04. Production live schema is the behavioural authority.
--
-- Objects reconciled to the production contract:
--   1. public.is_active_account()                 -- sql, STABLE, SECURITY DEFINER, search_path ''
--   2. public.set_deletion_requests_updated_at()  -- plpgsql, SECURITY DEFINER, search_path 'public'
--   3. policy "Users can read own profile" on public.profiles
--
-- The superseded historical migrations 20260722191013 and 20260723021145 are left
-- unchanged on disk for audit. This migration does not edit migration history, does not
-- delete or truncate user data, does not reset anything, and changes no unrelated schema.
--
-- Run transactionally. Every assertion below aborts the whole migration on failure.

-- ---------------------------------------------------------------------------
-- Starting-state assertions. Fail closed: if the environment is not what this
-- reconciliation was written against, change nothing.
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.profiles') is null then
    raise exception 'RECONCILE ABORT: public.profiles is missing; expected the deletion lifecycle migration to have run first';
  end if;

  if to_regclass('public.deletion_requests') is null then
    raise exception 'RECONCILE ABORT: public.deletion_requests is missing; expected the deletion lifecycle migration to have run first';
  end if;

  -- is_active_account() reads these columns; without them it would compile but
  -- fail at runtime inside every RLS policy that calls it.
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles' and column_name = 'account_status'
  ) then
    raise exception 'RECONCILE ABORT: public.profiles.account_status is missing';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles' and column_name = 'account_locked_at'
  ) then
    raise exception 'RECONCILE ABORT: public.profiles.account_locked_at is missing';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'deletion_requests' and column_name = 'status'
  ) then
    raise exception 'RECONCILE ABORT: public.deletion_requests.status is missing';
  end if;

  -- If a conflicting is_active_account already exists with a different return
  -- type, CREATE OR REPLACE below would fail mid-migration. Refuse up front.
  if exists (
    select 1
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'is_active_account'
      and pg_get_function_identity_arguments(p.oid) = ''
      and pg_get_function_result(p.oid) <> 'boolean'
  ) then
    raise exception 'RECONCILE ABORT: public.is_active_account() exists with a non-boolean return type; drop it deliberately before reconciling';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. public.is_active_account()
--    Body copied verbatim from production pg_get_functiondef().
--    Production attributes: LANGUAGE sql, STABLE, SECURITY DEFINER, search_path ''.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_active_account()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select case
    when exists (select 1 from public.profiles p where p.id = auth.uid()) then
      exists (
        select 1
        from public.profiles p
        where p.id = auth.uid()
          and coalesce(p.account_status, 'active') = 'active'
          and p.account_locked_at is null
      )
    else
      exists (
        select 1
        from auth.users u
        where u.id = auth.uid()
          and u.deleted_at is null
          and (u.banned_until is null or u.banned_until <= now())
      )
      and coalesce(
        (select dr.status
         from public.deletion_requests dr
         where dr.user_id = auth.uid()
         order by dr.requested_at desc nulls last, dr.id desc
         limit 1),
        'none'
      ) not in (
        'pending', 'processing', 'completed',
        'deactivated', 'purging', 'legal_hold', 'failed'
      )
  end;
$function$;

-- Production EXECUTE grants: postgres, service_role, authenticated. Not anon, not PUBLIC.
revoke all on function public.is_active_account() from public;
revoke all on function public.is_active_account() from anon;
grant execute on function public.is_active_account() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. public.set_deletion_requests_updated_at()
--    The lifecycle migration creates this as SECURITY INVOKER with no search_path.
--    Production runs it SECURITY DEFINER with search_path 'public'.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_deletion_requests_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  new.updated_at = now();
  return new;
end;
$function$;

-- Production EXECUTE grants: postgres and service_role only. This is a TRIGGER
-- function; it fires through the table trigger machinery and never needs a direct
-- grant. 20260723132813 later revokes the same surface -- consistent, idempotent.
revoke all on function public.set_deletion_requests_updated_at() from public;
revoke all on function public.set_deletion_requests_updated_at() from anon, authenticated;
grant execute on function public.set_deletion_requests_updated_at() to service_role;

-- ---------------------------------------------------------------------------
-- 3. Policy "Users can read own profile" on public.profiles
--    Production: PERMISSIVE, SELECT, TO authenticated, USING (id = auth.uid()).
--    Dropped and recreated so the definition matches production exactly rather
--    than inheriting whatever an earlier migration left behind.
-- ---------------------------------------------------------------------------
drop policy if exists "Users can read own profile" on public.profiles;
create policy "Users can read own profile"
  on public.profiles
  as permissive
  for select
  to authenticated
  using (id = auth.uid());

-- ---------------------------------------------------------------------------
-- Post-condition assertions. If the reconciliation did not achieve the production
-- contract, abort so nothing is recorded as applied.
-- ---------------------------------------------------------------------------
do $$
declare
  v_secdef boolean;
  v_volatile "char";
  v_config text;
begin
  select p.prosecdef, p.provolatile, coalesce(array_to_string(p.proconfig, ','), '')
    into v_secdef, v_volatile, v_config
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'is_active_account';

  if v_secdef is distinct from true then
    raise exception 'RECONCILE ABORT: is_active_account() is not SECURITY DEFINER';
  end if;
  if v_volatile is distinct from 's' then
    raise exception 'RECONCILE ABORT: is_active_account() is not STABLE';
  end if;
  if v_config is distinct from 'search_path=""' then
    raise exception 'RECONCILE ABORT: is_active_account() search_path is % (expected empty)', v_config;
  end if;

  select p.prosecdef, coalesce(array_to_string(p.proconfig, ','), '')
    into v_secdef, v_config
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'set_deletion_requests_updated_at';

  if v_secdef is distinct from true then
    raise exception 'RECONCILE ABORT: set_deletion_requests_updated_at() is not SECURITY DEFINER';
  end if;
  if v_config is distinct from 'search_path=public' then
    raise exception 'RECONCILE ABORT: set_deletion_requests_updated_at() search_path is % (expected public)', v_config;
  end if;

  if not exists (
    select 1 from pg_policy pol
    join pg_class c on c.oid = pol.polrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'profiles'
      and pol.polname = 'Users can read own profile'
  ) then
    raise exception 'RECONCILE ABORT: profiles policy "Users can read own profile" was not created';
  end if;
end $$;
