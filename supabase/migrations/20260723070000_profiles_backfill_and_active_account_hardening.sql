-- Repair for Finding P1-10 (production): valid authenticated users without a
-- public.profiles row were denied by the account-state enforcement
-- (assertAccountActive maps a missing profile to null status -> 403, and the
-- new is_active_account() RESTRICTIVE RLS returns false for them), breaking
-- Scanner (scan-identify), TextScan, and Elise (stylechat-generate) before
-- the LLM route was reached.
--
-- Root cause: the handle_new_user() AFTER INSERT trigger provisions profiles
-- atomically for all NEW users, but a small number of legacy/import users
-- created before the trigger existed never got a profile row.
--
-- Guardrail: "missing profile" must NEVER become an alternate path around
-- deletion / banning / deactivation, and must NOT permanently lock out a user
-- because of a HISTORICAL deletion row that was later restored/cancelled. The
-- deletion check therefore uses the CURRENT EFFECTIVE (latest) deletion state,
-- not the existence of any historical blocking row. Forward-only, idempotent.
--
-- Precedence for missing-profile compatibility:
--   1. Auth user soft-deleted      -> blocked
--   2. Auth user currently banned  -> blocked
--   3. (profile absent, so profiles.account_status precedence is N/A here)
--   4. LATEST deletion request is a blocking state -> blocked
--   5. otherwise                   -> eligible (backfill / treated active)
--
-- deletion_requests status universe (check constraint): pending, processing,
-- completed, rejected, cancelled, deactivated, restored, purging, purged,
-- failed, legal_hold. Blocking (account is being / was left mid deletion):
--   pending, processing, completed, deactivated, purging, legal_hold, failed
-- Non-blocking terminal (deletion resolved without removing the account):
--   restored, cancelled, rejected, purged
-- `failed` blocks only while it is the LATEST state; a later restored/cancelled
-- row supersedes it, so a historical failed attempt never locks a user out.

-- ---------------------------------------------------------------------------
-- (1) Backfill. Insert-only (ON CONFLICT DO NOTHING) so it never resets an
--     existing pending_deletion / locked / other state. Restricted to Auth
--     users that are legitimate right now AND whose LATEST deletion request
--     (if any) is not a blocking state.
-- ---------------------------------------------------------------------------
insert into public.profiles (id, email, account_status)
select u.id, u.email, 'active'
from auth.users u
left join public.profiles p on p.id = u.id
where p.id is null
  and u.deleted_at is null
  and (u.banned_until is null or u.banned_until <= now())
  and coalesce(
        (select dr.status
         from public.deletion_requests dr
         where dr.user_id = u.id
         order by dr.requested_at desc nulls last, dr.id desc
         limit 1),
        'none'
      ) not in (
        'pending', 'processing', 'completed',
        'deactivated', 'purging', 'legal_hold', 'failed'
      )
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- (2) Harden future provisioning. Trigger already fires atomically on insert;
--     make account_status explicit so a future column-default change cannot
--     silently alter provisioning. CRITICAL: on conflict, sync email ONLY --
--     never reset account_status (that would reactivate a pending_deletion
--     account). SECURITY DEFINER, EMPTY search_path, fully schema-qualified.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, account_status)
  values (new.id, new.email, 'active')
  on conflict (id) do update
    set email = excluded.email;   -- status intentionally preserved
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- (3) Harden is_active_account(). Profile present -> enforce it strictly
--     (unchanged; keeps pending_deletion / locked fail-closed). Profile absent
--     -> allow ONLY when the Auth user is genuinely active AND the LATEST
--     deletion request is not a blocking state. Uses effective (latest) state
--     so restored/cancelled supersede historical blocking rows.
-- ---------------------------------------------------------------------------
create or replace function public.is_active_account()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
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
$$;

revoke all on function public.is_active_account() from public;
grant execute on function public.is_active_account() to authenticated, service_role;
