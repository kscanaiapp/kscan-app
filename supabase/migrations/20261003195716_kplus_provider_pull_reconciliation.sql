-- K Scan AI -- Build 35 Phase E: inbound RevenueCat state reconciliation.
--
-- This migration adds orchestration and evidence around the existing provider
-- transition authority. It deliberately does not add another entitlement
-- resolver or a second grant-writing path: both reconciliation wrappers call
-- apply_kplus_provider_transition / apply_kplus_provider_lifetime_transition
-- while holding the same per-actor transaction advisory lock used by webhooks.

-- --------------------------------------------------------------------------
-- 1. Pull observation evidence on the established transition ledger.
-- --------------------------------------------------------------------------

alter table public.kplus_entitlement_transitions
  add column if not exists observed_at timestamptz;

comment on column public.kplus_entitlement_transitions.observed_at is
  'K Scan observation time for provider_reconciliation snapshots. It is receipt evidence only and is never used as provider chronology or deterministic state identity.';

create or replace function public.kplus_stamp_provider_reconciliation_observation()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.cause = 'provider_reconciliation' then
    new.observed_at := coalesce(new.observed_at, now());
  else
    new.observed_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists kplus_stamp_provider_reconciliation_observation
  on public.kplus_entitlement_transitions;
create trigger kplus_stamp_provider_reconciliation_observation
before insert on public.kplus_entitlement_transitions
for each row execute function public.kplus_stamp_provider_reconciliation_observation();

-- Any valid pull observation, including stale and duplicate evidence, refreshes
-- only the verification watermark. It never changes lifecycle state here.
create or replace function public.kplus_refresh_provider_verification_from_observation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_grant_id uuid;
  v_verified_at timestamptz;
begin
  if tg_op = 'INSERT' then
    if new.cause <> 'provider_reconciliation' or new.grant_id is null then
      return new;
    end if;
    v_grant_id := new.grant_id;
    v_verified_at := new.observed_at;
  else
    if old.cause <> 'provider_reconciliation' or new.grant_id is null
       or new.last_duplicate_at is not distinct from old.last_duplicate_at then
      return new;
    end if;
    v_grant_id := new.grant_id;
    v_verified_at := new.last_duplicate_at;
  end if;

  update public.kplus_entitlement_grants
     set last_provider_verified_at = greatest(
           coalesce(last_provider_verified_at, '-infinity'::timestamptz),
           v_verified_at
         ),
         updated_at = greatest(updated_at, v_verified_at)
   where id = v_grant_id;
  return new;
end;
$$;

drop trigger if exists kplus_refresh_provider_verification_insert
  on public.kplus_entitlement_transitions;
create trigger kplus_refresh_provider_verification_insert
after insert on public.kplus_entitlement_transitions
for each row execute function public.kplus_refresh_provider_verification_from_observation();

drop trigger if exists kplus_refresh_provider_verification_duplicate
  on public.kplus_entitlement_transitions;
create trigger kplus_refresh_provider_verification_duplicate
after update of last_duplicate_at on public.kplus_entitlement_transitions
for each row execute function public.kplus_refresh_provider_verification_from_observation();

-- --------------------------------------------------------------------------
-- 2. Per-actor provider-call lease and configurable cooldown.
-- --------------------------------------------------------------------------

create table if not exists public.kplus_provider_reconciliation_controls (
  user_id             uuid not null references auth.users(id) on delete cascade,
  provider            text not null,
  provider_environment text not null,
  claim_token         uuid,
  in_flight_until     timestamptz,
  cooldown_until      timestamptz,
  last_requested_at   timestamptz,
  last_completed_at   timestamptz,
  last_outcome        text,
  updated_at          timestamptz not null default now(),
  primary key (user_id, provider, provider_environment),
  constraint kplus_provider_reconcile_control_provider_check
    check (provider = 'revenuecat'),
  constraint kplus_provider_reconcile_control_environment_check
    check (provider_environment in ('production', 'sandbox')),
  constraint kplus_provider_reconcile_control_claim_check
    check ((claim_token is null) = (in_flight_until is null)),
  constraint kplus_provider_reconcile_control_outcome_check
    check (last_outcome is null or last_outcome in (
      'resolved', 'no_drift', 'unresolved_drift', 'provider_unavailable',
      'provider_throttled', 'rejected', 'transition_failed'
    ))
);

alter table public.kplus_provider_reconciliation_controls enable row level security;
revoke all on public.kplus_provider_reconciliation_controls from public, anon, authenticated, service_role;
grant select on public.kplus_provider_reconciliation_controls to service_role;

create or replace function public.claim_kplus_provider_reconciliation(
  p_user_id uuid,
  p_environment text,
  p_cooldown_seconds integer,
  p_lease_seconds integer,
  p_force boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_row public.kplus_provider_reconciliation_controls;
  v_token uuid := gen_random_uuid();
  v_is_anonymous boolean;
begin
  if p_user_id is null or p_environment not in ('production', 'sandbox')
     or p_cooldown_seconds not between 0 and 86400
     or p_lease_seconds not between 5 and 300 then
    raise exception 'invalid reconciliation claim parameters' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'kplus_provider_reconcile:' || p_user_id::text || ':' || p_environment, 0));

  select u.is_anonymous into v_is_anonymous from auth.users u where u.id = p_user_id;
  if not found then
    return jsonb_build_object('classification', 'rejected', 'reason', 'unknown_user');
  end if;
  if coalesce(v_is_anonymous, false) then
    return jsonb_build_object('classification', 'rejected', 'reason', 'anonymous_identity');
  end if;

  insert into public.kplus_provider_reconciliation_controls (
    user_id, provider, provider_environment, updated_at
  ) values (p_user_id, 'revenuecat', p_environment, v_now)
  on conflict (user_id, provider, provider_environment) do nothing;

  select * into v_row
    from public.kplus_provider_reconciliation_controls
   where user_id = p_user_id and provider = 'revenuecat'
     and provider_environment = p_environment
   for update;

  if v_row.in_flight_until is not null and v_row.in_flight_until > v_now then
    return jsonb_build_object(
      'classification', 'in_flight',
      'retryAfterSeconds', greatest(1, ceil(extract(epoch from (v_row.in_flight_until - v_now)))::integer)
    );
  end if;

  if not p_force and v_row.cooldown_until is not null and v_row.cooldown_until > v_now then
    return jsonb_build_object(
      'classification', 'cooldown',
      'retryAfterSeconds', greatest(1, ceil(extract(epoch from (v_row.cooldown_until - v_now)))::integer)
    );
  end if;

  update public.kplus_provider_reconciliation_controls
     set claim_token = v_token,
         in_flight_until = v_now + make_interval(secs => p_lease_seconds),
         last_requested_at = v_now,
         cooldown_until = v_now + make_interval(secs => p_cooldown_seconds),
         updated_at = v_now
   where user_id = p_user_id and provider = 'revenuecat'
     and provider_environment = p_environment;

  return jsonb_build_object('classification', 'claimed', 'claimToken', v_token);
end;
$$;

create or replace function public.finish_kplus_provider_reconciliation(
  p_user_id uuid,
  p_environment text,
  p_claim_token uuid,
  p_outcome text
)
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_changed integer;
begin
  if p_outcome not in (
    'resolved', 'no_drift', 'unresolved_drift', 'provider_unavailable',
    'provider_throttled', 'rejected', 'transition_failed'
  ) then
    raise exception 'invalid reconciliation outcome' using errcode = '22023';
  end if;
  update public.kplus_provider_reconciliation_controls
     set claim_token = null,
         in_flight_until = null,
         last_completed_at = now(),
         last_outcome = p_outcome,
         updated_at = now()
   where user_id = p_user_id and provider = 'revenuecat'
     and provider_environment = p_environment
     and claim_token = p_claim_token;
  get diagnostics v_changed = row_count;
  return v_changed = 1;
end;
$$;

-- --------------------------------------------------------------------------
-- 3. Shared, private product lookup cache.
-- --------------------------------------------------------------------------

create table if not exists public.kplus_revenuecat_product_cache (
  project_ref_digest   text not null,
  product_ref_digest   text not null,
  store_identifier     text not null,
  product_type         text not null,
  cached_at            timestamptz not null default now(),
  expires_at           timestamptz not null,
  primary key (project_ref_digest, product_ref_digest),
  constraint kplus_rc_product_cache_project_digest_check
    check (project_ref_digest ~ '^[0-9a-f]{64}$'),
  constraint kplus_rc_product_cache_product_digest_check
    check (product_ref_digest ~ '^[0-9a-f]{64}$'),
  constraint kplus_rc_product_cache_store_identifier_check
    check (store_identifier ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$'),
  constraint kplus_rc_product_cache_type_check
    check (product_type in ('subscription', 'non_consumable', 'one_time', 'consumable', 'non_renewing_subscription')),
  constraint kplus_rc_product_cache_expiry_check
    check (expires_at > cached_at)
);

alter table public.kplus_revenuecat_product_cache enable row level security;
revoke all on public.kplus_revenuecat_product_cache from public, anon, authenticated, service_role;
grant select on public.kplus_revenuecat_product_cache to service_role;

create or replace function public.get_kplus_revenuecat_product_cache(
  p_project_ref_digest text,
  p_product_ref_digest text
)
returns table (store_identifier text, product_type text, cached_at timestamptz, expires_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select c.store_identifier, c.product_type, c.cached_at, c.expires_at
    from public.kplus_revenuecat_product_cache c
   where c.project_ref_digest = p_project_ref_digest
     and c.product_ref_digest = p_product_ref_digest
     and c.expires_at > now();
$$;

create or replace function public.put_kplus_revenuecat_product_cache(
  p_project_ref_digest text,
  p_product_ref_digest text,
  p_store_identifier text,
  p_product_type text,
  p_ttl_seconds integer
)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  if p_project_ref_digest !~ '^[0-9a-f]{64}$'
     or p_product_ref_digest !~ '^[0-9a-f]{64}$'
     or p_store_identifier !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$'
     or p_product_type not in ('subscription', 'non_consumable', 'one_time', 'consumable', 'non_renewing_subscription')
     or p_ttl_seconds not between 60 and 2592000 then
    raise exception 'invalid RevenueCat product cache value' using errcode = '22023';
  end if;
  insert into public.kplus_revenuecat_product_cache (
    project_ref_digest, product_ref_digest, store_identifier, product_type,
    cached_at, expires_at
  ) values (
    p_project_ref_digest, p_product_ref_digest, p_store_identifier, p_product_type,
    now(), now() + make_interval(secs => p_ttl_seconds)
  )
  on conflict (project_ref_digest, product_ref_digest) do update
    set store_identifier = excluded.store_identifier,
        product_type = excluded.product_type,
        cached_at = excluded.cached_at,
        expires_at = excluded.expires_at;
end;
$$;

-- --------------------------------------------------------------------------
-- 4. Bounded local provider view and shared transition wrappers.
-- --------------------------------------------------------------------------

create or replace function public.list_kplus_provider_grants_for_reconciliation(
  p_user_id uuid,
  p_environment text
)
returns table (
  grant_id uuid,
  source text,
  grant_key text,
  store text,
  product_id text,
  current_period_type text,
  current_period_starts_at timestamptz,
  expires_at timestamptz,
  will_renew boolean,
  billing_state text,
  grace_period_expires_at timestamptz,
  revoked_at timestamptz,
  revocation_reason text,
  provider_state_occurred_at timestamptz,
  provider_state_rank smallint,
  provider_state_event_id text,
  last_provider_verified_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select g.id, g.source, g.grant_key, g.store, g.product_id,
         g.current_period_type, g.current_period_starts_at, g.expires_at,
         g.will_renew, g.billing_state, g.grace_period_expires_at,
         g.revoked_at, g.revocation_reason, g.provider_state_occurred_at,
         g.provider_state_rank, g.provider_state_event_id,
         g.last_provider_verified_at
    from public.kplus_entitlement_grants g
   where g.user_id = p_user_id
     and g.provider = 'revenuecat'
     and g.provider_environment = p_environment
     and g.source in ('store_subscription', 'store_lifetime')
   order by g.source, g.created_at, g.id
   limit 50;
$$;

-- Resolve a changed provider reference only when exactly one same-family,
-- same-product grant belongs to this actor. This lets a current-state pull and
-- a later webhook converge even when RevenueCat exposes a current transaction
-- identifier in one surface and the original transaction identifier in the
-- other. Multiple candidates fail closed.
create or replace function public.reconcile_kplus_provider_transition(
  p_user_id uuid,
  p_provider text,
  p_cause text,
  p_external_event_id text,
  p_provider_event_type text,
  p_provider_occurred_at timestamptz,
  p_environment text,
  p_store text,
  p_product_id text,
  p_subscription_ref_digest text,
  p_lifecycle_state text,
  p_period_type text,
  p_period_starts_at timestamptz,
  p_expires_at timestamptz,
  p_will_renew boolean,
  p_trial_ends_at timestamptz default null,
  p_grace_period_expires_at timestamptz default null,
  p_pause_resumes_at timestamptz default null,
  p_entitlement_key text default 'k_plus'
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_digest text := p_subscription_ref_digest;
  v_existing public.kplus_entitlement_grants;
  v_candidate_id uuid;
  v_candidate_count integer := 0;
  v_result jsonb;
  v_drift boolean := true;
begin
  perform pg_advisory_xact_lock(hashtextextended('kplus_entitlement:' || p_user_id::text, 0));

  select * into v_existing from public.kplus_entitlement_grants g
   where g.source = 'store_subscription' and g.provider = p_provider
     and g.store = p_store and g.grant_key = p_subscription_ref_digest
   for update;

  if not found then
    select count(*), min(g.id) into v_candidate_count, v_candidate_id
      from public.kplus_entitlement_grants g
     where g.user_id = p_user_id and g.source = 'store_subscription'
       and g.provider = p_provider and g.store = p_store
       and g.provider_environment = p_environment and g.product_id = p_product_id;
    if v_candidate_count > 1 then
      return jsonb_build_object('classification', 'rejected', 'reason', 'ambiguous_provider_grant_identity');
    elsif v_candidate_count = 1 then
      select * into v_existing from public.kplus_entitlement_grants where id = v_candidate_id for update;
      v_digest := v_existing.grant_key;
    end if;
  end if;

  if v_existing.id is not null and v_existing.user_id = p_user_id then
    v_drift := not (
      v_existing.product_id is not distinct from p_product_id
      and v_existing.current_period_type is not distinct from p_period_type
      and v_existing.current_period_starts_at is not distinct from p_period_starts_at
      and v_existing.expires_at is not distinct from p_expires_at
      and v_existing.will_renew is not distinct from p_will_renew
      and v_existing.billing_state is not distinct from case p_lifecycle_state
        when 'grace_period' then 'grace_period'
        when 'billing_retry' then 'billing_retry'
        when 'account_hold' then 'account_hold'
        when 'paused' then 'paused'
        else 'normal' end
      and (v_existing.revoked_at is not null) = (p_lifecycle_state in ('refunded', 'revoked'))
    );
  end if;

  v_result := public.apply_kplus_provider_transition(
    p_user_id, p_provider, p_cause, p_external_event_id,
    p_provider_event_type, p_provider_occurred_at, p_environment, p_store,
    p_product_id, v_digest, p_lifecycle_state, p_period_type,
    p_period_starts_at, p_expires_at, p_will_renew, p_trial_ends_at,
    p_grace_period_expires_at, p_pause_resumes_at, p_entitlement_key
  );
  return v_result || jsonb_build_object(
    'driftDetected', v_drift,
    'identityReused', v_digest <> p_subscription_ref_digest
  );
end;
$$;

create or replace function public.reconcile_kplus_provider_lifetime_transition(
  p_user_id uuid,
  p_provider text,
  p_cause text,
  p_external_event_id text,
  p_provider_event_type text,
  p_provider_occurred_at timestamptz,
  p_environment text,
  p_store text,
  p_product_id text,
  p_purchase_ref_digest text,
  p_lifecycle_state text,
  p_purchased_at timestamptz,
  p_entitlement_key text default 'k_plus'
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_digest text := p_purchase_ref_digest;
  v_existing public.kplus_entitlement_grants;
  v_candidate_id uuid;
  v_candidate_count integer := 0;
  v_result jsonb;
  v_drift boolean := true;
begin
  perform pg_advisory_xact_lock(hashtextextended('kplus_entitlement:' || p_user_id::text, 0));

  select * into v_existing from public.kplus_entitlement_grants g
   where g.source = 'store_lifetime' and g.provider = p_provider
     and g.store = p_store and g.grant_key = p_purchase_ref_digest
   for update;

  if not found then
    select count(*), min(g.id) into v_candidate_count, v_candidate_id
      from public.kplus_entitlement_grants g
     where g.user_id = p_user_id and g.source = 'store_lifetime'
       and g.provider = p_provider and g.store = p_store
       and g.provider_environment = p_environment and g.product_id = p_product_id;
    if v_candidate_count > 1 then
      return jsonb_build_object('classification', 'rejected', 'reason', 'ambiguous_provider_grant_identity');
    elsif v_candidate_count = 1 then
      select * into v_existing from public.kplus_entitlement_grants where id = v_candidate_id for update;
      v_digest := v_existing.grant_key;
    end if;
  end if;

  if v_existing.id is not null and v_existing.user_id = p_user_id then
    v_drift := not (
      v_existing.product_id is not distinct from p_product_id
      and v_existing.starts_at is not distinct from p_purchased_at
      and (v_existing.revoked_at is not null) = (p_lifecycle_state in ('refunded', 'revoked'))
    );
  end if;

  v_result := public.apply_kplus_provider_lifetime_transition(
    p_user_id, p_provider, p_cause, p_external_event_id,
    p_provider_event_type, p_provider_occurred_at, p_environment, p_store,
    p_product_id, v_digest, p_lifecycle_state, p_purchased_at,
    p_entitlement_key
  );
  return v_result || jsonb_build_object(
    'driftDetected', v_drift,
    'identityReused', v_digest <> p_purchase_ref_digest
  );
end;
$$;

-- --------------------------------------------------------------------------
-- 5. Privileges and post-condition guard.
-- --------------------------------------------------------------------------

revoke all on function public.kplus_stamp_provider_reconciliation_observation() from public, anon, authenticated;
revoke all on function public.kplus_refresh_provider_verification_from_observation() from public, anon, authenticated;
revoke all on function public.claim_kplus_provider_reconciliation(uuid, text, integer, integer, boolean) from public, anon, authenticated;
revoke all on function public.finish_kplus_provider_reconciliation(uuid, text, uuid, text) from public, anon, authenticated;
revoke all on function public.get_kplus_revenuecat_product_cache(text, text) from public, anon, authenticated;
revoke all on function public.put_kplus_revenuecat_product_cache(text, text, text, text, integer) from public, anon, authenticated;
revoke all on function public.list_kplus_provider_grants_for_reconciliation(uuid, text) from public, anon, authenticated;
revoke all on function public.reconcile_kplus_provider_transition(uuid, text, text, text, text, timestamptz, text, text, text, text, text, text, timestamptz, timestamptz, boolean, timestamptz, timestamptz, timestamptz, text) from public, anon, authenticated;
revoke all on function public.reconcile_kplus_provider_lifetime_transition(uuid, text, text, text, text, timestamptz, text, text, text, text, text, timestamptz, text) from public, anon, authenticated;

grant execute on function public.claim_kplus_provider_reconciliation(uuid, text, integer, integer, boolean) to service_role;
grant execute on function public.finish_kplus_provider_reconciliation(uuid, text, uuid, text) to service_role;
grant execute on function public.get_kplus_revenuecat_product_cache(text, text) to service_role;
grant execute on function public.put_kplus_revenuecat_product_cache(text, text, text, text, integer) to service_role;
grant execute on function public.list_kplus_provider_grants_for_reconciliation(uuid, text) to service_role;
grant execute on function public.reconcile_kplus_provider_transition(uuid, text, text, text, text, timestamptz, text, text, text, text, text, text, timestamptz, timestamptz, boolean, timestamptz, timestamptz, timestamptz, text) to service_role;
grant execute on function public.reconcile_kplus_provider_lifetime_transition(uuid, text, text, text, text, timestamptz, text, text, text, text, text, timestamptz, text) to service_role;

do $$
declare
  v_violation text;
begin
  select string_agg(format('%s/%s/%s', c.relname, r.role_name, p.priv), ', ')
    into v_violation
    from pg_class c
    cross join (values ('anon'), ('authenticated')) as r(role_name)
    cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) as p(priv)
   where c.oid in (
     'public.kplus_provider_reconciliation_controls'::regclass,
     'public.kplus_revenuecat_product_cache'::regclass
   ) and has_table_privilege(r.role_name, c.oid, p.priv);
  if v_violation is not null then
    raise exception 'Phase E private tables must not be client-accessible: %', v_violation;
  end if;
end;
$$;
