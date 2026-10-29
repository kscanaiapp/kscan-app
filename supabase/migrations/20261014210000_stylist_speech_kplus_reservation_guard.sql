-- Forward-only Speech reservation hardening for approved K+ release.
-- Preserve prior tables, spent budget, actor attempts, advisory lock, limits,
-- role privileges and kill-switch defaults. This does NOT enable paid work.
-- The stored procedure's service-only access is preserved on replacement.
create or replace function public.reserve_speech_request(p_user_id uuid, p_fingerprint text, p_characters integer)
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
  -- Critical provider authorization: checked inside the SAME serialized
  -- reservation transaction as the fleet budget, so a revocation between
  -- the Edge Function's JWT check and reservation cannot reach ElevenLabs.
  -- This call is service-role-only and uses an explicit actor from getUser().
  if not public.kplus_has_active_entitlement(p_user_id, 'k_plus') then
    return jsonb_build_object('allowed', false, 'reason', 'entitlement_required');
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
