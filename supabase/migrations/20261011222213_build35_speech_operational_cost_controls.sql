-- Additive Speech-only controls. No existing quota RPC, client policy, auth
-- setting or entitlement grant is changed. Default allocation is ZERO.
create table public.speech_provider_control (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false,
  daily_character_limit integer not null default 0 check (daily_character_limit between 0 and 200000),
  actor_daily_limit integer not null default 50 check (actor_daily_limit between 1 and 50),
  actor_minute_limit integer not null default 10 check (actor_minute_limit between 1 and 10)
);
insert into public.speech_provider_control (singleton) values (true);
alter table public.speech_provider_control enable row level security;
revoke all on public.speech_provider_control from public, anon, authenticated;
grant select, update on public.speech_provider_control to service_role;

create table public.speech_request_reservations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  fingerprint text not null check (fingerprint ~ '^[a-f0-9]{64}$'),
  characters integer not null check (characters between 1 and 1000),
  reserved_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '45 seconds'),
  status text not null default 'reserved' check (status in ('reserved', 'completed', 'failed'))
);
create index speech_reservations_time on public.speech_request_reservations (reserved_at);
create index speech_reservations_actor on public.speech_request_reservations (user_id, reserved_at);
alter table public.speech_request_reservations enable row level security;
revoke all on public.speech_request_reservations from public, anon, authenticated;
grant select on public.speech_request_reservations to service_role;

-- An actor-free daily total preserves the paid ceiling when privacy deletion
-- cascades personal reservations. Deleting an account never refunds paid work.
create table public.speech_daily_cost (
  day date primary key,
  characters_consumed bigint not null default 0 check (characters_consumed >= 0)
);
alter table public.speech_daily_cost enable row level security;
revoke all on public.speech_daily_cost from public, anon, authenticated;
grant select on public.speech_daily_cost to service_role;

create function public.reserve_speech_request(p_user_id uuid, p_fingerprint text, p_characters integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_control public.speech_provider_control%rowtype;
  v_id uuid;
  v_now timestamptz;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service role required' using errcode = '42501';
  end if;
  if p_user_id is null or p_fingerprint is null or p_fingerprint !~ '^[a-f0-9]{64}$'
     or p_characters is null or p_characters not between 1 and 1000 then
    raise exception 'Invalid speech reservation' using errcode = '22023';
  end if;
  -- One transaction lock protects BOTH the fleet-wide cost ceiling and actor
  -- limits. Distinct fingerprints and users cannot race the sum/count checks.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('kscan:speech-provider-budget', 0));
  v_now := pg_catalog.clock_timestamp();
  select * into v_control from public.speech_provider_control where singleton for share;
  if not found or not v_control.enabled or v_control.daily_character_limit = 0 then
    return jsonb_build_object('allowed', false, 'reason', 'disabled');
  end if;
  if not exists (select 1 from public.profiles where id = p_user_id and account_status = 'active') then
    return jsonb_build_object('allowed', false, 'reason', 'account_unavailable');
  end if;
  if exists (select 1 from public.speech_request_reservations
    where user_id = p_user_id and status = 'reserved' and expires_at > v_now) then
    return jsonb_build_object('allowed', false, 'reason', 'concurrent_request');
  end if;
  if (select count(*) from public.speech_request_reservations where user_id = p_user_id
    and reserved_at > v_now - interval '1 minute') >= v_control.actor_minute_limit then
    return jsonb_build_object('allowed', false, 'reason', 'minute_limit');
  end if;
  if (select count(*) from public.speech_request_reservations where user_id = p_user_id
    and reserved_at >= date_trunc('day', v_now, 'UTC')) >= v_control.actor_daily_limit then
    return jsonb_build_object('allowed', false, 'reason', 'daily_limit');
  end if;
  -- Every attempted call counts, including ambiguous provider failures and
  -- expired leases: releasing a call never refunds potentially billed work.
  if coalesce((select characters_consumed from public.speech_daily_cost
    where day = (v_now at time zone 'UTC')::date), 0) + p_characters > v_control.daily_character_limit then
    return jsonb_build_object('allowed', false, 'reason', 'character_budget');
  end if;
  insert into public.speech_request_reservations (user_id, fingerprint, characters, reserved_at, expires_at)
    values (p_user_id, p_fingerprint, p_characters, v_now, v_now + interval '45 seconds') returning id into v_id;
  insert into public.speech_daily_cost (day, characters_consumed)
    values ((v_now at time zone 'UTC')::date, p_characters)
    on conflict (day) do update set characters_consumed = public.speech_daily_cost.characters_consumed + excluded.characters_consumed;
  return jsonb_build_object('allowed', true, 'reservationId', v_id);
end;
$$;

create function public.finish_speech_request(p_user_id uuid, p_reservation_id uuid, p_succeeded boolean)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service role required' using errcode = '42501';
  end if;
  update public.speech_request_reservations set status = case when p_succeeded then 'completed' else 'failed' end
    where id = p_reservation_id and user_id = p_user_id and status = 'reserved';
  return found;
end;
$$;
revoke all on function public.reserve_speech_request(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.finish_speech_request(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.reserve_speech_request(uuid, text, integer) to service_role;
grant execute on function public.finish_speech_request(uuid, uuid, boolean) to service_role;
