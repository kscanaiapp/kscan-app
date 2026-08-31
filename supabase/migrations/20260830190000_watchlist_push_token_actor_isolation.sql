-- Build 34 / K+ Smart Watchlist V1 -- hostile-audit repair DEF-WL-01.
--
-- DEFECT (proven live on staging, audit test W-18): user_device_push_tokens
-- deduped only on (user_id, device_id), so two DIFFERENT actors who signed in
-- on the SAME device produced two live rows carrying the SAME Expo push
-- token. commerce-watch-refresh selects a delivery token by
-- `user_id = <watch owner> and revoked_at is null`, so actor A's
-- "target price reached" push -- which carries A's watched item title and its
-- price in the notification body -- was delivered to a handset now signed in
-- as actor B. RLS was never involved: the leak is the notification text
-- itself, not the deep-link target, so the build's original reasoning ("the
-- watch loads through the viewer's own RLS-scoped read") does not close it.
--
-- REPAIR, in two parts:
--   1. register_device_push_token() now retires every OTHER live row that
--      shares this device_id or this push_token before it upserts. A device
--      changing hands therefore takes its previous owner's delivery route
--      with it, whether or not that owner's sign-out ever ran.
--   2. A partial unique index makes the bad state unrepresentable rather than
--      merely unreached: at most one live (non-revoked) row may exist for any
--      one push token. The revoke above runs first, so the legitimate
--      re-registration path never collides with it.
--
-- The client also revokes this device's token on sign-out (see
-- services/watchlist/pushRegistration.ts + contexts/AuthSessionContext.tsx);
-- this migration is the server-side half that holds even when that never runs
-- (force-quit, crash, reinstall, cleared storage).

create or replace function public.register_device_push_token(
  p_user_id uuid,
  p_push_token text,
  p_platform text,
  p_device_id text
)
returns public.user_device_push_tokens
language plpgsql
security definer
set search_path = public
as $$
declare
  row_out public.user_device_push_tokens;
begin
  if p_user_id is null then
    raise exception 'user_id required' using errcode = '23502';
  end if;

  -- Actor isolation (DEF-WL-01). Retire any live registration that shares
  -- this physical device or this delivery token but is not this exact
  -- (user, device) pair. Runs BEFORE the upsert so the partial unique index
  -- below can never be violated by a legitimate re-registration.
  update public.user_device_push_tokens
  set revoked_at = now(), updated_at = now()
  where revoked_at is null
    and (device_id = p_device_id or push_token = p_push_token)
    and not (user_id = p_user_id and device_id = p_device_id);

  insert into public.user_device_push_tokens (user_id, push_token, platform, device_id, last_used_at)
  values (p_user_id, p_push_token, p_platform, p_device_id, now())
  on conflict (user_id, device_id) do update
    set push_token = excluded.push_token,
        platform = excluded.platform,
        revoked_at = null,
        last_used_at = now(),
        updated_at = now()
  returning * into row_out;

  return row_out;
end;
$$;

revoke all on function public.register_device_push_token(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.register_device_push_token(uuid, text, text, text) to service_role;

-- Structural guarantee: one live delivery route per push token, ever.
-- Any pre-existing duplicates are retired first so this can be created on a
-- database that already carries the defective state.
update public.user_device_push_tokens t
set revoked_at = now(), updated_at = now()
where t.revoked_at is null
  and exists (
    select 1 from public.user_device_push_tokens o
    where o.push_token = t.push_token
      and o.revoked_at is null
      and (o.updated_at, o.id) > (t.updated_at, t.id)
  );

create unique index if not exists user_device_push_tokens_live_token_uidx
  on public.user_device_push_tokens (push_token)
  where revoked_at is null;

comment on index public.user_device_push_tokens_live_token_uidx is
  'DEF-WL-01. At most one non-revoked row may carry a given Expo push token, so a Watch alert can never be routed to a handset whose current actor is not the Watch owner.';
