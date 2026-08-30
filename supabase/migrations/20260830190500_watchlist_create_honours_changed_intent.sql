-- Build 34 / K+ Smart Watchlist V1 -- hostile-audit repair DEF-WL-02.
--
-- DEFECT (proven live on staging, audit test W-03): create_user_commerce_watch
-- is idempotent on (user_id, canonical_url), and its early return handed back
-- the EXISTING row while silently discarding the intent and target price the
-- caller just supplied.
--
-- Customer-visible failure, reachable with entirely ordinary use: ProductShelf
-- renders the same "Watch" action on a listing that is already being watched
-- (there is no already-watching state), so "watch it casually now, set a Buy
-- under price later" is the natural path. Taking it produced:
--   * the modal reporting "You're watching this listing." (create returned ok),
--   * the contextual "Alert me?" prompt firing, an OS notification permission
--     request, a device token registration and push_enabled = true,
--   * a row still stored as watch_intent = 'just_watching' with
--     target_price_amount = NULL.
-- The alert can then never fire: the change engine only raises
-- target_price_reached for buy_under, and claim_watchable_commerce_watches
-- only claims buy_under rows for background refresh. The user was told an
-- alert was armed; nothing was.
--
-- REPAIR: the idempotent path now applies the intent the caller actually
-- asked for, rather than ignoring it. Identity (user, url, source, created_at,
-- observed price history) is untouched -- this is still the same Watch, not a
-- second one, and re-watching still never duplicates a row.
--
-- target_reached_at is recomputed the same way create does it, so the "target
-- already met" contract holds on this path too: a target that is already
-- satisfied by the latest observed price is stamped at the moment it is set,
-- with no watch_event row, so "already met" is never presented to the user as
-- a historical price drop. A target that is newly unmet clears the stamp so a
-- genuine future crossing can still fire exactly once.

create or replace function public.create_user_commerce_watch(
  p_user_id uuid,
  p_source text,
  p_canonical_url text,
  p_provider_listing_id text,
  p_display_title text,
  p_display_image_url text,
  p_initial_price_amount numeric,
  p_currency text,
  p_watch_intent text,
  p_target_price_amount numeric
)
returns public.user_commerce_watches
language plpgsql
security definer
set search_path = public
as $$
declare
  watch_row public.user_commerce_watches;
  existing public.user_commerce_watches;
  reached timestamptz;
  next_target numeric;
begin
  if p_user_id is null then
    raise exception 'user_id required' using errcode = '23502';
  end if;
  -- K+ required to create (§26). Not re-checked on every later view/pause/
  -- delete -- only here, and again in resume_user_commerce_watch.
  if not public.kplus_has_active_entitlement(p_user_id, 'k_plus') then
    raise exception 'K+ required' using errcode = '42501';
  end if;

  select * into existing
  from public.user_commerce_watches
  where user_id = p_user_id and canonical_url = p_canonical_url and deleted_at is null;

  if existing.id is not null then
    -- Same Watch, possibly a new intent (DEF-WL-02). A double-tap or client
    -- retry with identical arguments still lands here and still returns the
    -- same row unchanged in substance.
    next_target := case when p_watch_intent = 'buy_under' then p_target_price_amount else null end;

    if p_watch_intent = existing.watch_intent
       and next_target is not distinct from existing.target_price_amount then
      return existing;
    end if;

    -- A changed target is a fresh threshold: re-evaluate it against the most
    -- recently observed price for this listing, never against the price the
    -- caller happened to send.
    reached := case
      when p_watch_intent = 'buy_under'
        and next_target is not null
        and existing.current_price_amount is not null
        and existing.current_price_amount <= next_target
      then now()
      else null
    end;

    update public.user_commerce_watches
    set watch_intent = p_watch_intent,
        target_price_amount = next_target,
        target_reached_at = reached
    where id = existing.id
    returning * into watch_row;

    return watch_row;
  end if;

  reached := case
    when p_watch_intent = 'buy_under'
      and p_target_price_amount is not null
      and p_initial_price_amount is not null
      and p_initial_price_amount <= p_target_price_amount
    then now()
    else null
  end;

  insert into public.user_commerce_watches (
    user_id, source, canonical_url, provider_listing_id, display_title, display_image_url,
    initial_price_amount, current_price_amount, currency, watch_intent, target_price_amount,
    target_reached_at, status, last_status
  ) values (
    p_user_id, p_source, p_canonical_url, p_provider_listing_id, p_display_title, p_display_image_url,
    p_initial_price_amount, p_initial_price_amount, p_currency, p_watch_intent, p_target_price_amount,
    reached, 'active', 'unchecked'
  )
  returning * into watch_row;

  return watch_row;
end;
$$;

revoke all on function public.create_user_commerce_watch(uuid, text, text, text, text, text, numeric, text, text, numeric) from public, anon, authenticated;
grant execute on function public.create_user_commerce_watch(uuid, text, text, text, text, text, numeric, text, text, numeric) to service_role;
