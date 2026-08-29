-- K+ product-tier entitlement boundary (B34 K+ Foundation).
--
-- Server-authoritative "does this user currently have K+" contract. One
-- current-state row per (user_id, entitlement_key) in user_entitlements;
-- append-only history in kplus_activation_events. Mutation is SECURITY
-- DEFINER RPC / service_role only -- authenticated users may only SELECT
-- their own row. Client can never choose user_id, expires_at, grant_reason,
-- or extend/restart a grant.
--
-- Complimentary campaign semantics (kplus_early_access_2026): one atomic,
-- idempotent, six-calendar-month grant per user, enforced by the unique
-- (user_id, entitlement_key) constraint + INSERT ... ON CONFLICT DO NOTHING.
-- A second activation call (same device, second device, or after expiry)
-- always returns the original grant -- it never extends or restarts it.

create table if not exists public.user_entitlements (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references auth.users(id) on delete cascade,
  entitlement_key       text not null,
  status                text not null default 'active'
                          check (status in ('active', 'expired', 'revoked')),
  grant_reason          text not null
                          check (grant_reason in (
                            'complimentary_early_access', 'staff', 'admin',
                            'promo', 'trial', 'paid_ios', 'paid_android'
                          )),
  campaign_key          text,
  granted_at            timestamptz not null default now(),
  expires_at            timestamptz,
  revoked_at            timestamptz,
  acknowledged_at       timestamptz,
  terms_version         text,
  external_provider     text,
  external_customer_id  text,
  external_sync_status  text not null default 'not_required'
                          check (external_sync_status in (
                            'not_required', 'pending', 'synced',
                            'failed_retryable', 'failed_terminal'
                          )),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (user_id, entitlement_key)
);

comment on table public.user_entitlements is
  'Current-state K+ (and future) product entitlements. One row per (user_id, entitlement_key). Mutation is RPC/service_role only -- see grant_kplus_early_access.';
comment on column public.user_entitlements.entitlement_key is
  'e.g. k_plus. Capability-specific keys (voice_scan, style_dna) are future-reserved, not enabled by this migration.';
comment on column public.user_entitlements.external_sync_status is
  'RevenueCat mirror status. Never gates local access -- complimentary K+ remains valid even when this is pending/failed.';

create index if not exists user_entitlements_user_idx
  on public.user_entitlements (user_id);
create index if not exists user_entitlements_pending_sync_idx
  on public.user_entitlements (updated_at)
  where external_sync_status in ('pending', 'failed_retryable');

alter table public.user_entitlements enable row level security;

drop policy if exists "Users can select own entitlements" on public.user_entitlements;
create policy "Users can select own entitlements"
  on public.user_entitlements
  for select
  to authenticated
  using (auth.uid() = user_id);

-- No insert/update/delete policy for authenticated or anon at all: mutation
-- exists only through the SECURITY DEFINER RPCs below, executable only by
-- service_role (the activation Edge Function derives the caller's identity
-- from their verified JWT and is the sole trusted intermediary).
revoke all on public.user_entitlements from anon, authenticated, public;
grant select on public.user_entitlements to authenticated;
grant select, insert, update, delete on public.user_entitlements to service_role;
revoke truncate, references, trigger, maintain on public.user_entitlements
  from anon, authenticated, service_role;

create or replace function public.set_user_entitlements_updated_at()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

revoke all on function public.set_user_entitlements_updated_at() from public;
grant execute on function public.set_user_entitlements_updated_at() to service_role;

do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'user_entitlements_updated_at'
      and tgrelid = 'public.user_entitlements'::regclass
  ) then
    create trigger user_entitlements_updated_at
      before update on public.user_entitlements
      for each row
      execute function public.set_user_entitlements_updated_at();
  end if;
end;
$$;

-- Append-only activation/sync audit trail. No update or delete grant to
-- anyone (including service_role) -- corrections are new rows, not edits.
create table if not exists public.kplus_activation_events (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  event_type      text not null
                    check (event_type in (
                      'activation_granted', 'activation_already_active',
                      'activation_campaign_consumed',
                      'revenuecat_sync_attempted', 'revenuecat_sync_succeeded',
                      'revenuecat_sync_failed'
                    )),
  campaign_key    text,
  entitlement_key text,
  detail          jsonb,
  created_at      timestamptz not null default now()
);

comment on table public.kplus_activation_events is
  'Append-only audit trail for K+ activation and RevenueCat sync attempts. Never updated or deleted (except via account-deletion cascade).';

create index if not exists kplus_activation_events_user_idx
  on public.kplus_activation_events (user_id, created_at desc);

alter table public.kplus_activation_events enable row level security;
-- No SELECT policy for authenticated/anon: this is an internal audit trail,
-- not a user-facing activity feed. Owner/service tooling reads via service_role.
revoke all on public.kplus_activation_events from anon, authenticated, public;
grant select, insert on public.kplus_activation_events to service_role;
revoke update, delete, truncate, references, trigger, maintain
  on public.kplus_activation_events from anon, authenticated, service_role;

-- ── Activation RPC ────────────────────────────────────────────────────────
-- Callable only by service_role. The Edge Function is the sole caller and is
-- the only place p_user_id is ever set, always derived from the caller's
-- verified JWT -- never from a client-supplied field. Atomic and
-- concurrency-safe via the unique (user_id, entitlement_key) constraint:
-- two simultaneous callers race on the INSERT, exactly one wins, the other
-- falls through to the SELECT and observes the winner's row unchanged.
create or replace function public.grant_kplus_early_access(p_user_id uuid)
returns table (
  entitlement_key text,
  status          text,
  grant_reason    text,
  campaign_key    text,
  granted_at      timestamptz,
  expires_at      timestamptz,
  newly_granted   boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_campaign_key    constant text := 'kplus_early_access_2026';
  v_entitlement_key constant text := 'k_plus';
  v_terms_version   constant text := 'kplus_early_access_v1';
  v_now             timestamptz := now();
  v_row             public.user_entitlements;
  v_inserted        boolean := false;
begin
  if p_user_id is null then
    raise exception 'p_user_id is required' using errcode = '22004';
  end if;

  insert into public.user_entitlements (
    user_id, entitlement_key, status, grant_reason, campaign_key,
    granted_at, expires_at, acknowledged_at, terms_version, external_sync_status
  )
  values (
    p_user_id, v_entitlement_key, 'active', 'complimentary_early_access', v_campaign_key,
    v_now, v_now + interval '6 months', v_now, v_terms_version, 'pending'
  )
  on conflict (user_id, entitlement_key) do nothing
  returning * into v_row;

  if found then
    v_inserted := true;
  else
    select * into v_row
      from public.user_entitlements
     where user_id = p_user_id and entitlement_key = v_entitlement_key;
  end if;

  insert into public.kplus_activation_events (user_id, event_type, campaign_key, entitlement_key, detail)
  values (
    p_user_id,
    case
      when v_inserted then 'activation_granted'
      when v_row.status = 'active' and v_row.expires_at is not null and v_row.expires_at > v_now
        then 'activation_already_active'
      else 'activation_campaign_consumed'
    end,
    v_campaign_key,
    v_entitlement_key,
    jsonb_build_object('newly_granted', v_inserted)
  );

  return query select
    v_row.entitlement_key, v_row.status, v_row.grant_reason, v_row.campaign_key,
    v_row.granted_at, v_row.expires_at, v_inserted;
end;
$$;

revoke all on function public.grant_kplus_early_access(uuid) from public, anon, authenticated;
grant execute on function public.grant_kplus_early_access(uuid) to service_role;

-- ── Server-side capability check (future Voice Scan / K+ features) ────────
-- Never trusts a client flag. Callers (Edge Functions) pass the caller's own
-- JWT-derived user id via service_role -- this function is not reachable by
-- authenticated/anon directly.
create or replace function public.kplus_has_active_entitlement(
  p_user_id uuid,
  p_entitlement_key text default 'k_plus'
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.user_entitlements
    where user_id = p_user_id
      and entitlement_key = p_entitlement_key
      and status = 'active'
      and revoked_at is null
      and expires_at is not null
      and expires_at > now()
  );
$$;

revoke all on function public.kplus_has_active_entitlement(uuid, text) from public, anon, authenticated;
grant execute on function public.kplus_has_active_entitlement(uuid, text) to service_role;

-- ── RevenueCat sync bookkeeping (service_role only) ────────────────────────
-- Never touches granted_at/expires_at/grant_reason -- sync status is purely
-- a mirror-health field. Safe to call repeatedly (idempotent overwrite).
create or replace function public.set_kplus_revenuecat_sync_status(
  p_user_id uuid,
  p_entitlement_key text,
  p_status text,
  p_external_customer_id text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_status not in ('not_required', 'pending', 'synced', 'failed_retryable', 'failed_terminal') then
    raise exception 'invalid external_sync_status: %', p_status using errcode = '22023';
  end if;

  update public.user_entitlements
     set external_sync_status = p_status,
         external_provider = coalesce(external_provider, 'revenuecat'),
         external_customer_id = coalesce(p_external_customer_id, external_customer_id),
         updated_at = now()
   where user_id = p_user_id
     and entitlement_key = p_entitlement_key;

  insert into public.kplus_activation_events (user_id, event_type, entitlement_key, detail)
  values (
    p_user_id,
    case
      when p_status = 'synced' then 'revenuecat_sync_succeeded'
      when p_status in ('failed_retryable', 'failed_terminal') then 'revenuecat_sync_failed'
      else 'revenuecat_sync_attempted'
    end,
    p_entitlement_key,
    jsonb_build_object('status', p_status)
  );
end;
$$;

revoke all on function public.set_kplus_revenuecat_sync_status(uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.set_kplus_revenuecat_sync_status(uuid, text, text, text)
  to service_role;

-- Bounded lookup for the reconciliation Edge Function -- never an unbounded
-- background loop, always a capped, explicitly-invoked batch.
create or replace function public.list_kplus_pending_revenuecat_sync(p_limit integer default 25)
returns setof public.user_entitlements
language sql
stable
security definer
set search_path = public
as $$
  select *
    from public.user_entitlements
   where external_sync_status in ('pending', 'failed_retryable')
   order by updated_at asc
   limit greatest(1, least(coalesce(p_limit, 25), 200));
$$;

revoke all on function public.list_kplus_pending_revenuecat_sync(integer)
  from public, anon, authenticated;
grant execute on function public.list_kplus_pending_revenuecat_sync(integer)
  to service_role;
