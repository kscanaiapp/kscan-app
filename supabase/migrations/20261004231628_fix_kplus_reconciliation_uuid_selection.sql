-- Build 35 production readiness: PostgreSQL has no min(uuid) aggregate.
-- Preserve both transition contracts, actor locks, authorization and lifecycle
-- rules; only select a deterministic UUID candidate using array_agg.
-- Existing migrations remain immutable.

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
    select count(*), (array_agg(g.id order by g.id))[1] into v_candidate_count, v_candidate_id
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
    select count(*), (array_agg(g.id order by g.id))[1] into v_candidate_count, v_candidate_id
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
