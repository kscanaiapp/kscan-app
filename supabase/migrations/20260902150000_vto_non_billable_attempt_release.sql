-- Build 34 / VTO deep audit -- repair VTO-QUOTA-003.
--
-- DEFECT. reserve_vto_generation is called BEFORE the provider, which is
-- correct and load-bearing: it is what makes a double tap collapse to one paid
-- job. But every outcome afterwards settled through complete_vto_generation,
-- which never gives the attempt back. So `attempts` -- and therefore the user's
-- daily cap -- was charged for failures where K Scan provably never bought
-- anything and the user did nothing wrong:
--
--   * RapidAPI 401/403  (the account is not subscribed to the listing -- which
--                        is the CURRENT live state of the AILabTools account,
--                        see docs/vto-provider-benchmark.md)
--   * RapidAPI 429      (gateway rate limit, no generation created)
--   * upstream 5xx      (no generation created)
--   * submit never sent (garment fetch failed / TLS / DNS / network throw)
--   * slot refused by the adapter before any network call
--
-- On staging today (app_config.vto_generation = enabled:true,
-- provider:'ailabtools_tryon_clothes_pro', account not subscribed) the
-- user-visible consequence is: ten "Try-on is unavailable right now" failures,
-- then "You've reached the try-on limit for now" -- a limit the person never
-- reached, for generations that never happened.
--
-- WHAT IS DELIBERATELY *NOT* REFUNDED. Everything from a successful submit
-- onwards: poll-budget timeout, generation_failed, invalid_output, moderation,
-- and an input the vendor itself rejected. The vendor accepted or ran the job,
-- so the money is spent whether or not K Scan liked the answer -- and refunding
-- those would restore exactly the unbounded-retry surface VTO-QUOTA-001 closed.
-- The adapter reports which side of that line it is on (`billable: false` on
-- VtoProviderOutcome); anything that does not say is treated as billable.
--
-- SHAPE. Mirrors the existing pair rather than inventing a third convention:
-- SECURITY DEFINER, service_role only, no direct client access, and it is the
-- only way an attempt is ever given back.

create or replace function public.release_vto_generation(
  p_user_id         uuid,
  p_idempotency_key text,
  p_provider        text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key      text := btrim(coalesce(p_idempotency_key, ''));
  v_existing public.vto_generation_requests;
begin
  if p_user_id is null or char_length(v_key) < 16 then
    return false;
  end if;

  -- Same actor-scoped lock reserve_vto_generation takes, so a release can
  -- never interleave with a concurrent reservation's quota read.
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  select * into v_existing
    from public.vto_generation_requests
   where user_id = p_user_id and idempotency_key = v_key;

  if not found then
    return false;
  end if;

  -- A settled generation is never un-settled: only the in_flight attempt this
  -- call is settling may be released. Anything else is a late or duplicated
  -- release and must not hand back an attempt that was genuinely spent.
  if v_existing.status <> 'in_flight' then
    return false;
  end if;

  if v_existing.attempts <= 1 then
    -- The only attempt on this key today was non-billable, so the key leaves
    -- no trace on the cap. Removing the row (rather than setting attempts to
    -- 0, which the attempts >= 1 check forbids) also leaves the key
    -- immediately re-reservable, which is the correct outcome: the user should
    -- be able to try again once the provider is back.
    delete from public.vto_generation_requests
     where user_id = p_user_id and idempotency_key = v_key;
    return true;
  end if;

  update public.vto_generation_requests
     set attempts = v_existing.attempts - 1,
         status = 'failed',
         provider = coalesce(p_provider, provider),
         completed_at = now(),
         updated_at = now()
   where user_id = p_user_id and idempotency_key = v_key;

  return true;
end;
$$;

revoke all on function public.release_vto_generation(uuid, text, text) from public, anon, authenticated;
grant execute on function public.release_vto_generation(uuid, text, text) to service_role;

comment on function public.release_vto_generation(uuid, text, text) is
  'VTO-QUOTA-003. Gives back exactly one PROVABLY NON-BILLABLE VTO attempt (provider 401/403/429/5xx, or a failure before submit). Only an in_flight row is releasable, so a late or repeated release cannot refund a spent attempt. Everything from a successful submit onwards stays counted.';
