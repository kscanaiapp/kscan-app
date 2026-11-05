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
--
-- INERT on deploy: the webhook consults _admit_event only when
-- KPLUS_REVENUECAT_SANDBOX_REVIEW_ENABLED is 'true' AND the deployment does not
-- already accept sandbox events; and admission requires an authorization row
-- that only an operator can create. The access resolver is unchanged.

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
    check (action in ('authorized', 'revoked', 'event_admitted', 'event_refused')),
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
  v_access_before  boolean;
  v_expires_before timestamptz;
  v_access_after   boolean;
  v_expires_after  timestamptz;
  v_revoked_grants integer := 0;
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

  update public.kplus_sandbox_review_accounts
     set revoked_at = coalesce(revoked_at, v_now),
         revoked_reason = coalesce(revoked_reason, v_reason),
         updated_at = v_now
   where user_id = p_user_id;

  for v_grant in
    select * from public.kplus_entitlement_grants g
     where g.user_id = p_user_id
       and g.source in ('store_subscription', 'store_lifetime')
       and g.provider_environment = 'sandbox'
       and g.revoked_at is null
     for update
  loop
    select s.has_access, s.effective_expires_at into v_access_before, v_expires_before
      from public.kplus_effective_access_state(p_user_id, v_grant.entitlement_key, v_now) s;

    update public.kplus_entitlement_grants
       set revoked_at = v_now,
           revocation_reason = 'sandbox_review_revoked',
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
    );
    v_revoked_grants := v_revoked_grants + 1;
  end loop;

  insert into public.kplus_sandbox_review_audit (user_id, action, detail)
  values (p_user_id, 'revoked', v_reason);

  return jsonb_build_object('outcome', 'revoked', 'revokedSandboxGrants', v_revoked_grants);
end;
$$;

-- ── Sweep expired authorizations (operator / scheduled, service_role) ───────
create or replace function public.kplus_sandbox_review_sweep()
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_user  uuid;
  v_count integer := 0;
begin
  for v_user in
    select a.user_id from public.kplus_sandbox_review_accounts a
     where a.expires_at <= now()
       and (a.revoked_at is null
         or exists (select 1 from public.kplus_entitlement_grants g
                     where g.user_id = a.user_id
                       and g.source in ('store_subscription', 'store_lifetime')
                       and g.provider_environment = 'sandbox'
                       and g.revoked_at is null))
  loop
    perform public.kplus_sandbox_review_revoke(v_user, 'expired');
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
