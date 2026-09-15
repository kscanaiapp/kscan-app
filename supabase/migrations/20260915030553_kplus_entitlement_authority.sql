-- K Scan AI -- Build 34 K+ entitlement authority (K+ Paywall Program, Phase 1).
--
-- One server-controlled answer to: does this authenticated K Scan AI user
-- currently have K+, why, and until when?
--
-- ADDS (additive; no existing row is rewritten, no table or column dropped):
--
--   kplus_entitlement_grants        One row per K+ grant. A user may hold
--                                   several at once (complimentary + store
--                                   subscription, employee + trial, ...). Each
--                                   grant keeps its own provenance; none ever
--                                   replaces or deletes another.
--   kplus_entitlement_transitions   Append-oriented ledger of applied and stale
--                                   grant transitions. Its unique
--                                   (provider, external_event_id) index is the
--                                   provider-event idempotency key.
--   kplus_entitlement_activations   One row per "no effective K+ -> effective
--                                   K+" activation. The future Welcome to K+
--                                   delivery contract. No email address, no
--                                   price.
--
--   kplus_entitlement_facts, kplus_effective_access_state,
--   kplus_entitlement_summary       The single resolver (service_role only).
--   get_my_kplus_entitlement_summary()
--                                   The only client-callable K+ read. Identity
--                                   comes from auth.uid(), never an argument.
--   grant_kplus_complimentary, revoke_kplus_grant,
--   apply_kplus_provider_transition The trusted mutation boundary
--                                   (service_role only).
--   kplus_user_entitlement_row_is_active
--                                   Row-scoped predicate for the existing
--                                   RevenueCat mirror gate in kplus-activate.
--
-- CHANGES:
--
--   kplus_has_active_entitlement(uuid, text) now answers from the resolver:
--     the union of every currently valid grant. has_active_k_plus(), Closet
--     RLS, Packing, Wardrobe Concierge, Signature Style, Watchlist and VTO all
--     already delegate to it, so every server-side K+ gate consumes this
--     contract without a change of its own.
--   grant_kplus_early_access(uuid) keeps its signature, return shape and
--     idempotency. It is additionally serialized per user and records a
--     complimentary activation when it takes a user from no K+ to K+.
--
-- DUAL-READ COMPATIBILITY (deliberate, documented):
--
--   user_entitlements is NOT copied into kplus_entitlement_grants. Shipped
--   Build 34 clients read it directly, and kplus-activate /
--   kplus-reconcile-revenuecat mirror it into RevenueCat. The resolver reads it
--   through the EXACT Build 34 canonical predicate
--     status = 'active' AND revoked_at IS NULL
--     AND expires_at IS NOT NULL AND expires_at > now()
--   so no existing user gains or loses access. A legacy row with a NULL expiry
--   stays inactive: it is never reinterpreted as open-ended access, which would
--   grant access that does not exist today.
--
-- CURRENT COMMERCIAL STATE: K+ is $0 in Build 34 and is delivered only as
-- K Scan AI-controlled complimentary grants. Nothing here represents that as a
-- store subscription, and nothing here stores a price, a currency, a receipt, a
-- purchase token, a provider payload or an email address. Paid K+ is not
-- activated by this migration.
--
-- TIME: every timestamp is timestamptz (stored as UTC). Access is evaluated
-- against server now(); no function accepts a client time.
--
-- ROLLBACK / FIX-FORWARD: every object is new except the two replaced
-- functions. Restoring Build 34 behaviour is a forward migration that
-- re-creates kplus_has_active_entitlement and grant_kplus_early_access from
-- 20260829120000 / 20260829180000. The new tables may then remain unused. No
-- step deletes or rewrites user_entitlements data.

-- ============================================================================
-- 1. Grants
-- ============================================================================

create table if not exists public.kplus_entitlement_grants (
  id                          uuid primary key default gen_random_uuid(),
  user_id                     uuid not null references auth.users(id) on delete cascade,
  entitlement_key             text not null,
  source                      text not null,
  grant_key                   text not null,
  campaign_id                 text,
  provider                    text,
  store                       text,
  provider_environment        text,
  product_id                  text,
  starts_at                   timestamptz not null,
  expires_at                  timestamptz,
  is_open_ended               boolean not null default false,
  current_period_type         text,
  current_period_starts_at    timestamptz,
  trial_ends_at               timestamptz,
  will_renew                  boolean,
  billing_state               text not null default 'normal',
  grace_period_expires_at     timestamptz,
  pause_resumes_at            timestamptz,
  revoked_at                  timestamptz,
  revocation_reason           text,
  provider_state_occurred_at  timestamptz,
  provider_state_rank         smallint,
  provider_state_event_id     text,
  last_provider_verified_at   timestamptz,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),

  constraint kplus_entitlement_grants_identity_key
    unique (user_id, entitlement_key, source, grant_key),
  constraint kplus_entitlement_grants_entitlement_key_check
    check (entitlement_key ~ '^[a-z][a-z0-9_]{1,62}$'),
  constraint kplus_entitlement_grants_source_check
    check (source in (
      'store_subscription', 'complimentary', 'complimentary_code',
      'employee', 'friends_family', 'manual_support', 'promotional'
    )),
  constraint kplus_entitlement_grants_grant_key_check
    check (grant_key ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'),
  constraint kplus_entitlement_grants_campaign_id_check
    check (campaign_id is null or campaign_id ~ '^[a-z0-9][a-z0-9_.:-]{0,63}$'),
  constraint kplus_entitlement_grants_provider_check
    check (provider is null or provider = 'revenuecat'),
  constraint kplus_entitlement_grants_store_check
    check (store is null or store in ('apple', 'google')),
  constraint kplus_entitlement_grants_environment_check
    check (provider_environment is null or provider_environment in ('production', 'sandbox')),
  constraint kplus_entitlement_grants_product_id_check
    check (product_id is null or product_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'),
  constraint kplus_entitlement_grants_period_type_check
    check (current_period_type is null or current_period_type in ('trial', 'paid')),
  constraint kplus_entitlement_grants_billing_state_check
    check (billing_state in ('normal', 'grace_period', 'billing_retry', 'account_hold', 'paused')),
  constraint kplus_entitlement_grants_state_event_id_check
    check (provider_state_event_id is null or provider_state_event_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'),
  constraint kplus_entitlement_grants_state_rank_check
    check (provider_state_rank is null or provider_state_rank between 1 and 100),
  -- A NULL expiry is only ever a deliberate open-ended grant, never an
  -- accident: the flag and the NULL must agree.
  constraint kplus_entitlement_grants_open_ended_check
    check ((expires_at is null) = is_open_ended),
  constraint kplus_entitlement_grants_window_check
    check (expires_at is null or expires_at > starts_at),
  -- Store facts exist exactly on store grants. A store grant is never
  -- open-ended, and its grant_key is an opaque SHA-256 digest of the provider
  -- subscription reference, so no raw transaction id or purchase token can
  -- enter this table.
  constraint kplus_entitlement_grants_store_shape_check
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
      (source <> 'store_subscription'
        and provider is null and store is null and provider_environment is null
        and product_id is null and current_period_type is null
        and current_period_starts_at is null and trial_ends_at is null and will_renew is null
        and billing_state = 'normal' and grace_period_expires_at is null
        and pause_resumes_at is null
        and provider_state_occurred_at is null and provider_state_rank is null
        and provider_state_event_id is null and last_provider_verified_at is null)
    ),
  constraint kplus_entitlement_grants_billing_detail_check
    check (
      ((billing_state = 'grace_period') = (grace_period_expires_at is not null))
      and (billing_state = 'paused' or pause_resumes_at is null)
    ),
  -- Refund/revocation is its own fact, separate from cancellation
  -- (will_renew = false). K Scan AI never issues a store refund; a store grant
  -- is only revoked by a provider transition.
  constraint kplus_entitlement_grants_revocation_check
    check (
      (revoked_at is null and revocation_reason is null)
      or (revoked_at is not null and (
        (source = 'store_subscription' and revocation_reason in ('refunded', 'provider_revoked'))
        or (source <> 'store_subscription' and revocation_reason = 'operator_revoked')
      ))
    )
);

-- One store subscription belongs to at most ONE K Scan AI user. A second user
-- presenting the same subscription reference is refused, never merged: this is
-- the database half of "no accidental cross-account inheritance".
create unique index if not exists kplus_entitlement_grants_store_subscription_key
  on public.kplus_entitlement_grants (provider, store, grant_key)
  where source = 'store_subscription';

comment on table public.kplus_entitlement_grants is
  'K Scan AI K+ grants. Several may be valid at once; effective K+ is their union (see kplus_entitlement_facts). No client access -- read through get_my_kplus_entitlement_summary(), write through the service_role RPCs only. No price, receipt, purchase token, payload or email is stored.';
comment on column public.kplus_entitlement_grants.grant_key is
  'Idempotency identity within (user_id, entitlement_key, source). Store grants: lowercase hex SHA-256 digest of the provider subscription reference. Complimentary grants: the trusted caller''s idempotency key.';
comment on column public.kplus_entitlement_grants.provider_state_occurred_at is
  'Ordering watermark: provider time of the newest applied provider fact. With provider_state_rank and provider_state_event_id it totally orders provider transitions; an event at or below it is stale.';

-- ============================================================================
-- 2. Activations (lifecycle activation events)
-- ============================================================================

create table if not exists public.kplus_entitlement_activations (
  id                     uuid primary key default gen_random_uuid(),
  event_id               uuid not null default gen_random_uuid(),
  user_id                uuid not null references auth.users(id) on delete cascade,
  entitlement_key        text not null,
  activation_class       text not null,
  grant_id               uuid references public.kplus_entitlement_grants(id) on delete cascade,
  legacy_entitlement_id  uuid references public.user_entitlements(id) on delete cascade,
  effective_started_at   timestamptz not null,
  effective_expires_at   timestamptz,
  effective_open_ended   boolean not null,
  is_reactivation        boolean not null,
  created_at             timestamptz not null default now(),

  constraint kplus_entitlement_activations_event_id_key unique (event_id),
  constraint kplus_entitlement_activations_entitlement_key_check
    check (entitlement_key ~ '^[a-z][a-z0-9_]{1,62}$'),
  constraint kplus_entitlement_activations_class_check
    check (activation_class in ('subscription_or_trial', 'complimentary')),
  constraint kplus_entitlement_activations_origin_check
    check (num_nonnulls(grant_id, legacy_entitlement_id) = 1),
  constraint kplus_entitlement_activations_open_ended_check
    check ((effective_expires_at is null) = effective_open_ended)
);

create index if not exists kplus_entitlement_activations_user_idx
  on public.kplus_entitlement_activations (user_id, created_at desc);
create index if not exists kplus_entitlement_activations_grant_idx
  on public.kplus_entitlement_activations (grant_id);
create index if not exists kplus_entitlement_activations_legacy_idx
  on public.kplus_entitlement_activations (legacy_entitlement_id);

comment on table public.kplus_entitlement_activations is
  'One row per transition from no effective K+ to effective K+ (event kplus.entitlement_activated). A change of source while access stays continuous creates no row. No email address and no price: a future sender resolves both at send time from verified sources.';

-- ============================================================================
-- 3. Transitions (ledger + provider-event idempotency)
-- ============================================================================

create table if not exists public.kplus_entitlement_transitions (
  id                           uuid primary key default gen_random_uuid(),
  user_id                      uuid not null references auth.users(id) on delete cascade,
  entitlement_key              text not null,
  grant_id                     uuid references public.kplus_entitlement_grants(id) on delete set null,
  cause                        text not null,
  provider                     text,
  external_event_id            text,
  provider_environment         text,
  provider_event_type          text,
  provider_occurred_at         timestamptz,
  lifecycle_state              text,
  outcome                      text not null,
  outcome_reason               text,
  access_before                boolean not null,
  access_after                 boolean not null,
  effective_expires_at_before  timestamptz,
  effective_expires_at_after   timestamptz,
  activation_id                uuid references public.kplus_entitlement_activations(id) on delete set null,
  duplicate_deliveries         integer not null default 0,
  last_duplicate_at            timestamptz,
  recorded_at                  timestamptz not null default now(),

  constraint kplus_entitlement_transitions_entitlement_key_check
    check (entitlement_key ~ '^[a-z][a-z0-9_]{1,62}$'),
  constraint kplus_entitlement_transitions_cause_check
    check (cause in ('provider_event', 'provider_reconciliation', 'complimentary_grant', 'grant_revocation')),
  constraint kplus_entitlement_transitions_external_event_id_check
    check (external_event_id is null or external_event_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'),
  constraint kplus_entitlement_transitions_event_type_check
    check (provider_event_type is null or provider_event_type in (
      'initial_purchase', 'renewal', 'product_change', 'cancellation', 'uncancellation',
      'billing_issue', 'subscription_paused', 'subscription_extended', 'expiration',
      'refund', 'refund_reversed', 'transfer', 'reconciliation_snapshot'
    )),
  constraint kplus_entitlement_transitions_lifecycle_state_check
    check (lifecycle_state is null or lifecycle_state in (
      'trial', 'active', 'grace_period', 'billing_retry', 'account_hold',
      'paused', 'expired', 'refunded', 'revoked'
    )),
  constraint kplus_entitlement_transitions_outcome_check
    check (outcome in ('applied', 'stale')),
  constraint kplus_entitlement_transitions_outcome_reason_check
    check (outcome_reason is null or outcome_reason ~ '^[a-z][a-z0-9_]{0,63}$'),
  constraint kplus_entitlement_transitions_duplicates_check
    check (duplicate_deliveries >= 0 and ((duplicate_deliveries = 0) = (last_duplicate_at is null))),
  constraint kplus_entitlement_transitions_shape_check
    check (
      (cause in ('provider_event', 'provider_reconciliation')
        and provider = 'revenuecat' and external_event_id is not null
        and provider_environment in ('production', 'sandbox')
        and provider_event_type is not null and provider_occurred_at is not null
        and lifecycle_state is not null
        and ((cause = 'provider_reconciliation') = (provider_event_type = 'reconciliation_snapshot')))
      or
      (cause in ('complimentary_grant', 'grant_revocation')
        and provider is null and external_event_id is null and provider_environment is null
        and provider_event_type is null and provider_occurred_at is null
        and lifecycle_state is null and outcome = 'applied' and duplicate_deliveries = 0)
    )
);

-- The provider-event idempotency key: one provider event is recorded, and
-- therefore applied, at most once.
create unique index if not exists kplus_entitlement_transitions_provider_event_key
  on public.kplus_entitlement_transitions (provider, external_event_id)
  where external_event_id is not null;
create index if not exists kplus_entitlement_transitions_user_idx
  on public.kplus_entitlement_transitions (user_id, recorded_at desc);
create index if not exists kplus_entitlement_transitions_grant_idx
  on public.kplus_entitlement_transitions (grant_id);
create index if not exists kplus_entitlement_transitions_activation_idx
  on public.kplus_entitlement_transitions (activation_id);

comment on table public.kplus_entitlement_transitions is
  'Append-oriented K+ grant ledger. Only normalized identifiers and facts: no email, name, phone, JWT, receipt, purchase token, price, currency, country or provider payload (there is no json column). The only columns ever updated after insert are the duplicate-delivery counters. Removed with the user at account purge.';

-- ============================================================================
-- 4. Privileges: no client access to any of the three tables
-- ============================================================================

alter table public.kplus_entitlement_grants enable row level security;
alter table public.kplus_entitlement_activations enable row level security;
alter table public.kplus_entitlement_transitions enable row level security;

-- No policies at all: RLS denies every non-bypass role. Supabase default
-- privileges grant new public tables to anon/authenticated, so revoke
-- explicitly. service_role keeps SELECT only (deletion residual verification,
-- operator audit); every write goes through the RPCs below.
revoke all on public.kplus_entitlement_grants from public, anon, authenticated, service_role;
revoke all on public.kplus_entitlement_activations from public, anon, authenticated, service_role;
revoke all on public.kplus_entitlement_transitions from public, anon, authenticated, service_role;
grant select on public.kplus_entitlement_grants to service_role;
grant select on public.kplus_entitlement_activations to service_role;
grant select on public.kplus_entitlement_transitions to service_role;

-- ============================================================================
-- 5. The resolver
-- ============================================================================

-- Every K+ grant a user holds, legacy and new, normalized into one shape.
-- p_at exists for boundary evaluation inside trusted code; every
-- authorization path passes now().
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
  select
    'grant'::text,
    g.id,
    g.source,
    case
      when g.source <> 'store_subscription' then 'complimentary'
      when g.current_period_type = 'trial' then 'trial'
      else 'subscription'
    end,
    (case
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

-- Effective access = union of contributing grants. Effective expiry = the
-- latest contributing window, or NULL when any contributing grant is
-- open-ended. (Grants cannot be scheduled to start in the future -- the RPCs
-- refuse it -- so the union of windows covering p_at is contiguous.)
create or replace function public.kplus_effective_access_state(
  p_user_id         uuid,
  p_entitlement_key text,
  p_at              timestamptz
)
returns table (
  has_access           boolean,
  is_open_ended        boolean,
  effective_expires_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    coalesce(bool_or(f.contributes_access), false),
    coalesce(bool_or(f.contributes_access and f.is_open_ended), false),
    case when coalesce(bool_or(f.contributes_access and f.is_open_ended), false)
      then null
      else max(f.access_until) filter (where f.contributes_access)
    end
  from public.kplus_entitlement_facts(p_user_id, p_entitlement_key, p_at) f;
$$;

-- The canonical server-side K+ predicate, now multi-grant.
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
  select s.has_access
    from public.kplus_effective_access_state(p_user_id, p_entitlement_key, now()) s;
$$;

-- Row-scoped predicate: is THIS user_entitlements row itself currently valid?
-- kplus-activate mirrors that row's expiry into RevenueCat, so the mirror gate
-- must ask about the row, not about the user. With several grants, "the user
-- has K+" no longer implies "this row is valid" (SEC-KPLUS-008).
create or replace function public.kplus_user_entitlement_row_is_active(
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
    select 1 from public.user_entitlements ue
     where ue.user_id = p_user_id
       and ue.entitlement_key = p_entitlement_key
       and ue.status = 'active'
       and ue.revoked_at is null
       and ue.expires_at is not null
       and ue.expires_at > now()
  );
$$;

-- The read contract (service_role form). Exposes only what a client needs:
-- no grant ids, event ids, digests, product ids, campaign ids or sync state.
--
-- Display-source precedence among CONTRIBUTING grants (deterministic):
--   1 subscription  (store, paid period)
--   2 trial         (store, trial period)
--   3 complimentary (complimentary, complimentary_code, employee,
--                    friends_family, manual_support, promotional)
--   4 unknown       (legacy rows with unverified provenance)
-- ties: open-ended first, then latest access_until, earliest start, fact id.
-- Store/billing fields describe the store relationship a customer can act on
-- (contributing first, then the newest provider fact), even when it is not
-- the display source -- e.g. complimentary K+ plus a Google subscription on
-- account hold.
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
    'accountManagement', jsonb_build_object(
      'storeManagementRelevant', coalesce(v_store_found, false),
      'managementStore', v_store
    ),
    'snapshotIssuedAt', to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
end;
$$;

-- The one client-callable read. No argument can name a user; an
-- unauthenticated caller is an error, never "free".
create or replace function public.get_my_kplus_entitlement_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  return public.kplus_entitlement_summary(v_uid, 'k_plus');
end;
$$;

-- ============================================================================
-- 6. Trusted mutation boundary
-- ============================================================================

-- Complimentary-family grant. Future access-code redemption calls this rather
-- than writing grant rows. Idempotent on (user, key, source, grant_key).
create or replace function public.grant_kplus_complimentary(
  p_user_id         uuid,
  p_source          text,
  p_grant_key       text,
  p_campaign_id     text default null,
  p_starts_at       timestamptz default null,
  p_expires_at      timestamptz default null,
  p_entitlement_key text default 'k_plus'
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  c_max_start_skew constant interval := interval '5 minutes';
  v_now            timestamptz := now();
  v_starts_at      timestamptz := coalesce(p_starts_at, now());
  v_is_anonymous   boolean;
  v_account_status text;
  v_locked_at      timestamptz;
  v_existing       public.kplus_entitlement_grants;
  v_grant          public.kplus_entitlement_grants;
  v_access_before  boolean;
  v_expires_before timestamptz;
  v_access_after   boolean;
  v_open_after     boolean;
  v_expires_after  timestamptz;
  v_activation_id  uuid;
  v_transition_id  uuid;
begin
  if p_user_id is null or p_source is null or p_grant_key is null then
    raise exception 'p_user_id, p_source and p_grant_key are required' using errcode = '22004';
  end if;
  if p_entitlement_key is distinct from 'k_plus' then
    raise exception 'unsupported entitlement key' using errcode = '22023';
  end if;
  if p_source not in ('complimentary', 'complimentary_code', 'employee', 'friends_family',
                      'manual_support', 'promotional') then
    raise exception 'unsupported complimentary source' using errcode = '22023';
  end if;
  if p_grant_key !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$' then
    raise exception 'invalid grant key' using errcode = '22023';
  end if;
  if p_campaign_id is not null and p_campaign_id !~ '^[a-z0-9][a-z0-9_.:-]{0,63}$' then
    raise exception 'invalid campaign id' using errcode = '22023';
  end if;
  if v_starts_at > v_now + c_max_start_skew then
    raise exception 'future-dated grants are not supported' using errcode = '22023';
  end if;
  if p_expires_at is not null and p_expires_at <= greatest(v_starts_at, v_now) then
    raise exception 'expires_at must be in the future and after starts_at' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('kplus_entitlement:' || p_user_id::text, 0));

  select u.is_anonymous into v_is_anonymous from auth.users u where u.id = p_user_id;
  if not found then
    return jsonb_build_object('outcome', 'rejected', 'reason', 'unknown_user');
  end if;
  if coalesce(v_is_anonymous, false) then
    return jsonb_build_object('outcome', 'rejected', 'reason', 'anonymous_identity');
  end if;

  select p.account_status, p.account_locked_at into v_account_status, v_locked_at
    from public.profiles p where p.id = p_user_id;
  if not found or v_account_status is distinct from 'active' or v_locked_at is not null then
    return jsonb_build_object('outcome', 'rejected', 'reason', 'account_not_active');
  end if;

  select * into v_existing
    from public.kplus_entitlement_grants g
   where g.user_id = p_user_id
     and g.entitlement_key = p_entitlement_key
     and g.source = p_source
     and g.grant_key = p_grant_key
   for update;
  if found then
    return jsonb_build_object(
      'outcome',
      case when v_existing.campaign_id is not distinct from p_campaign_id
            and v_existing.expires_at is not distinct from p_expires_at
            and (p_starts_at is null or v_existing.starts_at = p_starts_at)
        then 'already_granted' else 'grant_key_conflict' end,
      'grantId', v_existing.id
    );
  end if;

  select s.has_access, s.effective_expires_at into v_access_before, v_expires_before
    from public.kplus_effective_access_state(p_user_id, p_entitlement_key, v_now) s;

  insert into public.kplus_entitlement_grants (
    user_id, entitlement_key, source, grant_key, campaign_id,
    starts_at, expires_at, is_open_ended
  )
  values (
    p_user_id, p_entitlement_key, p_source, p_grant_key, p_campaign_id,
    v_starts_at, p_expires_at, p_expires_at is null
  )
  returning * into v_grant;

  select s.has_access, s.is_open_ended, s.effective_expires_at
    into v_access_after, v_open_after, v_expires_after
    from public.kplus_effective_access_state(p_user_id, p_entitlement_key, v_now) s;

  if not v_access_before and v_access_after then
    insert into public.kplus_entitlement_activations (
      user_id, entitlement_key, activation_class, grant_id,
      effective_started_at, effective_expires_at, effective_open_ended, is_reactivation
    )
    values (
      p_user_id, p_entitlement_key, 'complimentary', v_grant.id,
      v_now, v_expires_after, v_open_after,
      exists (select 1 from public.kplus_entitlement_activations a
               where a.user_id = p_user_id and a.entitlement_key = p_entitlement_key)
    )
    returning id into v_activation_id;
  end if;

  insert into public.kplus_entitlement_transitions (
    user_id, entitlement_key, grant_id, cause, outcome,
    access_before, access_after, effective_expires_at_before, effective_expires_at_after,
    activation_id
  )
  values (
    p_user_id, p_entitlement_key, v_grant.id, 'complimentary_grant', 'applied',
    v_access_before, v_access_after, v_expires_before, v_expires_after,
    v_activation_id
  )
  returning id into v_transition_id;

  return jsonb_build_object(
    'outcome', 'granted',
    'grantId', v_grant.id,
    'transitionId', v_transition_id,
    'activationId', v_activation_id,
    'accessBefore', v_access_before,
    'accessAfter', v_access_after
  );
end;
$$;

-- Operator revocation of a complimentary-family grant. Store grants are only
-- ever revoked by a provider transition.
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
  if v_grant.source = 'store_subscription' then
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

-- Verified provider state -> K Scan AI authority. Called only by trusted
-- server code (a future RevenueCat webhook or reconciliation pull) that has
-- already authenticated the provider and resolved p_user_id from the
-- provider's App User ID (which must equal the Supabase auth UUID).
--
-- Classification:
--   applied    the transition is newer than the grant's applied provider state
--   duplicate  this (provider, external_event_id) was already recorded; nothing
--              is re-applied, only the delivery counter moves
--   stale      older than the applied provider state; recorded for audit,
--              never applied
--   rejected   refused and NOT recorded, so a legitimate retry is still
--              possible (unknown user, anonymous identity, subscription owned
--              by another user, environment mismatch, provider time too far in
--              the future, event id reused for another user)
--
-- Ordering is by provider facts only -- (provider_occurred_at, lifecycle rank,
-- external_event_id) -- never by server receipt time. The lifecycle rank breaks
-- exact-timestamp ties toward the more restrictive state.
create or replace function public.apply_kplus_provider_transition(
  p_user_id                 uuid,
  p_provider                text,
  p_cause                   text,
  p_external_event_id       text,
  p_provider_event_type     text,
  p_provider_occurred_at    timestamptz,
  p_environment             text,
  p_store                   text,
  p_product_id              text,
  p_subscription_ref_digest text,
  p_lifecycle_state         text,
  p_period_type             text,
  p_period_starts_at        timestamptz,
  p_expires_at              timestamptz,
  p_will_renew              boolean,
  p_trial_ends_at           timestamptz default null,
  p_grace_period_expires_at timestamptz default null,
  p_pause_resumes_at        timestamptz default null,
  p_entitlement_key         text default 'k_plus'
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  c_max_future_skew      constant interval := interval '15 minutes';
  c_continuity_tolerance constant interval := interval '1 hour';
  v_now             timestamptz := now();
  v_rank            smallint;
  v_billing_state   text;
  v_grace           timestamptz;
  v_pause           timestamptz;
  v_revoked_at      timestamptz;
  v_revocation      text;
  v_is_anonymous    boolean;
  v_event           public.kplus_entitlement_transitions;
  v_grant           public.kplus_entitlement_grants;
  v_prev            public.kplus_entitlement_grants;
  v_is_new          boolean := false;
  v_access_before   boolean;
  v_expires_before  timestamptz;
  v_access_after    boolean;
  v_open_after      boolean;
  v_expires_after   timestamptz;
  v_continuous      boolean := false;
  v_activation_id   uuid;
  v_transition_id   uuid;
begin
  -- 1. Structural validation. A malformed call is a caller bug: fail loudly,
  --    persist nothing.
  if p_user_id is null or p_provider is null or p_cause is null or p_external_event_id is null
     or p_provider_event_type is null or p_provider_occurred_at is null or p_environment is null
     or p_store is null or p_product_id is null or p_subscription_ref_digest is null
     or p_lifecycle_state is null or p_period_type is null or p_period_starts_at is null
     or p_expires_at is null or p_will_renew is null then
    raise exception 'required provider transition field is missing' using errcode = '22004';
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
       'initial_purchase', 'renewal', 'product_change', 'cancellation', 'uncancellation',
       'billing_issue', 'subscription_paused', 'subscription_extended', 'expiration',
       'refund', 'refund_reversed', 'transfer', 'reconciliation_snapshot') then
    raise exception 'unsupported provider event type' using errcode = '22023';
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
  if p_subscription_ref_digest !~ '^[0-9a-f]{64}$' then
    raise exception 'subscription reference must be a lowercase hex SHA-256 digest' using errcode = '22023';
  end if;
  if p_lifecycle_state not in ('trial', 'active', 'grace_period', 'billing_retry', 'account_hold',
                               'paused', 'expired', 'refunded', 'revoked') then
    raise exception 'unsupported lifecycle state' using errcode = '22023';
  end if;
  if p_period_type not in ('trial', 'paid') then
    raise exception 'unsupported period type' using errcode = '22023';
  end if;
  if (p_lifecycle_state = 'trial' and p_period_type <> 'trial')
     or (p_lifecycle_state = 'active' and p_period_type <> 'paid') then
    raise exception 'lifecycle state and period type disagree' using errcode = '22023';
  end if;
  if p_expires_at <= p_period_starts_at then
    raise exception 'expires_at must be after the period start' using errcode = '22023';
  end if;
  if (p_lifecycle_state = 'grace_period') <> (p_grace_period_expires_at is not null) then
    raise exception 'grace_period requires, and only grace_period accepts, a grace expiry' using errcode = '22023';
  end if;
  if p_lifecycle_state <> 'paused' and p_pause_resumes_at is not null then
    raise exception 'only paused accepts a resume time' using errcode = '22023';
  end if;
  if p_period_type <> 'trial' and p_trial_ends_at is not null then
    raise exception 'only a trial period accepts a trial end' using errcode = '22023';
  end if;
  if p_lifecycle_state = 'expired' and p_expires_at > p_provider_occurred_at + c_max_future_skew then
    raise exception 'an expired transition requires an elapsed expiry' using errcode = '22023';
  end if;

  -- 2. Provider clock sanity. Beyond the skew allowance a provider timestamp
  --    would poison the ordering watermark, so refuse without recording.
  if p_provider_occurred_at > v_now + c_max_future_skew then
    return jsonb_build_object('classification', 'rejected', 'reason', 'provider_time_in_future');
  end if;

  v_rank := case p_lifecycle_state
    when 'trial' then 10 when 'active' then 10
    when 'grace_period' then 20 when 'billing_retry' then 30
    when 'account_hold' then 40 when 'paused' then 40
    when 'expired' then 50
    when 'refunded' then 60 when 'revoked' then 60
  end;
  v_billing_state := case p_lifecycle_state
    when 'grace_period' then 'grace_period'
    when 'billing_retry' then 'billing_retry'
    when 'account_hold' then 'account_hold'
    when 'paused' then 'paused'
    else 'normal'
  end;
  v_grace := case when p_lifecycle_state = 'grace_period' then p_grace_period_expires_at end;
  v_pause := case when p_lifecycle_state = 'paused' then p_pause_resumes_at end;
  v_revoked_at := case when p_lifecycle_state in ('refunded', 'revoked') then p_provider_occurred_at end;
  v_revocation := case p_lifecycle_state when 'refunded' then 'refunded' when 'revoked' then 'provider_revoked' end;

  -- 3. Serialize every K+ mutation for this user.
  perform pg_advisory_xact_lock(hashtextextended('kplus_entitlement:' || p_user_id::text, 0));

  -- 4. Idempotency.
  select * into v_event
    from public.kplus_entitlement_transitions t
   where t.provider = p_provider and t.external_event_id = p_external_event_id
   for update;
  if found then
    if v_event.user_id <> p_user_id then
      return jsonb_build_object('classification', 'rejected', 'reason', 'event_identity_conflict');
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

  -- 6. Subscription ownership.
  select * into v_grant
    from public.kplus_entitlement_grants g
   where g.source = 'store_subscription'
     and g.provider = p_provider
     and g.store = p_store
     and g.grant_key = p_subscription_ref_digest
   for update;
  if found then
    if v_grant.user_id <> p_user_id then
      return jsonb_build_object('classification', 'rejected', 'reason', 'subscription_owned_by_other_user');
    end if;
    if v_grant.provider_environment <> p_environment then
      return jsonb_build_object('classification', 'rejected', 'reason', 'environment_mismatch');
    end if;
  else
    v_is_new := true;
  end if;

  select s.has_access, s.effective_expires_at into v_access_before, v_expires_before
    from public.kplus_effective_access_state(p_user_id, p_entitlement_key, v_now) s;

  -- 7. Ordering. A stale transition never changes lifecycle or access state.
  --    It may only merge two monotone provenance facts (the earliest period
  --    start seen and the latest trial end seen), which keeps the final row
  --    identical whatever order events arrive in.
  if not v_is_new
     and (p_provider_occurred_at, v_rank, p_external_event_id)
         <= (v_grant.provider_state_occurred_at, v_grant.provider_state_rank, v_grant.provider_state_event_id) then
    update public.kplus_entitlement_grants
       set starts_at = least(starts_at, p_period_starts_at),
           trial_ends_at = case when p_period_type = 'trial'
             then greatest(trial_ends_at, coalesce(p_trial_ends_at, p_expires_at))
             else trial_ends_at end
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

  -- 8. Apply.
  v_prev := v_grant;

  if v_is_new then
    insert into public.kplus_entitlement_grants (
      user_id, entitlement_key, source, grant_key,
      provider, store, provider_environment, product_id,
      starts_at, expires_at, is_open_ended,
      current_period_type, current_period_starts_at, trial_ends_at, will_renew,
      billing_state, grace_period_expires_at, pause_resumes_at,
      revoked_at, revocation_reason,
      provider_state_occurred_at, provider_state_rank, provider_state_event_id,
      last_provider_verified_at
    )
    values (
      p_user_id, p_entitlement_key, 'store_subscription', p_subscription_ref_digest,
      p_provider, p_store, p_environment, p_product_id,
      p_period_starts_at, p_expires_at, false,
      p_period_type, p_period_starts_at,
      case when p_period_type = 'trial' then coalesce(p_trial_ends_at, p_expires_at) end,
      p_will_renew,
      v_billing_state, v_grace, v_pause,
      v_revoked_at, v_revocation,
      p_provider_occurred_at, v_rank, p_external_event_id,
      v_now
    )
    returning * into v_grant;
  else
    update public.kplus_entitlement_grants
       set product_id = p_product_id,
           starts_at = least(starts_at, p_period_starts_at),
           expires_at = p_expires_at,
           current_period_type = p_period_type,
           current_period_starts_at = p_period_starts_at,
           trial_ends_at = case when p_period_type = 'trial'
             then greatest(trial_ends_at, coalesce(p_trial_ends_at, p_expires_at))
             else trial_ends_at end,
           will_renew = p_will_renew,
           billing_state = v_billing_state,
           grace_period_expires_at = v_grace,
           pause_resumes_at = v_pause,
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

  -- 9. Activation. A new activation only when the USER goes from no K+ to K+
  --    and this is not the same subscription continuing:
  --      - resuming from billing retry / account hold / pause, or
  --      - a period that starts within the continuity tolerance of the
  --        previous paid-through (or grace) end -- e.g. trial -> first paid
  --        renewal processed after the trial end.
  --    A refunded/revoked grant never continues.
  if not v_is_new and v_prev.revoked_at is null then
    v_continuous :=
      v_prev.billing_state in ('billing_retry', 'account_hold', 'paused')
      or (case when v_prev.billing_state = 'grace_period'
                 then greatest(v_prev.expires_at, v_prev.grace_period_expires_at)
                 else v_prev.expires_at end) + c_continuity_tolerance >= p_period_starts_at;
  end if;

  if not v_access_before and v_access_after and not v_continuous then
    insert into public.kplus_entitlement_activations (
      user_id, entitlement_key, activation_class, grant_id,
      effective_started_at, effective_expires_at, effective_open_ended, is_reactivation
    )
    values (
      p_user_id, p_entitlement_key, 'subscription_or_trial', v_grant.id,
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

-- ============================================================================
-- 7. Build 34 Early Access activation: same contract, plus activation record
-- ============================================================================

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
#variable_conflict use_column
declare
  v_campaign_key    constant text := 'kplus_early_access_2026';
  v_entitlement_key constant text := 'k_plus';
  v_terms_version   constant text := 'kplus_early_access_v1';
  v_now             timestamptz := now();
  v_row             public.user_entitlements;
  v_inserted        boolean := false;
  v_access_before   boolean;
  v_access_after    boolean;
  v_open_after      boolean;
  v_expires_after   timestamptz;
begin
  if p_user_id is null then
    raise exception 'p_user_id is required' using errcode = '22004';
  end if;

  -- Serialized with every other K+ mutation for this user, so an activation
  -- decision can never race a concurrent grant or provider transition.
  perform pg_advisory_xact_lock(hashtextextended('kplus_entitlement:' || p_user_id::text, 0));

  select s.has_access into v_access_before
    from public.kplus_effective_access_state(p_user_id, v_entitlement_key, v_now) s;

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

  if v_inserted and not v_access_before then
    select s.has_access, s.is_open_ended, s.effective_expires_at
      into v_access_after, v_open_after, v_expires_after
      from public.kplus_effective_access_state(p_user_id, v_entitlement_key, v_now) s;
    if v_access_after then
      insert into public.kplus_entitlement_activations (
        user_id, entitlement_key, activation_class, legacy_entitlement_id,
        effective_started_at, effective_expires_at, effective_open_ended, is_reactivation
      )
      values (
        p_user_id, v_entitlement_key, 'complimentary', v_row.id,
        v_now, v_expires_after, v_open_after,
        exists (select 1 from public.kplus_entitlement_activations a
                 where a.user_id = p_user_id and a.entitlement_key = v_entitlement_key)
      );
    end if;
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

-- ============================================================================
-- 8. Function privileges
-- ============================================================================

revoke all on function public.kplus_entitlement_facts(uuid, text, timestamptz) from public, anon, authenticated;
revoke all on function public.kplus_effective_access_state(uuid, text, timestamptz) from public, anon, authenticated;
revoke all on function public.kplus_has_active_entitlement(uuid, text) from public, anon, authenticated;
revoke all on function public.kplus_user_entitlement_row_is_active(uuid, text) from public, anon, authenticated;
revoke all on function public.kplus_entitlement_summary(uuid, text) from public, anon, authenticated;
revoke all on function public.get_my_kplus_entitlement_summary() from public, anon, service_role;
revoke all on function public.grant_kplus_complimentary(uuid, text, text, text, timestamptz, timestamptz, text) from public, anon, authenticated;
revoke all on function public.revoke_kplus_grant(uuid, uuid) from public, anon, authenticated;
revoke all on function public.apply_kplus_provider_transition(uuid, text, text, text, text, timestamptz, text, text, text, text, text, text, timestamptz, timestamptz, boolean, timestamptz, timestamptz, timestamptz, text) from public, anon, authenticated;
revoke all on function public.grant_kplus_early_access(uuid) from public, anon, authenticated;

grant execute on function public.kplus_entitlement_facts(uuid, text, timestamptz) to service_role;
grant execute on function public.kplus_effective_access_state(uuid, text, timestamptz) to service_role;
grant execute on function public.kplus_has_active_entitlement(uuid, text) to service_role;
grant execute on function public.kplus_user_entitlement_row_is_active(uuid, text) to service_role;
grant execute on function public.kplus_entitlement_summary(uuid, text) to service_role;
grant execute on function public.get_my_kplus_entitlement_summary() to authenticated;
grant execute on function public.grant_kplus_complimentary(uuid, text, text, text, timestamptz, timestamptz, text) to service_role;
grant execute on function public.revoke_kplus_grant(uuid, uuid) to service_role;
grant execute on function public.apply_kplus_provider_transition(uuid, text, text, text, text, timestamptz, text, text, text, text, text, text, timestamptz, timestamptz, boolean, timestamptz, timestamptz, timestamptz, text) to service_role;
grant execute on function public.grant_kplus_early_access(uuid) to service_role;

-- ============================================================================
-- 9. Post-condition guard: fail the migration, loudly, if any client role can
--    reach a K+ table or a privileged K+ function.
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
end;
$$;
