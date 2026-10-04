-- K Scan AI -- Build 35: server-authoritative K+ offer-code redemption.
--
-- SECURITY MODEL
--   * Customer-entered codes never enter this migration in plaintext. The
--     authenticated Edge Function canonicalizes the input and supplies a
--     keyed HMAC-SHA-256 digest produced with a server-only secret.
--   * The Edge Function derives p_actor_id from auth.getUser(); no request body
--     field can select an actor. This RPC is service-role only.
--   * Every eligibility/limit decision and the canonical K+ grant occur inside
--     this transaction while the actor, code and offer are serialized.
--   * Store-native offers are representable, but fail closed until a separately
--     verified Apple/Google/RevenueCat launch path is implemented.
--   * No customer PII beyond the existing Auth actor UUID is stored.

create table public.kplus_offer_definitions (
  id                         uuid primary key default gen_random_uuid(),
  offer_key                  text not null unique,
  is_active                  boolean not null default false,
  starts_at                  timestamptz,
  expires_at                 timestamptz,
  max_global_redemptions     integer,
  max_redemptions_per_actor  integer not null default 1,
  audience                   text not null default 'free_only',
  action_type                text not null,
  kplus_duration_days        integer,
  store_provider             text,
  store_platform             text,
  store_offering_identifier  text,
  store_package_identifier   text,
  operational_metadata       jsonb not null default '{}'::jsonb,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),

  constraint kplus_offer_definitions_key_check
    check (offer_key ~ '^[a-z0-9][a-z0-9_.:-]{0,63}$'),
  constraint kplus_offer_definitions_window_check
    check (expires_at is null or starts_at is null or expires_at > starts_at),
  constraint kplus_offer_definitions_global_limit_check
    check (max_global_redemptions is null or max_global_redemptions > 0),
  constraint kplus_offer_definitions_actor_limit_check
    check (max_redemptions_per_actor between 1 and 100),
  constraint kplus_offer_definitions_audience_check
    check (audience in ('any_authenticated', 'free_only', 'active_kplus_only')),
  constraint kplus_offer_definitions_action_check
    check (action_type in ('kplus_entitlement', 'store_native')),
  constraint kplus_offer_definitions_metadata_check
    check (jsonb_typeof(operational_metadata) = 'object'),
  constraint kplus_offer_definitions_action_shape_check
    check (
      (
        action_type = 'kplus_entitlement'
        and kplus_duration_days between 1 and 3650
        and store_provider is null
        and store_platform is null
        and store_offering_identifier is null
        and store_package_identifier is null
      )
      or
      (
        action_type = 'store_native'
        and kplus_duration_days is null
        and store_provider = 'revenuecat'
        and store_platform in ('apple', 'google', 'both')
        and nullif(btrim(store_offering_identifier), '') is not null
        and nullif(btrim(store_package_identifier), '') is not null
      )
    )
);

comment on table public.kplus_offer_definitions is
  'Server-owned offer policy. Contains no plaintext redemption code and no customer PII.';
comment on column public.kplus_offer_definitions.operational_metadata is
  'Non-authoritative campaign operations metadata only. Eligibility and grants are represented by typed columns and never inferred from this JSON.';

create table public.kplus_offer_codes (
  id                      uuid primary key default gen_random_uuid(),
  offer_id                uuid not null references public.kplus_offer_definitions(id) on delete restrict,
  code_digest             text not null unique,
  is_active               boolean not null default true,
  max_redemptions         integer not null default 1,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  constraint kplus_offer_codes_digest_check
    check (code_digest ~ '^[0-9a-f]{64}$'),
  constraint kplus_offer_codes_limit_check
    check (max_redemptions between 1 and 1000000)
);

comment on table public.kplus_offer_codes is
  'Redeemable code authority. code_digest is a keyed HMAC-SHA-256; raw customer codes are never stored.';

create table public.kplus_offer_redemption_attempts (
  id                 uuid primary key default gen_random_uuid(),
  actor_id           uuid not null references auth.users(id) on delete cascade,
  offer_id           uuid references public.kplus_offer_definitions(id) on delete restrict,
  offer_code_id      uuid references public.kplus_offer_codes(id) on delete restrict,
  code_digest        text not null,
  customer_result    text not null,
  internal_reason    text not null,
  attempted_at       timestamptz not null default now(),

  constraint kplus_offer_attempts_digest_check
    check (code_digest ~ '^[0-9a-f]{64}$'),
  constraint kplus_offer_attempts_customer_result_check
    check (customer_result in (
      'SUCCESS', 'INVALID', 'EXPIRED', 'ALREADY_USED',
      'NOT_ELIGIBLE', 'UNAVAILABLE', 'ERROR'
    )),
  constraint kplus_offer_attempts_internal_reason_check
    check (internal_reason ~ '^[a-z][a-z0-9_]{1,62}$')
);

create index kplus_offer_attempts_actor_time_idx
  on public.kplus_offer_redemption_attempts (actor_id, attempted_at desc);

comment on table public.kplus_offer_redemption_attempts is
  'Actor-scoped abuse/audit trail. Stores only a keyed digest and bounded reasons; never the raw offer code.';

create table public.kplus_offer_redemptions (
  id                         uuid primary key default gen_random_uuid(),
  actor_id                   uuid not null references auth.users(id) on delete cascade,
  offer_id                   uuid not null references public.kplus_offer_definitions(id) on delete restrict,
  offer_code_id              uuid not null references public.kplus_offer_codes(id) on delete restrict,
  canonical_grant_id         uuid references public.kplus_entitlement_grants(id) on delete set null,
  result                     text not null default 'SUCCESS',
  idempotency_key            uuid not null default gen_random_uuid() unique,
  consumed_code_limit        boolean not null default true,
  consumed_offer_limit       boolean not null default true,
  consumed_actor_limit       boolean not null default true,
  redeemed_at                timestamptz not null default now(),

  constraint kplus_offer_redemptions_actor_code_key unique (actor_id, offer_code_id),
  constraint kplus_offer_redemptions_result_check check (result = 'SUCCESS')
);

create index kplus_offer_redemptions_offer_idx
  on public.kplus_offer_redemptions (offer_id, redeemed_at);
create index kplus_offer_redemptions_actor_offer_idx
  on public.kplus_offer_redemptions (actor_id, offer_id, redeemed_at);
create index kplus_offer_redemptions_code_idx
  on public.kplus_offer_redemptions (offer_code_id, redeemed_at);

comment on table public.kplus_offer_redemptions is
  'Durable successful-redemption ledger. The actor+code uniqueness constraint is the idempotency boundary; consumed_* fields prove which limits were spent.';

alter table public.kplus_offer_definitions enable row level security;
alter table public.kplus_offer_codes enable row level security;
alter table public.kplus_offer_redemption_attempts enable row level security;
alter table public.kplus_offer_redemptions enable row level security;

revoke all on table public.kplus_offer_definitions from public, anon, authenticated;
revoke all on table public.kplus_offer_codes from public, anon, authenticated;
revoke all on table public.kplus_offer_redemption_attempts from public, anon, authenticated;
revoke all on table public.kplus_offer_redemptions from public, anon, authenticated;
grant select, insert, update, delete on table public.kplus_offer_definitions to service_role;
grant select, insert, update, delete on table public.kplus_offer_codes to service_role;
grant select, insert, update, delete on table public.kplus_offer_redemption_attempts to service_role;
grant select, insert, update, delete on table public.kplus_offer_redemptions to service_role;

create or replace function public.touch_kplus_offer_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger kplus_offer_definitions_updated_at
before update on public.kplus_offer_definitions
for each row execute function public.touch_kplus_offer_updated_at();

create trigger kplus_offer_codes_updated_at
before update on public.kplus_offer_codes
for each row execute function public.touch_kplus_offer_updated_at();

revoke all on function public.touch_kplus_offer_updated_at() from public, anon, authenticated;
grant execute on function public.touch_kplus_offer_updated_at() to service_role;

create or replace function public.redeem_kplus_offer_code(
  p_actor_id    uuid,
  p_code_digest text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  c_minute_limit constant integer := 5;
  c_hour_limit   constant integer := 20;
  v_now          timestamptz := now();
  v_code         public.kplus_offer_codes;
  v_offer        public.kplus_offer_definitions;
  v_existing     public.kplus_offer_redemptions;
  v_grant_result jsonb;
  v_grant_id     uuid;
  v_is_anonymous boolean;
  v_account_status text;
  v_account_locked_at timestamptz;
  v_has_kplus    boolean;
  v_count        bigint;
begin
  if p_actor_id is null or p_code_digest is null
     or p_code_digest !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('result', 'ERROR');
  end if;

  -- Actor serialization makes the rate bound and per-actor offer limit atomic.
  perform pg_advisory_xact_lock(hashtextextended('kplus_offer_actor:' || p_actor_id::text, 0));

  select u.is_anonymous
    into v_is_anonymous
    from auth.users u
   where u.id = p_actor_id;
  if not found or coalesce(v_is_anonymous, false) then
    return jsonb_build_object('result', 'NOT_ELIGIBLE');
  end if;

  select p.account_status, p.account_locked_at
    into v_account_status, v_account_locked_at
    from public.profiles p
   where p.id = p_actor_id;
  if not found or v_account_status is distinct from 'active' or v_account_locked_at is not null then
    return jsonb_build_object('result', 'NOT_ELIGIBLE');
  end if;

  -- Row-locking the code serializes single-use/shared-code consumption.
  select * into v_code
    from public.kplus_offer_codes c
   where c.code_digest = p_code_digest
   for update;

  if found then
    select * into v_offer
      from public.kplus_offer_definitions o
     where o.id = v_code.offer_id
     for update;

    select * into v_existing
      from public.kplus_offer_redemptions r
     where r.actor_id = p_actor_id
       and r.offer_code_id = v_code.id;
    if found then
      insert into public.kplus_offer_redemption_attempts (
        actor_id, offer_id, offer_code_id, code_digest, customer_result, internal_reason
      ) values (
        p_actor_id, v_offer.id, v_code.id, p_code_digest, 'SUCCESS', 'idempotent_replay'
      );
      return jsonb_build_object(
        'result', 'SUCCESS',
        'entitlementRefreshRequired', v_offer.action_type = 'kplus_entitlement'
      );
    end if;
  end if;

  select count(*) into v_count
    from public.kplus_offer_redemption_attempts a
   where a.actor_id = p_actor_id
     and a.attempted_at >= v_now - interval '1 minute';
  if v_count >= c_minute_limit then
    insert into public.kplus_offer_redemption_attempts (
      actor_id, offer_id, offer_code_id, code_digest, customer_result, internal_reason
    ) values (
      p_actor_id, case when v_code.id is null then null else v_offer.id end,
      v_code.id, p_code_digest, 'UNAVAILABLE', 'actor_minute_rate_limit'
    );
    return jsonb_build_object('result', 'UNAVAILABLE');
  end if;

  select count(*) into v_count
    from public.kplus_offer_redemption_attempts a
   where a.actor_id = p_actor_id
     and a.attempted_at >= v_now - interval '1 hour';
  if v_count >= c_hour_limit then
    insert into public.kplus_offer_redemption_attempts (
      actor_id, offer_id, offer_code_id, code_digest, customer_result, internal_reason
    ) values (
      p_actor_id, case when v_code.id is null then null else v_offer.id end,
      v_code.id, p_code_digest, 'UNAVAILABLE', 'actor_hour_rate_limit'
    );
    return jsonb_build_object('result', 'UNAVAILABLE');
  end if;

  if v_code.id is null then
    insert into public.kplus_offer_redemption_attempts (
      actor_id, code_digest, customer_result, internal_reason
    ) values (p_actor_id, p_code_digest, 'INVALID', 'unknown_code');
    return jsonb_build_object('result', 'INVALID');
  end if;

  if not v_code.is_active or not v_offer.is_active then
    insert into public.kplus_offer_redemption_attempts (
      actor_id, offer_id, offer_code_id, code_digest, customer_result, internal_reason
    ) values (p_actor_id, v_offer.id, v_code.id, p_code_digest, 'INVALID', 'inactive_offer');
    return jsonb_build_object('result', 'INVALID');
  end if;

  if v_offer.starts_at is not null and v_now < v_offer.starts_at then
    insert into public.kplus_offer_redemption_attempts (
      actor_id, offer_id, offer_code_id, code_digest, customer_result, internal_reason
    ) values (p_actor_id, v_offer.id, v_code.id, p_code_digest, 'NOT_ELIGIBLE', 'offer_not_started');
    return jsonb_build_object('result', 'NOT_ELIGIBLE');
  end if;

  if v_offer.expires_at is not null and v_now >= v_offer.expires_at then
    insert into public.kplus_offer_redemption_attempts (
      actor_id, offer_id, offer_code_id, code_digest, customer_result, internal_reason
    ) values (p_actor_id, v_offer.id, v_code.id, p_code_digest, 'EXPIRED', 'offer_expired');
    return jsonb_build_object('result', 'EXPIRED');
  end if;

  select public.kplus_has_active_entitlement(p_actor_id, 'k_plus') into v_has_kplus;
  if (v_offer.audience = 'free_only' and v_has_kplus)
     or (v_offer.audience = 'active_kplus_only' and not v_has_kplus) then
    insert into public.kplus_offer_redemption_attempts (
      actor_id, offer_id, offer_code_id, code_digest, customer_result, internal_reason
    ) values (p_actor_id, v_offer.id, v_code.id, p_code_digest, 'NOT_ELIGIBLE', 'audience_mismatch');
    return jsonb_build_object('result', 'NOT_ELIGIBLE');
  end if;

  select count(*) into v_count
    from public.kplus_offer_redemptions r
   where r.offer_code_id = v_code.id
     and r.consumed_code_limit;
  if v_count >= v_code.max_redemptions then
    insert into public.kplus_offer_redemption_attempts (
      actor_id, offer_id, offer_code_id, code_digest, customer_result, internal_reason
    ) values (p_actor_id, v_offer.id, v_code.id, p_code_digest, 'ALREADY_USED', 'code_limit_reached');
    return jsonb_build_object('result', 'ALREADY_USED');
  end if;

  if v_offer.max_global_redemptions is not null then
    select count(*) into v_count
      from public.kplus_offer_redemptions r
     where r.offer_id = v_offer.id
       and r.consumed_offer_limit;
    if v_count >= v_offer.max_global_redemptions then
      insert into public.kplus_offer_redemption_attempts (
        actor_id, offer_id, offer_code_id, code_digest, customer_result, internal_reason
      ) values (p_actor_id, v_offer.id, v_code.id, p_code_digest, 'ALREADY_USED', 'offer_limit_reached');
      return jsonb_build_object('result', 'ALREADY_USED');
    end if;
  end if;

  select count(*) into v_count
    from public.kplus_offer_redemptions r
   where r.actor_id = p_actor_id
     and r.offer_id = v_offer.id
     and r.consumed_actor_limit;
  if v_count >= v_offer.max_redemptions_per_actor then
    insert into public.kplus_offer_redemption_attempts (
      actor_id, offer_id, offer_code_id, code_digest, customer_result, internal_reason
    ) values (p_actor_id, v_offer.id, v_code.id, p_code_digest, 'ALREADY_USED', 'actor_offer_limit_reached');
    return jsonb_build_object('result', 'ALREADY_USED');
  end if;

  if v_offer.action_type = 'store_native' then
    insert into public.kplus_offer_redemption_attempts (
      actor_id, offer_id, offer_code_id, code_digest, customer_result, internal_reason
    ) values (p_actor_id, v_offer.id, v_code.id, p_code_digest, 'UNAVAILABLE', 'store_path_unconfigured');
    return jsonb_build_object('result', 'UNAVAILABLE');
  end if;

  begin
    select public.grant_kplus_complimentary(
      p_user_id => p_actor_id,
      p_source => 'complimentary_code',
      p_grant_key => 'offer_code:' || v_code.id::text,
      p_campaign_id => v_offer.offer_key,
      p_starts_at => v_now,
      p_expires_at => v_now + make_interval(days => v_offer.kplus_duration_days),
      p_entitlement_key => 'k_plus'
    ) into v_grant_result;
  exception when others then
    insert into public.kplus_offer_redemption_attempts (
      actor_id, offer_id, offer_code_id, code_digest, customer_result, internal_reason
    ) values (p_actor_id, v_offer.id, v_code.id, p_code_digest, 'ERROR', 'canonical_grant_failed');
    return jsonb_build_object('result', 'ERROR');
  end;

  if coalesce(v_grant_result->>'outcome', '') not in ('granted', 'already_granted') then
    insert into public.kplus_offer_redemption_attempts (
      actor_id, offer_id, offer_code_id, code_digest, customer_result, internal_reason
    ) values (p_actor_id, v_offer.id, v_code.id, p_code_digest, 'NOT_ELIGIBLE', 'canonical_grant_rejected');
    return jsonb_build_object('result', 'NOT_ELIGIBLE');
  end if;

  begin
    v_grant_id := nullif(v_grant_result->>'grantId', '')::uuid;
  exception when invalid_text_representation then
    v_grant_id := null;
  end;

  insert into public.kplus_offer_redemptions (
    actor_id, offer_id, offer_code_id, canonical_grant_id
  ) values (
    p_actor_id, v_offer.id, v_code.id, v_grant_id
  );

  insert into public.kplus_offer_redemption_attempts (
    actor_id, offer_id, offer_code_id, code_digest, customer_result, internal_reason
  ) values (p_actor_id, v_offer.id, v_code.id, p_code_digest, 'SUCCESS', 'canonical_grant_committed');

  return jsonb_build_object('result', 'SUCCESS', 'entitlementRefreshRequired', true);
end;
$$;

comment on function public.redeem_kplus_offer_code(uuid, text) is
  'Service-only atomic redemption boundary. p_actor_id must come from verified server auth; p_code_digest must be a server-keyed HMAC. Never accepts plaintext codes.';

revoke all on function public.redeem_kplus_offer_code(uuid, text) from public, anon, authenticated;
grant execute on function public.redeem_kplus_offer_code(uuid, text) to service_role;

-- Fail migration if a client role can reach any new authority object.
do $$
begin
  if has_table_privilege('anon', 'public.kplus_offer_definitions', 'select')
     or has_table_privilege('authenticated', 'public.kplus_offer_definitions', 'select')
     or has_table_privilege('anon', 'public.kplus_offer_codes', 'select')
     or has_table_privilege('authenticated', 'public.kplus_offer_codes', 'select')
     or has_table_privilege('anon', 'public.kplus_offer_redemption_attempts', 'select')
     or has_table_privilege('authenticated', 'public.kplus_offer_redemption_attempts', 'select')
     or has_table_privilege('anon', 'public.kplus_offer_redemptions', 'select')
     or has_table_privilege('authenticated', 'public.kplus_offer_redemptions', 'select') then
    raise exception 'offer-code authority leaked table access to a client role';
  end if;

  if has_function_privilege('anon', 'public.redeem_kplus_offer_code(uuid,text)', 'execute')
     or has_function_privilege('authenticated', 'public.redeem_kplus_offer_code(uuid,text)', 'execute') then
    raise exception 'offer-code redemption RPC leaked to a client role';
  end if;
end;
$$;
