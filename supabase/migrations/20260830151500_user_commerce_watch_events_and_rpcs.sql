-- Build 34 / K+ Smart Watchlist V1 -- K5-C2b: Watch events + server-mediated
-- creation/lifecycle RPCs.
--
-- All five RPCs below are SECURITY DEFINER, callable only by service_role,
-- and take an explicit p_user_id / p_watch_id argument rather than reading
-- auth.uid() -- the sole caller is the commerce-watch-refresh Edge Function,
-- which verifies the end user's JWT itself (requireUser, _shared/deletion/
-- common.ts) before ever reaching these functions. This mirrors the existing
-- grant_kplus_early_access / kplus-activate pair exactly: business identity
-- is established once, in the Edge Function, and every RPC below trusts the
-- id it is given rather than re-deriving it from a session that does not
-- exist in a service-role call.

-- ── Watch events (bounded, meaningful-changes-only observation log) ───────

create table if not exists public.user_commerce_watch_events (
  id            uuid primary key default gen_random_uuid(),
  watch_id      uuid not null references public.user_commerce_watches(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  event_type    text not null,
  price_amount  numeric,
  currency      text,
  observed_at   timestamptz not null default now(),

  constraint user_commerce_watch_events_type_enum check (
    event_type in ('price_decreased', 'price_increased', 'target_price_reached', 'listing_unavailable', 'listing_available_again')
  ),
  constraint user_commerce_watch_events_price_positive check (price_amount is null or price_amount > 0),
  constraint user_commerce_watch_events_currency_format check (currency is null or currency ~ '^[A-Z]{3}$')
);

comment on table public.user_commerce_watch_events is
  'Build 34 K+ Smart Watchlist V1 (K5-C2b/C4). Append-only, meaningful-changes-only history for one Watch, bounded to the most recent N rows per watch by append_user_commerce_watch_event (never every poll -- C0 audit §22, §34). Written only by the commerce-watch-refresh Edge Function via service_role.';

create index if not exists user_commerce_watch_events_watch_idx
  on public.user_commerce_watch_events (watch_id, observed_at desc);

alter table public.user_commerce_watch_events enable row level security;

drop policy if exists "select own commerce watch events" on public.user_commerce_watch_events;
create policy "select own commerce watch events"
  on public.user_commerce_watch_events
  for select
  to authenticated
  using (user_id = auth.uid());

-- No client INSERT/UPDATE/DELETE: written only by append_user_commerce_watch_event
-- and removed only by delete_user_commerce_watch, both service_role-only RPCs.
revoke all on public.user_commerce_watch_events from anon, authenticated, public;
grant select on public.user_commerce_watch_events to authenticated;
grant select, insert, delete on public.user_commerce_watch_events to service_role;
revoke truncate, update, references, trigger, maintain on public.user_commerce_watch_events
  from anon, authenticated, service_role;

-- Bounded retention: keep at most this many event rows per watch. An
-- operational constant, not a product-facing retention promise (C0 audit §34
-- explicitly declines to pick this number without measured change-rate data;
-- 20 is a conservative starting cap, adjustable without a product decision).
create or replace function public.append_user_commerce_watch_event(
  p_watch_id uuid,
  p_user_id uuid,
  p_event_type text,
  p_price_amount numeric,
  p_currency text
)
returns public.user_commerce_watch_events
language plpgsql
security definer
set search_path = public
as $$
declare
  event_row public.user_commerce_watch_events;
  retain_count constant int := 20;
begin
  if p_watch_id is null or p_user_id is null then
    raise exception 'watch_id and user_id required' using errcode = '23502';
  end if;

  -- Ownership check even though this is service-role-only: a caller bug that
  -- mismatches watch_id/user_id must not silently write into another user's
  -- event history.
  if not exists (
    select 1 from public.user_commerce_watches
    where id = p_watch_id and user_id = p_user_id and deleted_at is null
  ) then
    raise exception 'watch not found for user' using errcode = 'P0002';
  end if;

  insert into public.user_commerce_watch_events (watch_id, user_id, event_type, price_amount, currency)
  values (p_watch_id, p_user_id, p_event_type, p_price_amount, p_currency)
  returning * into event_row;

  delete from public.user_commerce_watch_events
  where id in (
    select id from public.user_commerce_watch_events
    where watch_id = p_watch_id
    order by observed_at desc
    offset retain_count
  );

  return event_row;
end;
$$;

revoke all on function public.append_user_commerce_watch_event(uuid, uuid, text, numeric, text) from public, anon, authenticated;
grant execute on function public.append_user_commerce_watch_event(uuid, uuid, text, numeric, text) to service_role;

-- ── Server-mediated creation (§21, §26) ────────────────────────────────---

create or replace function public.create_user_commerce_watch(
  p_user_id uuid,
  p_source text,
  p_canonical_url text,
  p_provider_listing_id text,
  p_display_title text,
  p_display_image_url text,
  p_initial_price_amount numeric,
  p_currency text,
  p_watch_intent text,
  p_target_price_amount numeric
)
returns public.user_commerce_watches
language plpgsql
security definer
set search_path = public
as $$
declare
  watch_row public.user_commerce_watches;
  existing_id uuid;
  reached timestamptz;
begin
  if p_user_id is null then
    raise exception 'user_id required' using errcode = '23502';
  end if;
  -- K+ required to create (§26). Not re-checked on every later view/pause/
  -- delete -- only here, and again in resume_user_commerce_watch.
  if not public.kplus_has_active_entitlement(p_user_id, 'k_plus') then
    raise exception 'K+ required' using errcode = '42501';
  end if;

  -- Idempotent on (user, url): a double-tap or client retry returns the
  -- existing Watch rather than erroring or creating a second row. The
  -- caller is expected to have already re-validated URL safety and provider
  -- eligibility (watchlistCapability.ts) before calling this RPC -- this
  -- function trusts its arguments the same way create_deletion_request
  -- trusts its caller, not because the check happened here.
  select id into existing_id
  from public.user_commerce_watches
  where user_id = p_user_id and canonical_url = p_canonical_url and deleted_at is null;

  if existing_id is not null then
    select * into watch_row from public.user_commerce_watches where id = existing_id;
    return watch_row;
  end if;

  reached := case
    when p_watch_intent = 'buy_under'
      and p_target_price_amount is not null
      and p_initial_price_amount is not null
      and p_initial_price_amount <= p_target_price_amount
    then now()
    else null
  end;

  insert into public.user_commerce_watches (
    user_id, source, canonical_url, provider_listing_id, display_title, display_image_url,
    initial_price_amount, current_price_amount, currency, watch_intent, target_price_amount,
    target_reached_at, status, last_status
  ) values (
    p_user_id, p_source, p_canonical_url, p_provider_listing_id, p_display_title, p_display_image_url,
    p_initial_price_amount, p_initial_price_amount, p_currency, p_watch_intent, p_target_price_amount,
    reached, 'active', 'unchecked'
  )
  returning * into watch_row;

  return watch_row;
end;
$$;

revoke all on function public.create_user_commerce_watch(uuid, text, text, text, text, text, numeric, text, text, numeric) from public, anon, authenticated;
grant execute on function public.create_user_commerce_watch(uuid, text, text, text, text, text, numeric, text, text, numeric) to service_role;

-- ── Pause (never K+ gated -- §26) ──────────────────────────────────────---

create or replace function public.pause_user_commerce_watch(p_user_id uuid, p_watch_id uuid)
returns public.user_commerce_watches
language plpgsql
security definer
set search_path = public
as $$
declare
  watch_row public.user_commerce_watches;
begin
  update public.user_commerce_watches
  set status = 'paused'
  where id = p_watch_id and user_id = p_user_id and deleted_at is null and status <> 'paused'
  returning * into watch_row;

  if watch_row.id is null then
    select * into watch_row from public.user_commerce_watches
    where id = p_watch_id and user_id = p_user_id and deleted_at is null;
  end if;

  if watch_row.id is null then
    raise exception 'watch not found' using errcode = 'P0002';
  end if;

  return watch_row;
end;
$$;

revoke all on function public.pause_user_commerce_watch(uuid, uuid) from public, anon, authenticated;
grant execute on function public.pause_user_commerce_watch(uuid, uuid) to service_role;

-- ── Resume (K+ required -- §26: monitoring is a K+ capability) ────────---

create or replace function public.resume_user_commerce_watch(p_user_id uuid, p_watch_id uuid)
returns public.user_commerce_watches
language plpgsql
security definer
set search_path = public
as $$
declare
  watch_row public.user_commerce_watches;
begin
  if not public.kplus_has_active_entitlement(p_user_id, 'k_plus') then
    raise exception 'K+ required' using errcode = '42501';
  end if;

  update public.user_commerce_watches
  set status = 'active'
  where id = p_watch_id and user_id = p_user_id and deleted_at is null and status = 'paused'
  returning * into watch_row;

  if watch_row.id is null then
    select * into watch_row from public.user_commerce_watches
    where id = p_watch_id and user_id = p_user_id and deleted_at is null;
  end if;

  if watch_row.id is null then
    raise exception 'watch not found' using errcode = 'P0002';
  end if;

  return watch_row;
end;
$$;

revoke all on function public.resume_user_commerce_watch(uuid, uuid) from public, anon, authenticated;
grant execute on function public.resume_user_commerce_watch(uuid, uuid) to service_role;

-- ── Delete (never K+ gated -- §26; non-destructive to everything else) ---
--
-- Hostile regression test W-14 / §60: soft-deletes the Watch (tombstone,
-- matching the soft-delete-only convention every other table here uses) AND
-- hard-deletes its event rows in the same statement-level transaction.
-- Recent Scans / purchase_options are never referenced by this function --
-- they have no foreign key relationship to a Watch at all (§17, §60), so
-- there is nothing here that could reach them.
create or replace function public.delete_user_commerce_watch(p_user_id uuid, p_watch_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  affected int;
begin
  delete from public.user_commerce_watch_events
  where watch_id = p_watch_id and user_id = p_user_id;

  update public.user_commerce_watches
  set status = 'deleted', deleted_at = now()
  where id = p_watch_id and user_id = p_user_id and deleted_at is null;
  get diagnostics affected = row_count;

  return affected > 0;
end;
$$;

revoke all on function public.delete_user_commerce_watch(uuid, uuid) from public, anon, authenticated;
grant execute on function public.delete_user_commerce_watch(uuid, uuid) to service_role;
