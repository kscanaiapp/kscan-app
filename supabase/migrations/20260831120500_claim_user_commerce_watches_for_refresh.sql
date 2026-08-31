-- Build 34 / K+ Smart Watchlist V1 -- hostile-audit repair INT-KPLUS-008.
--
-- DEFECT. Tier 1 "user-open refresh" (commerce-watch-refresh action 'refresh')
-- selected its due rows with a plain SELECT (buildDueWatchPath) and then ran
-- runRefreshCycle over them. last_checked_at is not written until the END of
-- that cycle, so the staleness filter is not mutual exclusion: two concurrent
-- manual refreshes for the same Watch -- a double tap, list pull-to-refresh
-- overlapping the detail screen's REFRESH button, a retried invocation -- both
-- pass the filter, both call the provider, both write observation state, and
-- both can emit a change event and a push for a single user intent.
--
-- The Tier 2 background sweep never had this problem: it claims through
-- claim_watchable_commerce_watches, which stamps last_checked_at AS the claim
-- under FOR UPDATE SKIP LOCKED.
--
-- REPAIR. Give Tier 1 the same discipline rather than inventing a second
-- primitive. This is the user-scoped sibling of that RPC:
--
--   - identical claim mechanic (stamp last_checked_at inside the same
--     statement that selects, FOR UPDATE SKIP LOCKED);
--   - scoped to ONE owner, and optionally ONE watch, because Tier 1 is a
--     user action rather than a global sweep;
--   - deliberately NOT restricted to buy_under + push_enabled: a user opening
--     the app may refresh a passive "just watching" Watch, which the
--     background loop correctly ignores (§55). This is the one place the two
--     RPCs must differ.
--
-- K+ is still re-checked here as well as at the Edge: refresh is a K+
-- capability (§26) and K+ can lapse after a Watch was created, so the
-- entitlement must be true at the moment of the claim, not merely at the
-- start of the request.
--
-- Existing staleness protection is preserved exactly: p_min_interval_ms keeps
-- its meaning and the caller still overwrites last_checked_at with the true
-- observation timestamp when the refresh completes.

create or replace function public.claim_user_commerce_watches_for_refresh(
  p_user_id uuid,
  p_watch_id uuid default null,
  p_limit int default 25,
  p_min_interval_ms bigint default 600000
)
returns setof public.user_commerce_watches
language plpgsql
security definer
set search_path = public
as $$
declare
  bounded_limit int := greatest(1, least(coalesce(p_limit, 25), 200));
begin
  if p_user_id is null then
    raise exception 'user_id required' using errcode = '23502';
  end if;

  return query
  update public.user_commerce_watches w
  set last_checked_at = now()
  from (
    select id
    from public.user_commerce_watches
    where user_id = p_user_id
      and status = 'active'
      and deleted_at is null
      and (p_watch_id is null or id = p_watch_id)
      and (last_checked_at is null or last_checked_at < now() - make_interval(secs => p_min_interval_ms / 1000.0))
      and public.kplus_has_active_entitlement(p_user_id, 'k_plus')
    order by last_checked_at nulls first
    limit bounded_limit
    for update skip locked
  ) due
  where w.id = due.id
  returning w.*;
end;
$$;

revoke all on function public.claim_user_commerce_watches_for_refresh(uuid, uuid, int, bigint) from public, anon, authenticated;
grant execute on function public.claim_user_commerce_watches_for_refresh(uuid, uuid, int, bigint) to service_role;

comment on function public.claim_user_commerce_watches_for_refresh(uuid, uuid, int, bigint) is
  'INT-KPLUS-008. Tier 1 user-open refresh claim. Same atomic mechanic as claim_watchable_commerce_watches so two concurrent manual refreshes of one Watch produce at most one provider call, one state transition, one event and one push -- but owner-scoped and NOT limited to buy_under/push_enabled, because a user may refresh a passive Watch that the background loop ignores.';
