-- Converge the room-share redemption contract without rewriting live links.
--
-- Legacy links intentionally use NULL to mean unlimited. Positive integers are
-- capped links, and newly created rows that omit the column default to 10.
-- This migration sorts immediately after the verified remote ledger boundary,
-- so the live contract is repaired before the still-unapplied prerequisite and
-- stylist migrations. It is the final schema authority for both clean replays
-- and the existing remote schema.

-- A clean database does not yet have the column, while the verified remote
-- database does. Creation is followed by explicit ALTER and validation below;
-- column existence alone is never treated as proof of the complete contract.
alter table public.room_shares
  add column if not exists max_redemptions integer;

-- Remove only the obsolete, historically evidenced upper-bound constraint when
-- present. It is absent from the verified remote schema.
alter table public.room_shares
  drop constraint if exists room_shares_max_redemptions_check;

alter table public.room_shares
  alter column max_redemptions drop not null,
  alter column max_redemptions set default 10;

alter table public.room_shares
  add constraint room_shares_max_redemptions_positive_check
  check (max_redemptions is null or max_redemptions > 0)
  not valid;

alter table public.room_shares
  validate constraint room_shares_max_redemptions_positive_check;

comment on column public.room_shares.max_redemptions is
  'NULL denotes an unlimited legacy room-share link. Positive integers denote redemption-capped links. New links default to 10 redemptions.';

-- Preserve the hardened join behavior introduced by 20260712020000 while
-- restoring the verified legacy NULL semantics. The share row remains locked
-- while a new participant is counted and inserted, preventing oversubscription
-- of numeric caps. Existing participants and owners remain idempotent.
create or replace function public.join_room_via_share_token(p_share_token text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  normalized_token text := nullif(btrim(coalesce(p_share_token, '')), '');
  target_share_id uuid;
  target_room_id uuid;
  target_owner_id uuid;
  target_max_redemptions integer;
  current_redemptions integer;
begin
  if current_user_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  if normalized_token is null or normalized_token !~ '^[A-Za-z0-9_-]+$' then
    raise exception 'Invalid share link' using errcode = '22023';
  end if;

  select rs.id, rs.room_id, dr.user_id, rs.max_redemptions
  into target_share_id, target_room_id, target_owner_id, target_max_redemptions
  from public.room_shares rs
  join public.dressing_rooms dr
    on dr.id = rs.room_id
  where rs.share_token = normalized_token
    and rs.is_active = true
    and rs.revoked_at is null
    and (rs.expires_at is null or rs.expires_at > now())
  limit 1
  for update of rs;

  if target_room_id is null then
    raise exception 'Shared room is unavailable' using errcode = '42501';
  end if;

  -- The owner is an implicit participant; never create a membership row for them.
  if target_owner_id is not distinct from current_user_id then
    return target_room_id;
  end if;

  -- Reopening an already-joined room is idempotent and does not consume another
  -- redemption.
  if exists (
    select 1
    from public.dressing_room_participants p
    where p.dressing_room_id = target_room_id
      and p.user_id = current_user_id
  ) then
    return target_room_id;
  end if;

  -- NULL is the preserved unlimited sentinel. Numeric caps alone are counted.
  if target_max_redemptions is not null then
    select count(*)
    into current_redemptions
    from public.dressing_room_participants p
    where p.joined_via_share_id = target_share_id;

    if current_redemptions >= target_max_redemptions then
      raise exception 'Shared room is full' using errcode = '42501';
    end if;
  end if;

  insert into public.dressing_room_participants (dressing_room_id, user_id, role, joined_via_share_id)
  values (target_room_id, current_user_id, 'participant', target_share_id);

  return target_room_id;
end;
$$;

revoke all on function public.join_room_via_share_token(text) from public;
revoke all on function public.join_room_via_share_token(text) from anon;
grant execute on function public.join_room_via_share_token(text) to authenticated;
