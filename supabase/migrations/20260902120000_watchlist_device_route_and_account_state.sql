-- Build 34 / K+ Smart Watchlist V1 -- deep-audit repairs WL-04 and WL-07.
--
-- === WL-04: one live push route per physical device, structurally ==========
--
-- DEF-WL-01 (20260830190000) closed the actor-switch push leak with a partial
-- unique index on push_token, and stated the principle plainly: a partial
-- unique index makes the bad state unrepresentable rather than merely
-- unreached. That principle was applied to the token axis and NOT to the
-- device axis -- which is the axis the leak actually runs on.
--
-- Proven live on staging during this audit (probe D-6): two DIFFERENT actors can
-- hold non-revoked rows for one device_id. The control (probe D-7) confirms the
-- probe can detect a structural constraint -- a duplicate live push_token was
-- rejected 23505 -- so D-6 result is a real absence, not a broken test.
--
-- The reachable-today paths are closed procedurally and do work (probe D-3:
-- claim_device_for_actor retired the departed actor route without the arriving
-- actor ever registering). But "at most one actor may be live on one handset" is
-- the invariant that decides whether a Watch alert -- whose body carries the
-- watched item title and its price -- can land on a device whose current owner
-- is not the Watch owner. It should not depend on two RPCs remembering to run.
--
-- Both writers already retire competing rows BEFORE they insert
-- (register_device_push_token retires by device_id OR push_token;
-- claim_device_for_actor retires by device_id), so the legitimate paths cannot
-- collide with this index. Pre-existing duplicates are retired first, newest
-- kept, exactly as the push_token index did.

update public.user_device_push_tokens t
set revoked_at = now(), updated_at = now()
where t.revoked_at is null
  and exists (
    select 1 from public.user_device_push_tokens o
    where o.device_id = t.device_id
      and o.revoked_at is null
      and (o.updated_at, o.id) > (t.updated_at, t.id)
  );

create unique index if not exists user_device_push_tokens_live_device_uidx
  on public.user_device_push_tokens (device_id)
  where revoked_at is null;

comment on index public.user_device_push_tokens_live_device_uidx is
  'WL-04. At most one non-revoked row may exist for a given physical device, so a departed actor Watch-alert route cannot remain deliverable on a handset that has changed hands -- structurally, not only when claim_device_for_actor or register_device_push_token happen to run.';

-- === WL-07: no background premium work for an account being deleted ========
--
-- DEFECT. Entitlements are removed only at PURGE (user_entitlements is an
-- auth_delete_cascade resource), so throughout the 30-day deletion grace period
-- a deactivated actor still satisfies kplus_has_active_entitlement -- the only
-- eligibility test either claim RPC applied. Their Watches kept being claimed,
-- kept spending paid provider calls, and kept being able to raise an event and
-- deliver a push, for an account the user has asked to delete.
--
-- Every other premium surface already refuses these accounts: stylechat-generate
-- and style-outfit-generate both answer 403 ACCOUNT_PENDING_DELETION, and the
-- is_active_account() RLS gate blocks their ordinary reads. Watchlist was the
-- outlier, and it is the one that keeps working while nobody is looking.
--
-- REPAIR. Both claim RPCs additionally require the owner account to be active.
-- is_active_account() cannot be reused directly: it reads auth.uid(), which is
-- null in the service-role context these RPCs run in. This mirrors its logic for
-- an explicit user id instead, in the same order and with the same effective-row
-- semantics, so the two cannot disagree about who is active.
--
-- Deletes nothing and revokes nothing: an account that is restored resumes
-- refreshing on the next sweep with its Watches and history intact.

create or replace function public.watchlist_actor_is_active(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select case
    when p_user_id is null then false
    when exists (select 1 from public.profiles p where p.id = p_user_id) then
      exists (
        select 1
        from public.profiles p
        where p.id = p_user_id
          and coalesce(p.account_status, 'active') = 'active'
          and p.account_locked_at is null
      )
    else
      coalesce(
        (select dr.status
         from public.deletion_requests dr
         where dr.user_id = p_user_id
         order by dr.requested_at desc nulls last, dr.id desc
         limit 1),
        'none'
      ) not in (
        'pending', 'processing', 'completed',
        'deactivated', 'purging', 'legal_hold', 'failed'
      )
  end;
$fn$;

revoke all on function public.watchlist_actor_is_active(uuid) from public, anon, authenticated;
grant execute on function public.watchlist_actor_is_active(uuid) to service_role;

comment on function public.watchlist_actor_is_active(uuid) is
  'WL-07. Service-role-callable account-active test for an explicit user id, mirroring is_active_account() (which reads auth.uid() and is therefore unusable from the Watchlist claim RPCs). Used to keep background refresh and push off accounts in the deletion grace period.';

create or replace function public.claim_watchable_commerce_watches(
  p_limit int default 25,
  p_min_interval_ms bigint default 600000
)
returns setof public.user_commerce_watches
language plpgsql
security definer
set search_path = public
as $fn$
declare
  bounded_limit int := greatest(1, least(coalesce(p_limit, 25), 200));
begin
  return query
  update public.user_commerce_watches w
  set last_checked_at = now()
  from (
    select id
    from public.user_commerce_watches
    where status = 'active'
      and deleted_at is null
      and watch_intent = 'buy_under'
      and push_enabled = true
      and (last_checked_at is null or last_checked_at < now() - make_interval(secs => p_min_interval_ms / 1000.0))
      and public.kplus_has_active_entitlement(user_id, 'k_plus')
      -- WL-07: K+ can outlive access. An account in the deletion grace period
      -- still holds its entitlement but must not receive premium background work.
      and public.watchlist_actor_is_active(user_id)
    order by last_checked_at nulls first
    limit bounded_limit
    for update skip locked
  ) due
  where w.id = due.id
  returning w.*;
end;
$fn$;

revoke all on function public.claim_watchable_commerce_watches(int, bigint) from public, anon, authenticated;
grant execute on function public.claim_watchable_commerce_watches(int, bigint) to service_role;

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
as $fn$
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
      and public.watchlist_actor_is_active(p_user_id)
    order by last_checked_at nulls first
    limit bounded_limit
    for update skip locked
  ) due
  where w.id = due.id
  returning w.*;
end;
$fn$;

revoke all on function public.claim_user_commerce_watches_for_refresh(uuid, uuid, int, bigint) from public, anon, authenticated;
grant execute on function public.claim_user_commerce_watches_for_refresh(uuid, uuid, int, bigint) to service_role;
