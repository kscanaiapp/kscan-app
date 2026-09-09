-- F-03 behavioural certification of the repaired state (§21 items 17/18/23/24).
--
-- Schema shape is not the property that matters -- routing behaviour is. These
-- probes exercise register_device_push_token as the worker actually calls it
-- and assert the DEF-WL-01 invariant end to end, plus one control proving the
-- probe can detect the absence of the structural constraint it tests for.
\pset tuples_only on
\pset format unaligned

do $$
declare
  v_a uuid := 'a0000000-0000-4000-8000-000000000001';
  v_b uuid := 'b0000000-0000-4000-8000-000000000002';
  v_live int;
  v_a_live int;
  v_ok boolean;
begin
  -- ── Probe 1 (§21 #24): actor B takes custody of device-1, which is live for
  -- actor A. The hardened RPC must retire A's route on that handset. With the
  -- pre-hardening body this leaves BOTH rows live -- which is the DEF-WL-01
  -- push leak.
  perform public.register_device_push_token(
    v_b, 'ExponentPushToken[f03-actor-b-took-device-1]', 'ios', 'device-1');

  select count(*) into v_live
  from public.user_device_push_tokens
  where device_id = 'device-1' and revoked_at is null;
  if v_live <> 1 then
    raise exception 'PROBE1 FAIL: device-1 carries % live routes after custody change, expected 1', v_live;
  end if;

  select count(*) into v_a_live
  from public.user_device_push_tokens
  where device_id = 'device-1' and user_id = v_a and revoked_at is null;
  if v_a_live <> 0 then
    raise exception 'PROBE1 FAIL: departed actor A still holds a live route on device-1';
  end if;
  raise notice 'PROBE1 PASS: actor custody change retired the departed route (device-1)';

  -- ── Probe 2 (§21 #23): actor B is still live on device-3. Multi-device rows
  -- for one actor must remain DISTINCT and both deliverable.
  perform public.register_device_push_token(
    v_b, 'ExponentPushToken[f03-actor-b-device-4]', 'android', 'device-4');
  select count(*) into v_live
  from public.user_device_push_tokens
  where user_id = v_b and revoked_at is null;
  if v_live < 3 then
    raise exception 'PROBE2 FAIL: actor B holds % live device routes, expected 3 (device-1, device-3, device-4)', v_live;
  end if;
  raise notice 'PROBE2 PASS: multi-device routes for one actor stay distinct (% live)', v_live;

  -- ── Probe 3 (§21 #29): re-registering the SAME (actor, device, token) is a
  -- no-op upsert, not a unique-index violation.
  perform public.register_device_push_token(
    v_b, 'ExponentPushToken[f03-actor-b-device-4]', 'android', 'device-4');
  raise notice 'PROBE3 PASS: idempotent re-registration did not collide with the live-token index';

  -- ── Probe 4 (control): the partial unique index must actually reject a
  -- duplicate live push token written directly. If this DOESN'T raise, the
  -- probes above are proving nothing.
  begin
    insert into public.user_device_push_tokens (user_id, push_token, platform, device_id)
    values (v_a, 'ExponentPushToken[f03-actor-b-device-4]', 'ios', 'device-control');
    v_ok := false;
  exception when unique_violation then
    v_ok := true;
  end;
  if not v_ok then
    raise exception 'PROBE4 FAIL (control): a duplicate live push token was accepted -- the structural constraint is absent';
  end if;
  raise notice 'PROBE4 PASS (control): duplicate live push token rejected 23505';

  raise notice 'BEHAVIOUR=PASS';
end;
$$;
