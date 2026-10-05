-- K Scan AI -- Build 35 paid K+ foundation, Phase A: lifetime (non-consumable)
-- store purchase as a first-class K+ grant source.
--
-- ADDS (forward-only; no existing row, table, column, index or policy is
-- dropped or rewritten, and no complimentary row is touched):
--
--   source 'store_lifetime'     A durable, one-time, non-consumable Apple /
--                               Google purchase mediated by RevenueCat. It is
--                               NOT a subscription: it has no renewal, trial,
--                               billing retry, grace period or period end. It
--                               is open-ended until authoritative provider
--                               state reports a refund or revocation.
--   display source 'lifetime'   The strongest durable commercial source, so a
--                               customer who owns lifetime is never described
--                               as a renewing subscriber.
--   activation class 'lifetime' Welcome-to-K+ delivery class for a lifetime
--                               activation.
--   provider event 'lifetime_purchase'
--   apply_kplus_provider_lifetime_transition(...)
--                               The lifetime counterpart of
--                               apply_kplus_provider_transition. A separate
--                               function on purpose: the subscription
--                               transition is byte-identical to Build 34 and
--                               cannot be weakened by lifetime handling.
--                               service_role only.
--   summary key 'complimentaryHistory'
--                               Whether the account has ever held a
--                               complimentary-family or legacy K+ grant. It is
--                               the one fact the mobile reader needs to keep
--                               telling "never activated" from "campaign
--                               consumed" now that it reads the summary instead
--                               of the legacy table.
--
-- REPLACES (create or replace; signature, return type, volatility, security
-- mode and privileges are preserved):
--
--   kplus_entitlement_facts     Legacy and complimentary branches are verbatim;
--                               adds the lifetime fact and its display source.
--   kplus_entitlement_summary   Adds complimentaryHistory; otherwise verbatim.
--   revoke_kplus_grant          Also refuses store_lifetime: a store grant is
--                               only ever revoked by a provider transition.
--   trigger kplus_entitlement_grants_revenuecat_mirror_retire
--                               Its WHEN guard excluded only store_subscription,
--                               so a revoked lifetime row would have entered the
--                               RevenueCat PROMOTIONAL-mirror retirement queue.
--                               A store purchase is never a promotional mirror.
--
-- COEXISTENCE. Effective K+ is the union of every currently valid grant
-- (unchanged resolver contract). A lifetime purchase never deletes, shortens or
-- overwrites a complimentary grant or a subscription; each keeps its own
-- provenance. Presentation picks the strongest commercial source, which never
-- destroys the others.
--
-- NOT HERE: price, currency, trial length, product catalogue, receipts,
-- purchase tokens, provider payloads, RevenueCat SDK, paywall, promo redemption.
-- A store purchase is identified only by an opaque SHA-256 digest.
--
-- ROLLBACK / FIX-FORWARD: every addition is new. Restoring Build 34 behaviour
-- is a forward migration that re-creates the four replaced objects from
-- 20260915030553 / 20260915181554 and narrows the CHECK lists. No step deletes
-- or rewrites user_entitlements data or any existing grant.

-- ============================================================================
-- 1. Vocabulary: widen the closed CHECK lists (additive)
-- ============================================================================

alter table public.kplus_entitlement_grants
  drop constraint if exists kplus_entitlement_grants_source_check,
  add constraint kplus_entitlement_grants_source_check
    check (source in (
      'store_subscription', 'store_lifetime', 'complimentary', 'complimentary_code',
      'employee', 'friends_family', 'manual_support', 'promotional'
    ));

-- Store facts exist exactly on store grants. A subscription is bounded and
-- renewal-shaped; a lifetime grant is open-ended and carries NONE of the
-- subscription-only facts, so it can never pretend to have a renewal date, a
-- trial, a billing retry, a grace period or a period end. Both store sources
-- are keyed by an opaque SHA-256 digest, so no raw transaction id or purchase
-- token can enter this table.
alter table public.kplus_entitlement_grants
  drop constraint if exists kplus_entitlement_grants_store_shape_check,
  add constraint kplus_entitlement_grants_store_shape_check
    check (
      (source = 'store_subscription'
        and provider is not null and store is not null and provider_environment is not null
        and product_id is not null and current_period_type is not null
        and current_period_starts_at is not null and will_renew is not null
        and not is_open_ended
        and provider_state_occurred_at is not null and provider_state_rank is not null
        and provider_state_event_id is not null
        and grant_key ~ '^[0-9a-f]{64}$')
      or
      (source = 'store_lifetime'
        and provider is not null and store is not null and provider_environment is not null
        and product_id is not null
        and is_open_ended and expires_at is null
        and current_period_type is null and current_period_starts_at is null
        and trial_ends_at is null and will_renew is null
        and billing_state = 'normal' and grace_period_expires_at is null
        and pause_resumes_at is null
        and provider_state_occurred_at is not null and provider_state_rank is not null
        and provider_state_event_id is not null
        and grant_key ~ '^[0-9a-f]{64}$')
      or
      (source not in ('store_subscription', 'store_lifetime')
        and provider is null and store is null and provider_environment is null
        and product_id is null and current_period_type is null
        and current_period_starts_at is null and trial_ends_at is null and will_renew is null
        and billing_state = 'normal' and grace_period_expires_at is null
        and pause_resumes_at is null
        and provider_state_occurred_at is null and provider_state_rank is null
        and provider_state_event_id is null and last_provider_verified_at is null)
    );

-- Refund/revocation stays its own fact. K Scan AI never issues a store refund;
-- a store grant (subscription or lifetime) is only revoked by a provider
-- transition, a complimentary-family grant only by an operator.
alter table public.kplus_entitlement_grants
  drop constraint if exists kplus_entitlement_grants_revocation_check,
  add constraint kplus_entitlement_grants_revocation_check
    check (
      (revoked_at is null and revocation_reason is null)
      or (revoked_at is not null and (
        (source in ('store_subscription', 'store_lifetime')
          and revocation_reason in ('refunded', 'provider_revoked'))
        or (source not in ('store_subscription', 'store_lifetime')
          and revocation_reason = 'operator_revoked')
      ))
    );

-- One lifetime purchase belongs to at most ONE K Scan AI user. A second user
-- presenting the same purchase reference is refused, never merged: the
-- database half of "no accidental cross-account inheritance".
create unique index if not exists kplus_entitlement_grants_store_lifetime_key
  on public.kplus_entitlement_grants (provider, store, grant_key)
  where source = 'store_lifetime';

alter table public.kplus_entitlement_transitions
  drop constraint if exists kplus_entitlement_transitions_event_type_check,
  add constraint kplus_entitlement_transitions_event_type_check
    check (provider_event_type is null or provider_event_type in (
      'initial_purchase', 'renewal', 'product_change', 'cancellation', 'uncancellation',
      'billing_issue', 'subscription_paused', 'subscription_extended', 'expiration',
      'refund', 'refund_reversed', 'transfer', 'reconciliation_snapshot',
      'lifetime_purchase'
    ));

alter table public.kplus_entitlement_activations
  drop constraint if exists kplus_entitlement_activations_class_check,
  add constraint kplus_entitlement_activations_class_check
    check (activation_class in ('subscription_or_trial', 'complimentary', 'lifetime'));

comment on column public.kplus_entitlement_grants.grant_key is
  'Idempotency identity within (user_id, entitlement_key, source). Store grants (subscription and lifetime): lowercase hex SHA-256 digest of the provider purchase reference. Complimentary grants: the trusted caller''s idempotency key.';

-- ============================================================================
-- 2. The resolver: one more grant source, the same union
-- ============================================================================

-- Identical to the Build 34 Phase 1 resolver for legacy rows and for every
-- existing source. The only differences are the lifetime display source/rank
-- and that a lifetime grant is never a store-management relationship (there is
-- no renewal for the customer to cancel).
--
-- Display-source precedence among CONTRIBUTING grants (deterministic):
--   0 lifetime      (store, one-time, open-ended)      <- new
--   1 subscription  (store, paid period)
--   2 trial         (store, trial period)
--   3 complimentary (complimentary, complimentary_code, employee,
--                    friends_family, manual_support, promotional)
--   4 unknown       (legacy rows with unverified provenance)
create or replace function public.kplus_entitlement_facts(
  p_user_id         uuid,
  p_entitlement_key text,
  p_at              timestamptz
)
returns table (
  fact_kind                  text,
  fact_id                    uuid,
  source                     text,
  display_source             text,
  display_rank               smallint,
  contributes_access         boolean,
  starts_at                  timestamptz,
  access_until               timestamptz,
  is_open_ended              boolean,
  store                      text,
  billing_state              text,
  will_renew                 boolean,
  trial_ends_at              timestamptz,
  current_period_type        text,
  store_management_relevant  boolean,
  provider_state_occurred_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  -- Legacy Build 34 rows (user_entitlements). Access is the EXACT canonical
  -- Build 34 predicate, unchanged. grant_reason maps to a source without
  -- inventing provenance: the three reasons that never had a store behind
  -- them in Build 34 (trial, paid_ios, paid_android) are 'legacy_unverified'
  -- and display as 'unknown'.
  select
    'legacy_grant'::text,
    ue.id,
    case ue.grant_reason
      when 'complimentary_early_access' then 'complimentary'
      when 'staff' then 'employee'
      when 'admin' then 'manual_support'
      when 'promo' then 'promotional'
      else 'legacy_unverified'
    end,
    case when ue.grant_reason in ('complimentary_early_access', 'staff', 'admin', 'promo')
      then 'complimentary' else 'unknown' end,
    (case when ue.grant_reason in ('complimentary_early_access', 'staff', 'admin', 'promo')
      then 3 else 4 end)::smallint,
    (ue.status = 'active'
      and ue.revoked_at is null
      and ue.expires_at is not null
      and ue.expires_at > p_at),
    ue.granted_at,
    ue.expires_at,
    false,
    null::text,
    null::text,
    null::boolean,
    null::timestamptz,
    null::text,
    false,
    null::timestamptz
  from public.user_entitlements ue
  where ue.user_id = p_user_id
    and ue.entitlement_key = p_entitlement_key

  union all

  -- Grants. Access comes from authoritative facts, never from a label:
  --   revoked / refunded            -> no access
  --   normal                        -> open-ended, or until expires_at
  --   grace_period                  -> until the later of expires_at and the
  --                                    grace expiry
  --   billing_retry                 -> until expires_at (a billing issue alone
  --                                    revokes nothing)
  --   account_hold / paused         -> suspended, whatever expires_at says
  -- A lifetime grant is always 'normal' and open-ended (enforced by its shape
  -- constraint), so it contributes access exactly while it is not revoked.
  select
    'grant'::text,
    g.id,
    g.source,
    case
      when g.source = 'store_lifetime' then 'lifetime'
      when g.source <> 'store_subscription' then 'complimentary'
      when g.current_period_type = 'trial' then 'trial'
      else 'subscription'
    end,
    (case
      when g.source = 'store_lifetime' then 0
      when g.source <> 'store_subscription' then 3
      when g.current_period_type = 'trial' then 2
      else 1
    end)::smallint,
    (g.revoked_at is null
      and g.starts_at <= p_at
      and case g.billing_state
            when 'normal' then (g.is_open_ended or g.expires_at > p_at)
            when 'grace_period' then greatest(g.expires_at, g.grace_period_expires_at) > p_at
            when 'billing_retry' then g.expires_at > p_at
            else false
          end),
    g.starts_at,
    case when g.billing_state = 'grace_period'
      then greatest(g.expires_at, g.grace_period_expires_at)
      else g.expires_at end,
    g.is_open_ended,
    g.store,
    case when g.source = 'store_subscription' then g.billing_state end,
    g.will_renew,
    g.trial_ends_at,
    g.current_period_type,
    (g.source = 'store_subscription'
      and g.revoked_at is null
      and (coalesce(g.will_renew, false)
        or g.billing_state <> 'normal'
        or g.expires_at > p_at)),
    g.provider_state_occurred_at
  from public.kplus_entitlement_grants g
  where g.user_id = p_user_id
    and g.entitlement_key = p_entitlement_key;
$$;

-- The read contract (service_role form). Same as Phase 1 plus one additive key,
-- complimentaryHistory: whether this account has ever held a complimentary-
-- family or legacy K+ grant, active or not. It carries no provenance detail,
-- id, date or campaign. It lets the mobile reader keep distinguishing a
-- never-activated account from one whose complimentary access has ended, which
-- the legacy row read used to answer by existence.
create or replace function public.kplus_entitlement_summary(
  p_user_id uuid,
  p_entitlement_key text default 'k_plus'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_now             timestamptz := now();
  v_has_access      boolean;
  v_open_ended      boolean;
  v_expires_at      timestamptz;
  v_display_source  text;
  v_display_trial   timestamptz;
  v_store_found     boolean := false;
  v_store           text;
  v_billing_state   text;
  v_will_renew      boolean;
  v_history         boolean;
begin
  if p_user_id is null then
    raise exception 'p_user_id is required' using errcode = '22004';
  end if;
  if p_entitlement_key is distinct from 'k_plus' then
    raise exception 'unsupported entitlement key' using errcode = '22023';
  end if;

  select s.has_access, s.is_open_ended, s.effective_expires_at
    into v_has_access, v_open_ended, v_expires_at
    from public.kplus_effective_access_state(p_user_id, p_entitlement_key, v_now) s;

  if v_has_access then
    select f.display_source,
           case when f.display_source = 'trial' then f.trial_ends_at end
      into v_display_source, v_display_trial
      from public.kplus_entitlement_facts(p_user_id, p_entitlement_key, v_now) f
     where f.contributes_access
     order by f.display_rank asc,
              f.is_open_ended desc,
              f.access_until desc nulls last,
              f.starts_at asc,
              f.fact_id asc
     limit 1;
  end if;

  select true, f.store, f.billing_state, f.will_renew
    into v_store_found, v_store, v_billing_state, v_will_renew
    from public.kplus_entitlement_facts(p_user_id, p_entitlement_key, v_now) f
   where f.store_management_relevant
   order by f.contributes_access desc,
            f.provider_state_occurred_at desc nulls last,
            f.fact_id asc
   limit 1;

  select exists (
    select 1
      from public.kplus_entitlement_facts(p_user_id, p_entitlement_key, v_now) f
     where f.source not in ('store_subscription', 'store_lifetime')
  ) into v_history;

  return jsonb_build_object(
    'contractVersion', 1,
    'entitlementKey', p_entitlement_key,
    'access', case when v_has_access then 'k_plus' else 'free' end,
    'displaySource', case when v_has_access then v_display_source end,
    'effectiveExpiresAt', case when v_has_access and not v_open_ended
      then to_char(v_expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
    'isOpenEnded', v_has_access and v_open_ended,
    'trialEndsAt', to_char(v_display_trial at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'willRenew', v_will_renew,
    'store', v_store,
    'billingState', v_billing_state,
    'complimentaryHistory', coalesce(v_history, false),
    'accountManagement', jsonb_build_object(
      'storeManagementRelevant', coalesce(v_store_found, false),
      'managementStore', v_store
    ),
    'snapshotIssuedAt', to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
end;
$$;

-- ============================================================================
-- 3. Operator revocation: a lifetime grant is a store grant
-- ============================================================================

create or replace function public.revoke_kplus_grant(
  p_user_id  uuid,
  p_grant_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_now            timestamptz := now();
  v_grant          public.kplus_entitlement_grants;
  v_access_before  boolean;
  v_expires_before timestamptz;
  v_access_after   boolean;
  v_expires_after  timestamptz;
  v_transition_id  uuid;
begin
  if p_user_id is null or p_grant_id is null then
    raise exception 'p_user_id and p_grant_id are required' using errcode = '22004';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('kplus_entitlement:' || p_user_id::text, 0));

  -- Scoped by BOTH ids: a grant id alone never reaches another user's grant.
  select * into v_grant
    from public.kplus_entitlement_grants g
   where g.id = p_grant_id and g.user_id = p_user_id
   for update;
  if not found then
    return jsonb_build_object('outcome', 'rejected', 'reason', 'grant_not_found');
  end if;
  if v_grant.source in ('store_subscription', 'store_lifetime') then
    return jsonb_build_object('outcome', 'rejected', 'reason', 'store_grant_requires_provider_transition');
  end if;
  if v_grant.revoked_at is not null then
    return jsonb_build_object('outcome', 'already_revoked', 'grantId', v_grant.id);
  end if;

  select s.has_access, s.effective_expires_at into v_access_before, v_expires_before
    from public.kplus_effective_access_state(p_user_id, v_grant.entitlement_key, v_now) s;

  update public.kplus_entitlement_grants
     set revoked_at = v_now,
         revocation_reason = 'operator_revoked',
         updated_at = v_now
   where id = v_grant.id;

  select s.has_access, s.effective_expires_at into v_access_after, v_expires_after
    from public.kplus_effective_access_state(p_user_id, v_grant.entitlement_key, v_now) s;

  insert into public.kplus_entitlement_transitions (
    user_id, entitlement_key, grant_id, cause, outcome,
    access_before, access_after, effective_expires_at_before, effective_expires_at_after
  )
  values (
    p_user_id, v_grant.entitlement_key, v_grant.id, 'grant_revocation', 'applied',
    v_access_before, v_access_after, v_expires_before, v_expires_after
  )
  returning id into v_transition_id;

  return jsonb_build_object(
    'outcome', 'revoked',
    'grantId', v_grant.id,
    'transitionId', v_transition_id,
    'accessBefore', v_access_before,
    'accessAfter', v_access_after
  );
end;
$$;

-- ============================================================================
-- 4. Mirror-retirement trigger: a store purchase is not a promotional mirror
-- ============================================================================

-- Verbatim 20260915181554 trigger, with the first WHEN clause widened from
-- "not a store subscription" to "not a store grant". Without this a refunded
-- or revoked lifetime row would be queued as a RevenueCat PROMOTIONAL mirror
-- retirement. The worker resolves kplus_promotional_mirror_state (which already
-- excludes every store source) at execution time, so the practical effect would
-- have been wasted work, but a store purchase must never enter that queue.
drop trigger if exists kplus_entitlement_grants_revenuecat_mirror_retire
  on public.kplus_entitlement_grants;
create trigger kplus_entitlement_grants_revenuecat_mirror_retire
  after update on public.kplus_entitlement_grants
  for each row
  when (
    old.source not in ('store_subscription', 'store_lifetime')
    and (
         -- revoke_kplus_grant, and any operator write shaped like it
         (old.revoked_at is null and new.revoked_at is not null)
         -- open-ended closed off
      or (old.is_open_ended and not new.is_open_ended)
         -- expiry shortened (the table's own check keeps expires_at NULL
         -- exactly when is_open_ended, so this is the bounded -> bounded case)
      or (old.expires_at is not null and new.expires_at is not null
          and new.expires_at < old.expires_at)
         -- window start pushed out
      or (new.starts_at > old.starts_at)
         -- the row moved out from under OLD's pair, or became a store grant
      or (new.user_id is distinct from old.user_id)
      or (new.entitlement_key is distinct from old.entitlement_key)
      or (new.source is distinct from old.source)
    )
  )
  execute function public.kplus_grants_mirror_retire_tg();

-- ============================================================================
-- 5. Verified provider state -> lifetime ownership
-- ============================================================================

-- Called only by trusted server code (a future RevenueCat webhook or
-- reconciliation pull) that has already authenticated the provider and resolved
-- p_user_id from the provider's App User ID (which must equal the Supabase auth
-- UUID). A client can never reach it, and nothing a client sends is an input.
--
-- Classification mirrors apply_kplus_provider_transition:
--   applied    newer than the grant's applied provider state
--   duplicate  this (provider, external_event_id) was already recorded; only the
--              delivery counter moves
--   stale      older than the applied provider state; recorded for audit, never
--              applied (it may only merge the earliest-purchase provenance fact)
--   rejected   refused and NOT recorded, so a legitimate retry is still possible
--              (unknown user, anonymous identity, purchase owned by another
--              user, environment mismatch, provider time in the future, event id
--              reused for another user or for a non-lifetime grant)
--
-- Lifecycle for lifetime ownership is only: active (owned), refunded, revoked.
-- Event type and lifecycle must agree, so a payload cannot claim contradictory
-- facts. Ordering is by provider facts only -- (provider_occurred_at, lifecycle
-- rank, external_event_id) -- never by server receipt time; the rank breaks an
-- exact-timestamp tie toward the more restrictive state, so a refund always
-- beats a simultaneous purchase report.
create or replace function public.apply_kplus_provider_lifetime_transition(
  p_user_id              uuid,
  p_provider             text,
  p_cause                text,
  p_external_event_id    text,
  p_provider_event_type  text,
  p_provider_occurred_at timestamptz,
  p_environment          text,
  p_store                text,
  p_product_id           text,
  p_purchase_ref_digest  text,
  p_lifecycle_state      text,
  p_purchased_at         timestamptz,
  p_entitlement_key      text default 'k_plus'
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  c_max_future_skew constant interval := interval '15 minutes';
  v_now               timestamptz := now();
  v_rank              smallint;
  v_revoked_at        timestamptz;
  v_revocation        text;
  v_is_anonymous      boolean;
  v_event             public.kplus_entitlement_transitions;
  v_event_grant_src   text;
  v_grant             public.kplus_entitlement_grants;
  v_is_new            boolean := false;
  v_access_before     boolean;
  v_expires_before    timestamptz;
  v_access_after      boolean;
  v_open_after        boolean;
  v_expires_after     timestamptz;
  v_activation_id     uuid;
  v_transition_id     uuid;
begin
  -- 1. Structural validation. A malformed call is a caller bug: fail loudly,
  --    persist nothing.
  if p_user_id is null or p_provider is null or p_cause is null or p_external_event_id is null
     or p_provider_event_type is null or p_provider_occurred_at is null or p_environment is null
     or p_store is null or p_product_id is null or p_purchase_ref_digest is null
     or p_lifecycle_state is null or p_purchased_at is null then
    raise exception 'required provider lifetime transition field is missing' using errcode = '22004';
  end if;
  if p_entitlement_key is distinct from 'k_plus' then
    raise exception 'unsupported entitlement key' using errcode = '22023';
  end if;
  if p_provider <> 'revenuecat' then
    raise exception 'unsupported provider' using errcode = '22023';
  end if;
  if p_cause not in ('provider_event', 'provider_reconciliation') then
    raise exception 'unsupported cause' using errcode = '22023';
  end if;
  if p_external_event_id !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$' then
    raise exception 'invalid external event id' using errcode = '22023';
  end if;
  if p_provider_event_type not in (
       'lifetime_purchase', 'refund', 'refund_reversed', 'transfer', 'reconciliation_snapshot') then
    raise exception 'unsupported lifetime provider event type' using errcode = '22023';
  end if;
  if (p_cause = 'provider_reconciliation') <> (p_provider_event_type = 'reconciliation_snapshot') then
    raise exception 'reconciliation snapshots and provider events are distinct causes' using errcode = '22023';
  end if;
  if p_environment not in ('production', 'sandbox') then
    raise exception 'unsupported environment' using errcode = '22023';
  end if;
  if p_store not in ('apple', 'google') then
    raise exception 'unsupported store' using errcode = '22023';
  end if;
  if p_product_id !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$' then
    raise exception 'invalid product id' using errcode = '22023';
  end if;
  if p_purchase_ref_digest !~ '^[0-9a-f]{64}$' then
    raise exception 'purchase reference must be a lowercase hex SHA-256 digest' using errcode = '22023';
  end if;
  if p_lifecycle_state not in ('active', 'refunded', 'revoked') then
    raise exception 'unsupported lifetime lifecycle state' using errcode = '22023';
  end if;
  -- A payload cannot claim contradictory facts: a purchase or a reversed refund
  -- reports ownership, a refund reports refunded, a transfer reports ownership
  -- lost; only a reconciliation snapshot may report any of the three.
  if (p_provider_event_type in ('lifetime_purchase', 'refund_reversed') and p_lifecycle_state <> 'active')
     or (p_provider_event_type = 'refund' and p_lifecycle_state <> 'refunded')
     or (p_provider_event_type = 'transfer' and p_lifecycle_state <> 'revoked') then
    raise exception 'lifetime event type and lifecycle state disagree' using errcode = '22023';
  end if;
  if p_purchased_at > p_provider_occurred_at + c_max_future_skew then
    raise exception 'a purchase cannot follow the provider event that reports it' using errcode = '22023';
  end if;

  -- 2. Provider clock sanity. Beyond the skew allowance a provider timestamp
  --    would poison the ordering watermark, so refuse without recording.
  if p_provider_occurred_at > v_now + c_max_future_skew then
    return jsonb_build_object('classification', 'rejected', 'reason', 'provider_time_in_future');
  end if;

  v_rank := case p_lifecycle_state
    when 'active' then 10
    when 'refunded' then 60
    when 'revoked' then 60
  end;
  v_revoked_at := case when p_lifecycle_state in ('refunded', 'revoked') then p_provider_occurred_at end;
  v_revocation := case p_lifecycle_state when 'refunded' then 'refunded' when 'revoked' then 'provider_revoked' end;

  -- 3. Serialize every K+ mutation for this user.
  perform pg_advisory_xact_lock(hashtextextended('kplus_entitlement:' || p_user_id::text, 0));

  -- 4. Idempotency. The key is shared with subscription events, so an event id
  --    can never be applied twice, nor once as each kind.
  select * into v_event
    from public.kplus_entitlement_transitions t
   where t.provider = p_provider and t.external_event_id = p_external_event_id
   for update;
  if found then
    if v_event.user_id <> p_user_id then
      return jsonb_build_object('classification', 'rejected', 'reason', 'event_identity_conflict');
    end if;
    if v_event.grant_id is not null then
      select g.source into v_event_grant_src
        from public.kplus_entitlement_grants g where g.id = v_event.grant_id;
      if v_event_grant_src is distinct from 'store_lifetime' then
        return jsonb_build_object('classification', 'rejected', 'reason', 'event_identity_conflict');
      end if;
    end if;
    update public.kplus_entitlement_transitions
       set duplicate_deliveries = duplicate_deliveries + 1,
           last_duplicate_at = v_now
     where id = v_event.id;
    return jsonb_build_object(
      'classification', 'duplicate',
      'originalOutcome', v_event.outcome,
      'transitionId', v_event.id,
      'grantId', v_event.grant_id
    );
  end if;

  -- 5. Identity. Anonymous state never becomes K Scan AI authority.
  select u.is_anonymous into v_is_anonymous from auth.users u where u.id = p_user_id;
  if not found then
    return jsonb_build_object('classification', 'rejected', 'reason', 'unknown_user');
  end if;
  if coalesce(v_is_anonymous, false) then
    return jsonb_build_object('classification', 'rejected', 'reason', 'anonymous_identity');
  end if;

  -- 6. Purchase ownership. One lifetime purchase belongs to one K Scan AI user
  --    and one provider environment, for good.
  select * into v_grant
    from public.kplus_entitlement_grants g
   where g.source = 'store_lifetime'
     and g.provider = p_provider
     and g.store = p_store
     and g.grant_key = p_purchase_ref_digest
   for update;
  if found then
    if v_grant.user_id <> p_user_id then
      return jsonb_build_object('classification', 'rejected', 'reason', 'purchase_owned_by_other_user');
    end if;
    if v_grant.provider_environment <> p_environment then
      return jsonb_build_object('classification', 'rejected', 'reason', 'environment_mismatch');
    end if;
  else
    v_is_new := true;
  end if;

  select s.has_access, s.effective_expires_at into v_access_before, v_expires_before
    from public.kplus_effective_access_state(p_user_id, p_entitlement_key, v_now) s;

  -- 7. Ordering. A stale transition never changes ownership or access. It may
  --    only merge one monotone provenance fact (the earliest purchase time
  --    seen), which keeps the final row identical whatever order events arrive.
  if not v_is_new
     and (p_provider_occurred_at, v_rank, p_external_event_id)
         <= (v_grant.provider_state_occurred_at, v_grant.provider_state_rank, v_grant.provider_state_event_id) then
    update public.kplus_entitlement_grants
       set starts_at = least(starts_at, p_purchased_at)
     where id = v_grant.id;

    insert into public.kplus_entitlement_transitions (
      user_id, entitlement_key, grant_id, cause, provider, external_event_id,
      provider_environment, provider_event_type, provider_occurred_at, lifecycle_state,
      outcome, outcome_reason, access_before, access_after,
      effective_expires_at_before, effective_expires_at_after
    )
    values (
      p_user_id, p_entitlement_key, v_grant.id, p_cause, p_provider, p_external_event_id,
      p_environment, p_provider_event_type, p_provider_occurred_at, p_lifecycle_state,
      'stale', 'older_than_applied_provider_state', v_access_before, v_access_before,
      v_expires_before, v_expires_before
    )
    returning id into v_transition_id;

    return jsonb_build_object(
      'classification', 'stale',
      'transitionId', v_transition_id,
      'grantId', v_grant.id,
      'accessBefore', v_access_before,
      'accessAfter', v_access_before
    );
  end if;

  -- 8. Apply. A lifetime grant is created open-ended with none of the
  --    subscription-only facts; product and digest provenance never change.
  if v_is_new then
    insert into public.kplus_entitlement_grants (
      user_id, entitlement_key, source, grant_key,
      provider, store, provider_environment, product_id,
      starts_at, expires_at, is_open_ended,
      billing_state, revoked_at, revocation_reason,
      provider_state_occurred_at, provider_state_rank, provider_state_event_id,
      last_provider_verified_at
    )
    values (
      p_user_id, p_entitlement_key, 'store_lifetime', p_purchase_ref_digest,
      p_provider, p_store, p_environment, p_product_id,
      p_purchased_at, null, true,
      'normal', v_revoked_at, v_revocation,
      p_provider_occurred_at, v_rank, p_external_event_id,
      v_now
    )
    returning * into v_grant;
  else
    update public.kplus_entitlement_grants
       set starts_at = least(starts_at, p_purchased_at),
           revoked_at = v_revoked_at,
           revocation_reason = v_revocation,
           provider_state_occurred_at = p_provider_occurred_at,
           provider_state_rank = v_rank,
           provider_state_event_id = p_external_event_id,
           last_provider_verified_at = v_now,
           updated_at = v_now
     where id = v_grant.id
    returning * into v_grant;
  end if;

  select s.has_access, s.is_open_ended, s.effective_expires_at
    into v_access_after, v_open_after, v_expires_after
    from public.kplus_effective_access_state(p_user_id, p_entitlement_key, v_now) s;

  -- 9. Activation: only when the USER goes from no K+ to K+. Owning lifetime on
  --    top of complimentary or a subscription is continuous access and creates
  --    no Welcome event; a reversed refund that restores K+ is a reactivation.
  if not v_access_before and v_access_after then
    insert into public.kplus_entitlement_activations (
      user_id, entitlement_key, activation_class, grant_id,
      effective_started_at, effective_expires_at, effective_open_ended, is_reactivation
    )
    values (
      p_user_id, p_entitlement_key, 'lifetime', v_grant.id,
      v_now, v_expires_after, v_open_after,
      exists (select 1 from public.kplus_entitlement_activations a
               where a.user_id = p_user_id and a.entitlement_key = p_entitlement_key)
    )
    returning id into v_activation_id;
  end if;

  insert into public.kplus_entitlement_transitions (
    user_id, entitlement_key, grant_id, cause, provider, external_event_id,
    provider_environment, provider_event_type, provider_occurred_at, lifecycle_state,
    outcome, access_before, access_after,
    effective_expires_at_before, effective_expires_at_after, activation_id
  )
  values (
    p_user_id, p_entitlement_key, v_grant.id, p_cause, p_provider, p_external_event_id,
    p_environment, p_provider_event_type, p_provider_occurred_at, p_lifecycle_state,
    'applied', v_access_before, v_access_after,
    v_expires_before, v_expires_after, v_activation_id
  )
  returning id into v_transition_id;

  return jsonb_build_object(
    'classification', 'applied',
    'transitionId', v_transition_id,
    'grantId', v_grant.id,
    'activationId', v_activation_id,
    'accessBefore', v_access_before,
    'accessAfter', v_access_after
  );
end;
$$;

comment on function public.apply_kplus_provider_lifetime_transition(uuid, text, text, text, text, timestamptz, text, text, text, text, text, timestamptz, text) is
  'Verified provider state -> K+ lifetime ownership (one-time non-consumable store purchase). service_role only. Idempotent on (provider, external_event_id), out-of-order safe, actor, store and environment isolated. Carries no price, receipt, purchase token or payload; the purchase is an opaque SHA-256 digest.';

-- ============================================================================
-- 6. Function privileges
-- ============================================================================

revoke all on function public.kplus_entitlement_facts(uuid, text, timestamptz) from public, anon, authenticated;
revoke all on function public.kplus_entitlement_summary(uuid, text) from public, anon, authenticated;
revoke all on function public.revoke_kplus_grant(uuid, uuid) from public, anon, authenticated;
revoke all on function public.apply_kplus_provider_lifetime_transition(uuid, text, text, text, text, timestamptz, text, text, text, text, text, timestamptz, text) from public, anon, authenticated;

grant execute on function public.kplus_entitlement_facts(uuid, text, timestamptz) to service_role;
grant execute on function public.kplus_entitlement_summary(uuid, text) to service_role;
grant execute on function public.revoke_kplus_grant(uuid, uuid) to service_role;
grant execute on function public.apply_kplus_provider_lifetime_transition(uuid, text, text, text, text, timestamptz, text, text, text, text, text, timestamptz, text) to service_role;

-- ============================================================================
-- 7. Post-condition guard: fail the migration, loudly, if any client role can
--    reach a K+ table or a privileged K+ function, or if the vocabulary did not
--    land.
-- ============================================================================

do $$
declare
  v_violation text;
begin
  select string_agg(format('%s/%s/%s', c.relname, r.role_name, p.priv), ', ')
    into v_violation
    from pg_class c
    cross join (values ('anon'), ('authenticated')) as r(role_name)
    cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) as p(priv)
   where c.oid in ('public.kplus_entitlement_grants'::regclass,
                   'public.kplus_entitlement_activations'::regclass,
                   'public.kplus_entitlement_transitions'::regclass)
     and has_table_privilege(r.role_name, c.oid, p.priv);
  if v_violation is not null then
    raise exception 'K+ entitlement tables must not be client-accessible: %', v_violation;
  end if;

  select string_agg(format('%s/%s', pr.oid::regprocedure, r.role_name), ', ')
    into v_violation
    from pg_proc pr
    join pg_namespace n on n.oid = pr.pronamespace
    cross join (values ('anon'), ('authenticated')) as r(role_name)
   where n.nspname = 'public'
     and pr.proname in ('kplus_entitlement_facts', 'kplus_effective_access_state',
                        'kplus_has_active_entitlement', 'kplus_user_entitlement_row_is_active',
                        'kplus_entitlement_summary', 'grant_kplus_complimentary',
                        'revoke_kplus_grant', 'apply_kplus_provider_transition',
                        'apply_kplus_provider_lifetime_transition',
                        'grant_kplus_early_access')
     and has_function_privilege(r.role_name, pr.oid, 'EXECUTE');
  if v_violation is not null then
    raise exception 'privileged K+ functions must not be client-executable: %', v_violation;
  end if;

  if has_function_privilege('anon', 'public.get_my_kplus_entitlement_summary()', 'EXECUTE') then
    raise exception 'get_my_kplus_entitlement_summary must not be executable by anon';
  end if;
  if not has_function_privilege('authenticated', 'public.get_my_kplus_entitlement_summary()', 'EXECUTE') then
    raise exception 'get_my_kplus_entitlement_summary must be executable by authenticated';
  end if;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.kplus_entitlement_grants'::regclass
       and conname = 'kplus_entitlement_grants_source_check'
       and pg_get_constraintdef(oid) like '%store_lifetime%'
  ) then
    raise exception 'store_lifetime did not land in kplus_entitlement_grants_source_check';
  end if;
end;
$$;
