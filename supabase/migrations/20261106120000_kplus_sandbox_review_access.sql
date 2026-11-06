-- B41: restricted, auditable SANDBOX REVIEW entitlement admission (K+).
--
-- Why: Production-backed binaries only ever produce sandbox transactions before
-- public release (Play licence testers, TestFlight, Apple App Review). Production
-- accepts production events only, so no reviewer can activate K+.
--
-- What this adds (and nothing else):
--   * kplus_sandbox_review_accounts  -- server-held authorization per K Scan user,
--     bounded to <= 30 days, revocable. No client access of any kind.
--   * kplus_sandbox_review_audit     -- append-only audit (UPDATE blocked by
--     trigger; no role is granted DELETE; rows cascade only with their account).
--   * kplus_sandbox_review_authorize / _admit_event / _revoke / _sweep -- the only
--     ways to change or consult it; service_role EXECUTE only.
--   * One extra allowed revocation reason, 'sandbox_review_revoked', valid ONLY
--     for store grants whose provider_environment is 'sandbox'.
--   * kplus_sandbox_review_permits + ONE predicate in kplus_entitlement_facts:
--     expiry and revocation are enforced AT THE CANONICAL ACCESS BOUNDARY, not
--     only by the sweep (see "Access boundary" below).
--   * claim_kplus_sandbox_review_reconciliation -- the only way the pull
--     reconciler may open a SANDBOX provider claim on a deployment that does
--     not natively accept sandbox (missed-webhook recovery for review accounts).
--
-- INERT on deploy: the webhook consults _admit_event only when
-- KPLUS_REVENUECAT_SANDBOX_REVIEW_ENABLED is 'true' AND the deployment does not
-- already accept sandbox events; the pull reconciler opens a review claim only
-- under the same switch on a production-configured deployment; and both require
-- an authorization row that only an operator can create. The resolver change is
-- a no-op for every user without an authorization row.
--
-- Access boundary. A sandbox store grant contributes access unless its user
-- holds an authorization row that is not active at the instant asked about
-- (revoked, not yet started, or expired). Consequences:
--   * Expiry and revocation take effect immediately, whether or not the sweep
--     ever runs, and whatever a racing provider event later writes to the grant
--     row (apply_kplus_provider_transition clears revoked_at on any newer
--     provider event, so a renewal racing a revocation can re-activate the ROW;
--     it can no longer re-activate ACCESS).
--   * Production grants, complimentary/operator/legacy grants and every grant of
--     a user with no authorization row are untouched (Staging sandbox testers).
--   * On a deployment that does not accept sandbox natively, a sandbox grant can
--     only be created through admission (_admit_event) or the review claim, and
--     both require the authorization row; no API role may DELETE that row (it
--     goes only with its auth.users row, together with the user's grants).

create table if not exists public.kplus_sandbox_review_accounts (
  user_id        uuid primary key references auth.users(id) on delete cascade,
  purpose        text not null,
  approval_ref   text not null,
  starts_at      timestamptz not null default now(),
  expires_at     timestamptz not null,
  revoked_at     timestamptz,
  revoked_reason text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint kplus_sandbox_review_accounts_purpose_check
    check (purpose in ('app_store_review', 'play_review', 'internal_tester')),
  constraint kplus_sandbox_review_accounts_approval_ref_check
    check (approval_ref ~ '^[A-Za-z0-9][A-Za-z0-9_.:#/-]{0,127}$'),
  constraint kplus_sandbox_review_accounts_window_check
    check (expires_at > starts_at and expires_at <= starts_at + interval '30 days'),
  constraint kplus_sandbox_review_accounts_revocation_check
    check ((revoked_at is null) = (revoked_reason is null)
      and (revoked_reason is null or revoked_reason ~ '^[a-z][a-z0-9_]{0,63}$'))
);

create table if not exists public.kplus_sandbox_review_audit (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references public.kplus_sandbox_review_accounts(user_id) on delete cascade,
  action      text not null,
  event_key   text,
  detail      text,
  occurred_at timestamptz not null default now(),
  constraint kplus_sandbox_review_audit_action_check
    check (action in ('authorized', 'revoked', 'event_admitted', 'event_refused',
                      'reconcile_admitted', 'reconcile_refused')),
  constraint kplus_sandbox_review_audit_event_key_check
    check (event_key is null or event_key ~ '^[0-9a-f]{1,64}$'),
  constraint kplus_sandbox_review_audit_detail_check
    check (detail is null or detail ~ '^[a-z][a-z0-9_]{0,63}$')
);

create index if not exists kplus_sandbox_review_audit_user_idx
  on public.kplus_sandbox_review_audit (user_id, occurred_at);

alter table public.kplus_sandbox_review_accounts enable row level security;
alter table public.kplus_sandbox_review_audit enable row level security;
-- No policies: no client role can read or write either table.
revoke all on table public.kplus_sandbox_review_accounts from public, anon, authenticated, service_role;
revoke all on table public.kplus_sandbox_review_audit from public, anon, authenticated, service_role;
grant select on table public.kplus_sandbox_review_accounts to service_role;
grant select on table public.kplus_sandbox_review_audit to service_role;

create or replace function public.kplus_sandbox_review_audit_immutable_tg()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'kplus_sandbox_review_audit is append-only' using errcode = '42501';
end;
$$;

drop trigger if exists kplus_sandbox_review_audit_immutable on public.kplus_sandbox_review_audit;
create trigger kplus_sandbox_review_audit_immutable
  before update on public.kplus_sandbox_review_audit
  for each row execute function public.kplus_sandbox_review_audit_immutable_tg();

revoke all on function public.kplus_sandbox_review_audit_immutable_tg() from public, anon, authenticated;

-- Store grants may now also be revoked by a sandbox review revocation, but ONLY
-- when the grant itself is a sandbox grant. Every other branch is unchanged.
alter table public.kplus_entitlement_grants
  drop constraint if exists kplus_entitlement_grants_revocation_check,
  add constraint kplus_entitlement_grants_revocation_check
    check (
      (revoked_at is null and revocation_reason is null)
      or (revoked_at is not null and (
        (source in ('store_subscription', 'store_lifetime')
          and revocation_reason in ('refunded', 'provider_revoked'))
        or (source in ('store_subscription', 'store_lifetime')
          and provider_environment = 'sandbox'
          and revocation_reason = 'sandbox_review_revoked')
        or (source not in ('store_subscription', 'store_lifetime')
          and revocation_reason = 'operator_revoked')
      ))
    );

-- ── Authorize (operator, service_role) ──────────────────────────────────────
create or replace function public.kplus_sandbox_review_authorize(
  p_user_id      uuid,
  p_purpose      text,
  p_expires_at   timestamptz,
  p_approval_ref text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_now          timestamptz := now();
  v_is_anonymous boolean;
begin
  if p_user_id is null or p_purpose is null or p_expires_at is null or p_approval_ref is null then
    return jsonb_build_object('outcome', 'rejected', 'reason', 'missing_argument');
  end if;
  select u.is_anonymous into v_is_anonymous from auth.users u where u.id = p_user_id;
  if not found then
    return jsonb_build_object('outcome', 'rejected', 'reason', 'user_not_found');
  end if;
  if coalesce(v_is_anonymous, false) then
    return jsonb_build_object('outcome', 'rejected', 'reason', 'anonymous_user');
  end if;
  if p_purpose not in ('app_store_review', 'play_review', 'internal_tester') then
    return jsonb_build_object('outcome', 'rejected', 'reason', 'invalid_purpose');
  end if;
  if p_approval_ref !~ '^[A-Za-z0-9][A-Za-z0-9_.:#/-]{0,127}$' then
    return jsonb_build_object('outcome', 'rejected', 'reason', 'invalid_approval_ref');
  end if;
  if p_expires_at <= v_now or p_expires_at > v_now + interval '30 days' then
    return jsonb_build_object('outcome', 'rejected', 'reason', 'invalid_window');
  end if;

  insert into public.kplus_sandbox_review_accounts as a (user_id, purpose, approval_ref, starts_at, expires_at)
  values (p_user_id, p_purpose, p_approval_ref, v_now, p_expires_at)
  on conflict (user_id) do update
    set purpose = excluded.purpose,
        approval_ref = excluded.approval_ref,
        starts_at = excluded.starts_at,
        expires_at = excluded.expires_at,
        revoked_at = null,
        revoked_reason = null,
        updated_at = v_now;

  insert into public.kplus_sandbox_review_audit (user_id, action, detail)
  values (p_user_id, 'authorized', p_purpose);

  return jsonb_build_object('outcome', 'authorized', 'expiresAt', p_expires_at);
end;
$$;

-- ── Admit one verified SANDBOX provider event (webhook, service_role) ───────
-- True only for an active, unrevoked authorization at this instant. Audits the
-- decision for authorized-account users; a user with no authorization row is
-- refused without a database write (the webhook logs that refusal).
create or replace function public.kplus_sandbox_review_admit_event(
  p_user_id   uuid,
  p_event_key text
)
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_now     timestamptz := now();
  v_account public.kplus_sandbox_review_accounts;
  v_admit   boolean;
  v_key     text := case when p_event_key ~ '^[0-9a-f]{1,64}$' then p_event_key else null end;
begin
  if p_user_id is null then
    return false;
  end if;
  select * into v_account from public.kplus_sandbox_review_accounts a where a.user_id = p_user_id;
  if not found then
    return false;
  end if;
  v_admit := v_account.revoked_at is null and v_now >= v_account.starts_at and v_now < v_account.expires_at;
  insert into public.kplus_sandbox_review_audit (user_id, action, event_key, detail)
  values (
    p_user_id,
    case when v_admit then 'event_admitted' else 'event_refused' end,
    v_key,
    case when v_admit then null when v_account.revoked_at is not null then 'revoked' else 'outside_window' end
  );
  return v_admit;
end;
$$;

-- ── Revoke (operator / sweep, service_role) ─────────────────────────────────
-- Marks the authorization revoked AND revokes every active SANDBOX store grant
-- of that user in one transaction, under the same per-user lock the entitlement
-- writers use. Production grants are never touched.
create or replace function public.kplus_sandbox_review_revoke(
  p_user_id uuid,
  p_reason  text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_now            timestamptz := now();
  v_reason         text := coalesce(p_reason, 'operator_revoked');
  v_grant          public.kplus_entitlement_grants;
  v_access_after   boolean;
  v_expires_after  timestamptz;
  v_revoked_grants integer := 0;
  v_ids            uuid[] := '{}';
  v_keys           text[] := '{}';
  v_before         boolean[] := '{}';
  v_before_exp     timestamptz[] := '{}';
  i                integer;
begin
  if p_user_id is null then
    return jsonb_build_object('outcome', 'rejected', 'reason', 'missing_argument');
  end if;
  if v_reason !~ '^[a-z][a-z0-9_]{0,63}$' then
    return jsonb_build_object('outcome', 'rejected', 'reason', 'invalid_reason');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('kplus_entitlement:' || p_user_id::text, 0));

  perform 1 from public.kplus_sandbox_review_accounts a where a.user_id = p_user_id for update;
  if not found then
    return jsonb_build_object('outcome', 'rejected', 'reason', 'not_authorized_account');
  end if;

  -- 1. Lock the sandbox grants and snapshot access BEFORE anything changes (the
  --    resolver consults the authorization row, so the snapshot must precede
  --    the authorization update to record a truthful access_before).
  for v_grant in
    select * from public.kplus_entitlement_grants g
     where g.user_id = p_user_id
       and g.source in ('store_subscription', 'store_lifetime')
       and g.provider_environment = 'sandbox'
       and g.revoked_at is null
     order by g.id
     for update
  loop
    v_ids := v_ids || v_grant.id;
    v_keys := v_keys || v_grant.entitlement_key;
    v_before := v_before || (select s.has_access
      from public.kplus_effective_access_state(p_user_id, v_grant.entitlement_key, v_now) s);
    v_before_exp := v_before_exp || (select s.effective_expires_at
      from public.kplus_effective_access_state(p_user_id, v_grant.entitlement_key, v_now) s);
  end loop;

  -- 2. Revoke the authorization (first revocation wins its timestamp/reason)
  --    and every active sandbox store grant. Production grants never match.
  update public.kplus_sandbox_review_accounts
     set revoked_at = coalesce(revoked_at, v_now),
         revoked_reason = coalesce(revoked_reason, v_reason),
         updated_at = v_now
   where user_id = p_user_id;

  if cardinality(v_ids) > 0 then
    update public.kplus_entitlement_grants
       set revoked_at = v_now,
           revocation_reason = 'sandbox_review_revoked',
           updated_at = v_now
     where id = any(v_ids);
  end if;

  -- 3. One canonical revocation transition per grant, with the final state.
  for i in 1 .. coalesce(cardinality(v_ids), 0) loop
    select s.has_access, s.effective_expires_at into v_access_after, v_expires_after
      from public.kplus_effective_access_state(p_user_id, v_keys[i], v_now) s;

    insert into public.kplus_entitlement_transitions (
      user_id, entitlement_key, grant_id, cause, outcome,
      access_before, access_after, effective_expires_at_before, effective_expires_at_after
    )
    values (
      p_user_id, v_keys[i], v_ids[i], 'grant_revocation', 'applied',
      v_before[i], v_access_after, v_before_exp[i], v_expires_after
    );
    v_revoked_grants := v_revoked_grants + 1;
  end loop;

  insert into public.kplus_sandbox_review_audit (user_id, action, detail)
  values (p_user_id, 'revoked', v_reason);

  return jsonb_build_object('outcome', 'revoked', 'revokedSandboxGrants', v_revoked_grants);
end;
$$;

-- ── Sweep (operator / scheduled, service_role) ──────────────────────────────
-- Lifecycle cleanup and audit completeness ONLY: access is already denied at
-- the resolver the instant an authorization expires or is revoked. Picks up
--   * expired, not-yet-revoked authorizations, and
--   * any inactive (expired OR revoked) authorization that still has an
--     unrevoked sandbox grant -- e.g. one re-activated by a provider event that
--     raced the revocation.
create or replace function public.kplus_sandbox_review_sweep()
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_user    uuid;
  v_revoked boolean;
  v_count   integer := 0;
begin
  for v_user, v_revoked in
    select a.user_id, a.revoked_at is not null from public.kplus_sandbox_review_accounts a
     where (a.revoked_at is not null or a.expires_at <= now())
       and (a.revoked_at is null
         or exists (select 1 from public.kplus_entitlement_grants g
                     where g.user_id = a.user_id
                       and g.source in ('store_subscription', 'store_lifetime')
                       and g.provider_environment = 'sandbox'
                       and g.revoked_at is null))
     order by a.user_id
  loop
    perform public.kplus_sandbox_review_revoke(v_user, case when v_revoked then 'revoked_cleanup' else 'expired' end);
    v_count := v_count + 1;
  end loop;
  return jsonb_build_object('outcome', 'swept', 'accounts', v_count);
end;
$$;

revoke all on function public.kplus_sandbox_review_authorize(uuid, text, timestamptz, text) from public, anon, authenticated;
revoke all on function public.kplus_sandbox_review_admit_event(uuid, text) from public, anon, authenticated;
revoke all on function public.kplus_sandbox_review_revoke(uuid, text) from public, anon, authenticated;
revoke all on function public.kplus_sandbox_review_sweep() from public, anon, authenticated;

grant execute on function public.kplus_sandbox_review_authorize(uuid, text, timestamptz, text) to service_role;
grant execute on function public.kplus_sandbox_review_admit_event(uuid, text) to service_role;
grant execute on function public.kplus_sandbox_review_revoke(uuid, text) to service_role;
grant execute on function public.kplus_sandbox_review_sweep() to service_role;

-- ── Access boundary (Repair B) ──────────────────────────────────────────────
-- Is a SANDBOX store grant of this user allowed to contribute access at p_at?
--   * no authorization row            -> true  (ordinary sandbox semantics, e.g.
--                                               Staging testers: unchanged)
--   * authorization row, active at p_at -> true
--   * authorization row, inactive      -> false (revoked, not started, expired)
-- Only kplus_entitlement_facts consults it, and only for sandbox grants.
create or replace function public.kplus_sandbox_review_permits(
  p_user_id uuid,
  p_at      timestamptz
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select a.revoked_at is null and a.starts_at <= p_at and p_at < a.expires_at
       from public.kplus_sandbox_review_accounts a
      where a.user_id = p_user_id),
    true);
$$;

-- The canonical fact source, verbatim from
-- 20261002010000_kplus_paid_lifetime_entitlement_foundation.sql with exactly
-- ONE added conjunct on a grant's contributes_access:
--   and (g.provider_environment is distinct from 'sandbox'
--     or public.kplus_sandbox_review_permits(g.user_id, p_at))
-- provider_environment is non-null only for store grants (shape constraint), so
-- production, complimentary, operator and legacy facts are untouched.
-- __tests__/kplusSandboxReviewSql.test.js pins that this is the only change.
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
      and (g.provider_environment is distinct from 'sandbox'
        or public.kplus_sandbox_review_permits(g.user_id, p_at))
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

-- ── Missed-webhook recovery claim (Repair C) ────────────────────────────────
-- The ONLY way kplus-revenuecat-pull-reconcile opens a SANDBOX provider claim on
-- a deployment that does not natively accept sandbox. In one transaction it
-- checks the caller-independent authorization (the Edge Function passes the
-- JWT subject; no client field reaches here) and, only if active right now,
-- delegates to the existing claim with p_force => false, so the existing
-- per-(user, environment) lease, cooldown and anonymous/unknown-user refusals
-- apply unchanged. A user with no authorization row is refused without a write.
create or replace function public.claim_kplus_sandbox_review_reconciliation(
  p_user_id          uuid,
  p_cooldown_seconds integer,
  p_lease_seconds    integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_now     timestamptz := now();
  v_account public.kplus_sandbox_review_accounts;
  v_claim   jsonb;
begin
  if p_user_id is null then
    return jsonb_build_object('classification', 'not_authorized');
  end if;
  -- Share-lock the authorization so a concurrent revoke/re-authorize cannot
  -- interleave with this decision; revocation then waits for the claim.
  select * into v_account from public.kplus_sandbox_review_accounts a
   where a.user_id = p_user_id
   for share;
  if not found then
    return jsonb_build_object('classification', 'not_authorized');
  end if;
  if not (v_account.revoked_at is null and v_now >= v_account.starts_at and v_now < v_account.expires_at) then
    insert into public.kplus_sandbox_review_audit (user_id, action, detail)
    values (p_user_id, 'reconcile_refused',
            case when v_account.revoked_at is not null then 'revoked' else 'outside_window' end);
    return jsonb_build_object('classification', 'not_authorized');
  end if;

  v_claim := public.claim_kplus_provider_reconciliation(
    p_user_id, 'sandbox', p_cooldown_seconds, p_lease_seconds, false);
  if v_claim ->> 'classification' = 'claimed' then
    insert into public.kplus_sandbox_review_audit (user_id, action)
    values (p_user_id, 'reconcile_admitted');
  end if;
  return v_claim;
end;
$$;

revoke all on function public.kplus_sandbox_review_permits(uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.claim_kplus_sandbox_review_reconciliation(uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.kplus_sandbox_review_permits(uuid, timestamptz) to service_role;
grant execute on function public.claim_kplus_sandbox_review_reconciliation(uuid, integer, integer) to service_role;
