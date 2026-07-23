-- Repair for Finding P1-10 (production): valid authenticated users without a
-- public.profiles row were denied by the account-state enforcement
-- (assertAccountActive maps a missing profile to null status -> 403, and the
-- new is_active_account() RESTRICTIVE RLS returns false for them), breaking
-- Scanner (scan-identify), TextScan, and Elise (stylechat-generate) before
-- the LLM route was reached.
--
-- Root cause: the handle_new_user() AFTER INSERT trigger on auth.users
-- provisions profiles atomically for all NEW users, but a small number of
-- legacy/import users created before the trigger existed never got a profile
-- row. This migration is forward-only and idempotent: it (1) backfills
-- profiles for legitimate active Auth users missing one, (2) hardens the
-- provisioning trigger to be explicit about account_status, and (3) hardens
-- is_active_account() so a missing profile no longer blocks a genuinely
-- active Auth user, WITHOUT weakening fail-closed blocking for
-- pending_deletion / locked / banned / deleted accounts.

-- ---------------------------------------------------------------------------
-- (1) Backfill. Only for Auth users that are genuinely legitimate right now:
--     not soft-deleted and not currently banned. A banned/deleted Auth user
--     missing a profile is intentionally left without one so the guards keep
--     failing closed for it. Idempotent: on-conflict no-op, and re-running
--     finds nothing left to insert. profiles.account_status defaults to
--     'active' and account_locked_at defaults to null.
-- ---------------------------------------------------------------------------
insert into public.profiles (id, email)
select u.id, u.email
from auth.users u
where u.deleted_at is null
  and (u.banned_until is null or u.banned_until <= now())
  and not exists (select 1 from public.profiles p where p.id = u.id)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- (2) Harden future provisioning. The trigger already fires atomically on
--     insert; make the account_status explicit so a future change to the
--     column default cannot silently change what new users are provisioned
--     with. Behaviour is otherwise identical (id + email, on-conflict merge
--     of email). SECURITY DEFINER + fixed search_path preserved.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, account_status)
  values (new.id, new.email, 'active')
  on conflict (id) do update
    set email = excluded.email;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- (3) Harden is_active_account(). Previously returned false for ANY user
--     without a profile row, which (via the RESTRICTIVE RLS policies added in
--     20260723050000) blocked legitimate active users from their own data.
--     Now: if a profile exists, enforce it strictly (unchanged -- this is
--     what keeps pending_deletion / locked users fail-closed). If NO profile
--     exists, allow only when the Auth user is genuinely active (exists, not
--     soft-deleted, not currently banned). SECURITY DEFINER (owned by the
--     migration role) can read auth.users.
-- ---------------------------------------------------------------------------
create or replace function public.is_active_account()
returns boolean
language sql
stable
security definer
set search_path = public
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
  end;
$$;

revoke all on function public.is_active_account() from public;
grant execute on function public.is_active_account() to authenticated, service_role;
