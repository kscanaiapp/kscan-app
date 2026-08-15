-- KSB29-029 / KSB29-030 / KSB29-031 — blocking must hold on every path to a
-- shared Dressing Room, not only on the UI's preferred one.
--
-- 20260806153233_dressing_room_user_blocking.sql taught `dressing_rooms` to
-- refuse a blocked recipient, and that policy works. It did not teach the
-- sibling paths, so blocking was enforced on the room SHELL while every other
-- route to the same protected content stayed open:
--
--   1. dressing_room_items — "Recipients can select items via active shares"
--      validates the share (membership, active, not revoked, not expired) but
--      never consults the block relation. A blocked recipient is denied the
--      room and can still read EVERY ITEM IN IT by querying the items table
--      directly. Hiding the shell while serving the contents is not blocking.
--
--   2. list_shared_rooms_for_me / save_shared_room_for_me /
--      touch_shared_room_for_me are SECURITY DEFINER, so they execute with the
--      definer's rights and RLS never runs for them. Each validates the share
--      and none consults the block, so a blocked user could still see the room
--      listed as `available` with its title and item count, still SAVE it
--      (creating or restoring a membership), and still touch its access time.
--
-- Verified against BOTH live projects on 2026-08-15 before writing:
--   dressing_rooms      recipient SELECT policy  checks block: TRUE   (correct)
--   dressing_room_items recipient SELECT policy  checks block: FALSE  (the gap)
--   all three RPCs                               check block:  FALSE  (the gap)
-- Identical on production (wyyuqfdxucjksghsmhry) and app staging
-- (yzqjvdfgefveprobvvyw).
--
-- The existing authoritative relation `internal.is_dressing_room_pair_blocked`
-- is reused unchanged; no second block concept is introduced, and the predicate
-- below is transcribed from the working `dressing_rooms` policy so the two
-- cannot disagree about what "blocked" means.
--
-- Historical migrations are not edited. Fully idempotent.

begin;

-- ── 1. Item reads honour the block ──────────────────────────────────────────
--
-- Recreated rather than altered: a policy's USING expression cannot be extended
-- in place, and dropping-then-creating inside this transaction means there is
-- no window in which the policy is missing.
drop policy if exists "Recipients can select items via active shares"
  on public.dressing_room_items;

create policy "Recipients can select items via active shares"
  on public.dressing_room_items
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.shared_room_memberships m
      join public.room_shares s on s.id = m.share_id
      join public.dressing_rooms dr on dr.id = s.room_id
      where s.room_id = dressing_room_items.dressing_room_id
        and m.recipient_user_id = (select auth.uid())
        and m.removed_at is null
        and s.is_active = true
        and s.revoked_at is null
        and (s.expires_at is null or s.expires_at > now())
        -- THE REPAIR. Same relation, same direction, same helper the
        -- dressing_rooms policy already uses.
        and not internal.is_dressing_room_pair_blocked(dr.user_id, (select auth.uid()))
    )
  );

comment on policy "Recipients can select items via active shares"
  on public.dressing_room_items is
  'Recipient item reads require a live share AND an unblocked relationship with the room owner. The block check mirrors the dressing_rooms policy: without it a blocked recipient was denied the room shell but could still read every item in it directly (KSB29-029).';

-- ── 2. SECURITY DEFINER helpers honour the same block ───────────────────────
--
-- These run with definer rights, so RLS does not protect them and the check has
-- to be explicit. Each keeps its existing contract, return shape, and status
-- vocabulary; a blocked relationship simply resolves to the SAME answer the
-- caller already gets for a revoked or expired share, so blocking reveals
-- nothing new about why access failed.

create or replace function public.list_shared_rooms_for_me()
returns table (
  share_token text,
  title text,
  item_count bigint,
  first_opened_at timestamptz,
  last_accessed_at timestamptz,
  status text,
  shared_at timestamptz,
  room_updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path to 'pg_catalog'
as $function$
declare
  current_user_id uuid := auth.uid();
begin
  if current_user_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  return query
  with recipient_memberships as materialized (
    select
      srm.share_id,
      srm.first_opened_at,
      srm.last_accessed_at,
      rs.share_token,
      rs.room_id,
      rs.created_at as shared_at,
      dr.title,
      dr.updated_at as room_updated_at,
      (
        rs.access_level = 'view'
        and rs.is_active = true
        and rs.revoked_at is null
        and (rs.expires_at is null or rs.expires_at > now())
        and rs.owner_id = dr.user_id
        -- KSB29-030: a blocked room reads as `unavailable`, exactly like a
        -- revoked or expired one. Its title, item count and updated-at are
        -- already suppressed for anything not available.
        and not internal.is_dressing_room_pair_blocked(dr.user_id, current_user_id)
      ) as is_available
    from public.shared_room_memberships as srm
    join public.room_shares as rs
      on rs.id = srm.share_id
    join public.dressing_rooms as dr
      on dr.id = rs.room_id
    where srm.recipient_user_id = current_user_id
      and srm.removed_at is null
    order by srm.last_accessed_at desc, srm.share_id
    limit 100
  ),
  item_counts as (
    select
      dri.dressing_room_id as room_id,
      count(*)::bigint as item_count
    from public.dressing_room_items as dri
    join (
      select distinct rm.room_id
      from recipient_memberships as rm
      where rm.is_available
    ) as available_rooms
      on available_rooms.room_id = dri.dressing_room_id
    group by dri.dressing_room_id
  )
  select
    rm.share_token,
    case
      when rm.is_available then
        nullif(btrim(left(regexp_replace(coalesce(rm.title, ''), '<[^>]*>', '', 'g'), 100)), '')
      else null::text
    end as title,
    case
      when rm.is_available then coalesce(ic.item_count, 0::bigint)
      else 0::bigint
    end as item_count,
    rm.first_opened_at,
    rm.last_accessed_at,
    case
      when not rm.is_available then 'unavailable'
      when coalesce(ic.item_count, 0::bigint) = 0 then 'empty'
      else 'available'
    end as status,
    rm.shared_at,
    case when rm.is_available then rm.room_updated_at else null::timestamptz end
      as room_updated_at
  from recipient_memberships as rm
  left join item_counts as ic
    on ic.room_id = rm.room_id
  order by rm.last_accessed_at desc, rm.share_id;
end;
$function$;

create or replace function public.save_shared_room_for_me(p_share_token text)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog'
as $function$
declare
  current_user_id uuid := auth.uid();
  normalized_token text;
  target_share record;
  existing_membership record;
  event_time timestamptz;
  result_status text;
begin
  if current_user_id is null then
    return jsonb_build_object('status', 'unauthenticated');
  end if;
  normalized_token := nullif(btrim(coalesce(p_share_token, '')), '');
  if normalized_token is null or normalized_token !~ '^[A-Za-z0-9_-]+$' then
    return jsonb_build_object('status', 'malformed');
  end if;

  select
    rs.id,
    rs.room_id,
    dr.user_id as owner_id
  into target_share
  from public.room_shares as rs
  join public.dressing_rooms as dr
    on dr.id = rs.room_id
   and dr.user_id = rs.owner_id
  where rs.share_token = normalized_token
    and rs.access_level = 'view'
    and rs.is_active = true
    and rs.revoked_at is null
    and (rs.expires_at is null or rs.expires_at > now())
    -- KSB29-031: a blocked user could otherwise still create or restore a
    -- membership to a room whose owner blocked them.
    and not internal.is_dressing_room_pair_blocked(dr.user_id, current_user_id)
  limit 1
  for update of rs;
  if not found then
    return jsonb_build_object('status', 'unavailable');
  end if;

  if target_share.owner_id = current_user_id then
    return jsonb_build_object('status', 'owner');
  end if;

  select srm.id, srm.removed_at
  into existing_membership
  from public.shared_room_memberships as srm
  where srm.share_id = target_share.id
    and srm.recipient_user_id = current_user_id
  for update;

  event_time := clock_timestamp();
  if not found then
    insert into public.shared_room_memberships (
      share_id, recipient_user_id, first_opened_at,
      last_accessed_at, created_at, updated_at
    )
    values (
      target_share.id, current_user_id, event_time,
      event_time, event_time, event_time
    );
    result_status := 'saved';
  elsif existing_membership.removed_at is not null then
    update public.shared_room_memberships as srm
    set removed_at = null,
        last_accessed_at = event_time
    where srm.id = existing_membership.id;
    result_status := 'restored';
  else
    update public.shared_room_memberships as srm
    set last_accessed_at = event_time
    where srm.id = existing_membership.id;
    result_status := 'already_saved';
  end if;

  return jsonb_build_object('status', result_status);
end;
$function$;

create or replace function public.touch_shared_room_for_me(p_share_token text)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog'
as $function$
declare
  current_user_id uuid := auth.uid();
  normalized_token text;
  target_share_id uuid;
begin
  if current_user_id is null then
    return jsonb_build_object('status', 'unauthenticated');
  end if;
  normalized_token := nullif(btrim(coalesce(p_share_token, '')), '');
  if normalized_token is null or normalized_token !~ '^[A-Za-z0-9_-]+$' then
    return jsonb_build_object('status', 'malformed');
  end if;

  select rs.id
  into target_share_id
  from public.room_shares as rs
  join public.dressing_rooms as dr
    on dr.id = rs.room_id
   and dr.user_id = rs.owner_id
  where rs.share_token = normalized_token
    and rs.access_level = 'view'
    and rs.is_active = true
    and rs.revoked_at is null
    and (rs.expires_at is null or rs.expires_at > now())
    -- KSB29-031: a blocked user must not keep refreshing their access time on
    -- a room they can no longer reach.
    and not internal.is_dressing_room_pair_blocked(dr.user_id, current_user_id)
  limit 1
  for update of rs;
  if not found then
    return jsonb_build_object('status', 'unavailable');
  end if;

  update public.shared_room_memberships as srm
  set last_accessed_at = clock_timestamp()
  where srm.share_id = target_share_id
    and srm.recipient_user_id = current_user_id
    and srm.removed_at is null;
  if not found then
    return jsonb_build_object('status', 'unavailable');
  end if;

  return jsonb_build_object('status', 'touched');
end;
$function$;

-- Execution rights are unchanged from the migration that created these; they
-- are restated so a fresh database built from history ends in the same state.
revoke all on function public.list_shared_rooms_for_me() from public, anon;
revoke all on function public.save_shared_room_for_me(text) from public, anon;
revoke all on function public.touch_shared_room_for_me(text) from public, anon;
grant execute on function public.list_shared_rooms_for_me() to authenticated;
grant execute on function public.save_shared_room_for_me(text) to authenticated;
grant execute on function public.touch_shared_room_for_me(text) to authenticated;

-- ── KSB29-033: NOT A DEFECT, verified rather than assumed ───────────────────
--
-- The audit reported no effective GRANT on dressing_room_item_reactions. That
-- is not the case in either environment: `authenticated` already holds
-- SELECT, INSERT, UPDATE and DELETE with RLS enabled, so its policies are
-- reachable. Read live on 2026-08-15 from both projects. Nothing is granted
-- here — broadening a permission that is already correct would weaken the
-- boundary, not repair it.

commit;
