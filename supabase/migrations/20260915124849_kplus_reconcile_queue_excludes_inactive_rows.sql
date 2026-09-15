-- K Scan AI -- Build 34 K+ RevenueCat reconcile queue: exclude inactive rows
-- (queue-starvation closure for the row-scoped mirror gate added in PR #417).
--
-- CONTEXT: #417 gates kplus-reconcile-revenuecat on
-- public.kplus_user_entitlement_row_is_active(p_user_id, p_entitlement_key)
-- before mirroring a row, and fails closed (no RevenueCat call, no sync-status
-- write) when a row is not confirmed live. That closed SEC-KPLUS-008 for the
-- reconcile path: a revoked-but-still-pending row is never mirrored as live.
--
-- It did not close a second, narrower defect: public.list_kplus_pending_
-- revenuecat_sync selects on external_sync_status alone (pending /
-- failed_retryable), with no floor on how long a row that will never become
-- live stays in that set. Because #417 now leaves a skipped row's sync status
-- untouched (by design -- see below), a revoked or expired row that was
-- 'pending' at revocation time stays 'pending' forever. The list is capped
-- and ordered oldest-first, so once at least `p_limit` such permanently
-- ineligible rows sort ahead of a genuinely live pending row, that live row
-- is never selected and never reconciled. Before #417 this queue emptied
-- itself by mirroring those rows (the SEC-KPLUS-008 bug); #417 correctly
-- stopped that, which is what exposes this starvation shape.
--
-- FIX: the list RPC itself now applies the same row-liveness predicate as
-- kplus_user_entitlement_row_is_active, inline against the row it is already
-- reading (no need for a second lookup): status = 'active' and revoked_at is
-- null and expires_at is not null and expires_at > now(). A row that fails
-- this is not queue-eligible at all -- it never occupies a batch slot.
--
-- LAYERING (both layers are required, this migration removes neither):
--   1. This RPC: queue SELECTION. Keeps ineligible rows out of the bounded
--      batch so they can never starve a live row.
--   2. kplus_user_entitlement_row_is_active in the Edge Function: an
--      independent RE-CHECK of the one specific row about to be mirrored,
--      closing the race where a row is selected while live and then revoked
--      before this batch reaches it (list and mirror are not one
--      transaction). The queue filter is selection, not authorization -- the
--      Edge Function's own check is what makes the mirror decision safe.
--
-- NOT DONE HERE (explicit, unchanged from #417):
--   - No sync-status write for an ineligible row. It is simply no longer
--     queue-eligible; its historical external_sync_status is left exactly as
--     it was. This migration changes queue SELECTION only.
--   - No change to kplus_has_active_entitlement, kplus_user_entitlement_row_
--     is_active, set_kplus_revenuecat_sync_status, or any Edge Function.
--   - No RevenueCat call. No grant issued, revoked, or expired. No
--     activation event. This is a pure read-path (STABLE, SECURITY DEFINER)
--     filter change; user_entitlements is neither read differently in a way
--     that mutates it, nor written by this migration at all.
--
-- Signature, return type, security mode, search_path, ordering, default
-- limit (25), max clamp (200) and grants (service_role execute only) are
-- unchanged from 20260829120000_kplus_entitlements.sql -- only the eligibility
-- filter is widened.

create or replace function public.list_kplus_pending_revenuecat_sync(p_limit integer default 25)
returns setof public.user_entitlements
language sql
stable
security definer
set search_path = public
as $$
  select *
    from public.user_entitlements
   where external_sync_status in ('pending', 'failed_retryable')
     and status = 'active'
     and revoked_at is null
     and expires_at is not null
     and expires_at > now()
   order by updated_at asc
   limit greatest(1, least(coalesce(p_limit, 25), 200));
$$;

revoke all on function public.list_kplus_pending_revenuecat_sync(integer)
  from public, anon, authenticated;
grant execute on function public.list_kplus_pending_revenuecat_sync(integer)
  to service_role;
