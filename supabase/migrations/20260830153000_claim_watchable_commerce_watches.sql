-- Build 34 / K+ Smart Watchlist V1 -- K5-C7: Tier 2 background sweep claim.
--
-- Mirrors claim_deletion_requests_for_purge / list_kplus_pending_revenuecat_sync:
-- a single, bounded, lock-safe claim RPC that the worker-secret-gated
-- commerce-watch-refresh sweep drains in small batches (§37, §56). Only
-- watches whose owner CURRENTLY holds active K+ are claimable -- refresh is
-- a K+ capability (§26), and K+ can lapse after a Watch was created, so this
-- is re-checked on every sweep rather than once at creation time.
--
-- FOR UPDATE SKIP LOCKED: a second concurrent worker invocation (retry,
-- overlap, manual + scheduled) claims a disjoint set rather than racing the
-- same rows, without needing an explicit lease table for what is, in V1,
-- a single fast UPDATE ... RETURNING per invocation.

create or replace function public.claim_watchable_commerce_watches(
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
  -- Stamps last_checked_at = now() as the claim itself (not a no-op): a
  -- FOR UPDATE lock is only held for this statement's instant, so without
  -- writing something here a second, overlapping worker invocation could
  -- claim the same due row a moment later. Bumping the timestamp immediately
  -- removes it from every subsequent claim's WHERE clause for at least
  -- p_min_interval_ms, which is real mutual exclusion without a lease table.
  -- The caller then overwrites it again with the true observation timestamp
  -- once the actual refresh completes.
  return query
  update public.user_commerce_watches w
  set last_checked_at = now()
  from (
    select id
    from public.user_commerce_watches
    where status = 'active'
      and deleted_at is null
      and (last_checked_at is null or last_checked_at < now() - make_interval(secs => p_min_interval_ms / 1000.0))
      and public.kplus_has_active_entitlement(user_id, 'k_plus')
    order by last_checked_at nulls first
    limit bounded_limit
    for update skip locked
  ) due
  where w.id = due.id
  returning w.*;
end;
$$;

revoke all on function public.claim_watchable_commerce_watches(int, bigint) from public, anon, authenticated;
grant execute on function public.claim_watchable_commerce_watches(int, bigint) to service_role;
