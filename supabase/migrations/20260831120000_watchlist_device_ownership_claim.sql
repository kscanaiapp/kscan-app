-- Build 34 / K+ Smart Watchlist V1 -- hostile-audit repair SEC-KPLUS-001.
--
-- RESIDUAL DEFECT after DEF-WL-01 (20260830190000).
--
-- That repair retires a stale actor's delivery route, but ONLY as a side effect
-- of somebody REGISTERING: register_device_push_token() retires other live rows
-- sharing the device_id or push_token before it upserts. So the leak closes when
-- the new owner of the handset enables Watch alerts.
--
-- It does not close when they never do. Actor B signs in on Actor A's device and
-- simply never opts into Watch alerts -- the overwhelmingly common case, since
-- alerts are a contextual post-Watch-creation prompt (§51-52), not part of
-- onboarding. Nothing calls register_device_push_token, so A's row stays
-- revoked_at IS NULL, and commerce-watch-refresh keeps selecting it by
-- `user_id = <watch owner> and revoked_at is null`. A's "target price reached"
-- push -- whose body carries A's watched item title and its price -- lands on a
-- handset that is now B's.
--
-- The client-side sign-out revocation does not close it either: it is explicitly
-- best-effort and silent, and it never runs after a force-quit, crash, reinstall,
-- cleared storage, or an expired session.
--
-- REPAIR: server ownership replacement, decoupled from registration.
--
-- claim_device_for_actor(p_user_id, p_device_id) asserts "this physical device
-- currently belongs to this actor" and retires every live registration on that
-- device belonging to anyone else. It registers NOTHING and requires no
-- notification permission, so the client can call it on every actor transition
-- regardless of whether the new actor ever wants alerts.
--
-- Delivery is therefore made undeliverable by the ARRIVAL of a new actor on the
-- device, not by the departure of the old one -- which is the half that was
-- unreliable. Idempotent, and a no-op when the device is already this actor's.
--
-- Returns the number of routes retired so a caller can observe/retry, per the
-- audit's "revocation failures must be observable/retryable" requirement.

create or replace function public.claim_device_for_actor(
  p_user_id uuid,
  p_device_id text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  retired_count integer;
begin
  if p_user_id is null then
    raise exception 'user_id required' using errcode = '23502';
  end if;
  if p_device_id is null or btrim(p_device_id) = '' then
    raise exception 'device_id required' using errcode = '23502';
  end if;

  -- Retire every live route on this device that belongs to a DIFFERENT actor.
  -- Deliberately scoped by device_id only: we are asserting physical custody,
  -- not touching this actor's own registration (which may legitimately be live
  -- on other devices).
  update public.user_device_push_tokens
  set revoked_at = now(), updated_at = now()
  where revoked_at is null
    and device_id = p_device_id
    and user_id <> p_user_id;

  get diagnostics retired_count = row_count;
  return retired_count;
end;
$$;

revoke all on function public.claim_device_for_actor(uuid, text) from public, anon, authenticated;
grant execute on function public.claim_device_for_actor(uuid, text) to service_role;

comment on function public.claim_device_for_actor(uuid, text) is
  'SEC-KPLUS-001. Asserts current custody of a physical device and retires every other actor''s live push route on it. Called on actor transition, independent of whether the arriving actor ever enables notifications -- this is what closes the "new owner never registers" case that register_device_push_token cannot reach.';
