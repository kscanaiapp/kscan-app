-- Shared Dressing Room links: actually enforce max_redemptions.
--
-- THE STATE THIS REPAIRS, read live from both projects on 2026-08-15:
--
--   room_shares.max_redemptions  DEFAULT 10
--   save_shared_room_for_me      does not reference max_redemptions at all
--
-- So the limit was decorative: a share link could be redeemed by unlimited
-- recipients. The column existed, the positive-value constraint existed, and
-- nothing ever read either one. THAT is the defect — not the number.
--
-- THIS MIGRATION SETS NO LIMIT AND CHANGES NO VALUE. The number is a product
-- decision that lives in the column; the defect is that nothing read it. The
-- default stays 10, existing rows are untouched, and NULL keeps meaning
-- unlimited — which is a legitimate configuration, including for testing.
-- What changes is only that the configured value is now honoured.
--
-- WHAT COUNTS AS A USE. A use is a successful FIRST-TIME redemption that
-- creates durable access for a recipient. The count is therefore the number of
-- DISTINCT RECIPIENTS admitted to the share, which is exactly
-- `count(*) from shared_room_memberships where share_id = ...` — the table
-- carries a unique index on (share_id, recipient_user_id), so one row IS one
-- recipient.
--
-- Defining it that way makes every "does not consume a use" rule fall out of
-- the data model instead of needing separate handling:
--
--   opening the link without redeeming   -> no row is written
--   an authentication redirect           -> no row is written
--   a failed or aborted redemption       -> the transaction rolls back
--   the browser fallback                 -> no row is written
--   an already-authorized recipient      -> their row already exists
--   restarting the app / reopening the
--     persisted room from Dressing Rooms -> reads a row, writes none
--   a removed member being restored      -> their row still exists, so they
--                                           reclaim their own slot rather than
--                                           consuming a second one
--
-- ATOMICITY. The membership count is taken while the share row is held under
-- the `for update of rs` lock the function already takes. Two clients racing
-- the last allowed redemption and the first denied one serialize on that lock,
-- so they cannot both read the same stale count and both succeed. A count taken
-- outside the lock would be exactly that bug.
--
-- NULL MEANS UNLIMITED, and that is deliberate rather than a fallback: a share
-- with no configured maximum is unconstrained, which is a valid setup and is
-- useful for testing. The check is skipped entirely in that case rather than
-- being given an invented default.
--
-- Everything else about this function is preserved verbatim, including the
-- KSB29-031 blocking check: a blocked pair cannot redeem, and a denied
-- redemption writes no row, so it consumes no use.
--
-- Historical migrations are not edited. Fully idempotent.

begin;

-- No schema change and no data change. Only the comment is refreshed, so the
-- column now states where its enforcement lives — the absence of any such
-- statement is part of why nothing ever read it.
comment on column public.room_shares.max_redemptions is
  'Maximum successful first-time redemptions, counted as DISTINCT recipients (unique share_id + recipient_user_id). NULL means unlimited. Enforced atomically in save_shared_room_for_me under the share row lock.';

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
  redemption_count integer;
  effective_max integer;
begin
  if current_user_id is null then
    return jsonb_build_object('status', 'unauthenticated');
  end if;
  normalized_token := nullif(btrim(coalesce(p_share_token, '')), '');
  if normalized_token is null or normalized_token !~ '^[A-Za-z0-9_-]+$' then
    return jsonb_build_object('status', 'malformed');
  end if;

  -- `for update of rs` is what makes the redemption count below atomic: every
  -- concurrent redemption of this share serializes here.
  select
    rs.id,
    rs.room_id,
    dr.user_id as owner_id,
    rs.max_redemptions as effective_max
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
    -- KSB29-031: a blocked pair cannot redeem. Denied before any row is
    -- written, so a blocked attempt consumes no use.
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
    -- FIRST-TIME redemption: the only path that consumes a use, so the limit
    -- is checked here and nowhere else.
    --
    -- A NULL maximum is unlimited, so the count is not even taken — the share
    -- is unconstrained by configuration, not by a default this migration
    -- invented.
    effective_max := target_share.effective_max;
    if effective_max is not null then
      select count(*) into redemption_count
      from public.shared_room_memberships as srm
      where srm.share_id = target_share.id;
    else
      redemption_count := null;
    end if;

    if effective_max is not null and redemption_count >= effective_max then
      -- Deliberately its own status rather than 'unavailable': the link is
      -- valid and the room exists, so telling the owner and the recipient
      -- "this link is used up" is both true and actionable, where
      -- "unavailable" would send them looking for a revoked link.
      return jsonb_build_object('status', 'limit_reached');
    end if;

    insert into public.shared_room_memberships (
      share_id,
      recipient_user_id,
      first_opened_at,
      last_accessed_at,
      created_at,
      updated_at
    )
    values (
      target_share.id,
      current_user_id,
      event_time,
      event_time,
      event_time,
      event_time
    );
    result_status := 'saved';
  elsif existing_membership.removed_at is not null then
    -- The recipient already occupies a slot; reclaiming it consumes no
    -- additional use, and must not be able to fail on a full link.
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

revoke all on function public.save_shared_room_for_me(text) from public, anon;
grant execute on function public.save_shared_room_for_me(text) to authenticated;

commit;
