-- Shared Dressing Room memberships v1 — account-anchored "Shared with Me" backend.
--
-- Adds a dedicated recipient-membership table that is independent of:
--   * dressing_room_participants (chat/collaboration membership)
--   * room_shares (share-link metadata)
--   * max_redemptions (link-level usage cap)
--
-- The authoritative relationship is:
--   shared_room_memberships -> room_shares -> dressing_rooms -> owner
--
-- Design choices:
--   * Link memberships to room_shares.id, not the raw token, so token rotation
--     creates a distinct share and therefore a distinct membership.
--   * Do not duplicate owner_id or room_id; both are derivable through the
--     share/room relationship.
--   * Do not store item arrays, storage coordinates, signed URLs, or room
--     payloads in the membership table.
--   * Recipient-private state (removed_at, first/last access) is strictly
--     isolated by RLS; room owners cannot enumerate recipient memberships.
--   * Membership mutations are RPC-only; direct client table writes are denied.

-- ── Membership table ───────────────────────────────────────────────────────────
create table if not exists public.shared_room_memberships (
  id                uuid primary key default gen_random_uuid(),
  share_id          uuid not null references public.room_shares(id) on delete cascade,
  recipient_user_id uuid not null references auth.users(id) on delete cascade,
  first_opened_at   timestamptz not null default now(),
  last_accessed_at  timestamptz not null default now(),
  removed_at        timestamptz null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint shared_room_memberships_share_recipient_key unique (share_id, recipient_user_id)
);

comment on table public.shared_room_memberships is
  'Account-anchored recipient membership for Shared with Me. Independent of chat participants. Authoritative for which rooms a signed-in user has opened through a share link.';
comment on column public.shared_room_memberships.share_id is
  'Authoritative share row. Token rotation creates a new share and a new membership.';
comment on column public.shared_room_memberships.removed_at is
  'Soft-delete timestamp set when the recipient removes the room from Shared with Me. Reopening the same active share restores the membership by clearing this field.';

-- Indexes for the two access patterns: list for a recipient, lookup by share.
create index if not exists shared_room_memberships_recipient_idx
  on public.shared_room_memberships (recipient_user_id);

create index if not exists shared_room_memberships_recipient_active_idx
  on public.shared_room_memberships (recipient_user_id, removed_at)
  where removed_at is null;

create index if not exists shared_room_memberships_share_idx
  on public.shared_room_memberships (share_id);

-- ── Row-level security ─────────────────────────────────────────────────────────
alter table public.shared_room_memberships enable row level security;

-- No anonymous access of any kind.
revoke all on public.shared_room_memberships from anon;
revoke all on public.shared_room_memberships from public;

-- Authenticated users may read/update only their own rows. Direct inserts are
-- also gated by RLS, but the intended mutation path is the SECURITY DEFINER
-- RPC below, which bypasses RLS intentionally to enforce share validation.
grant select, insert, update on public.shared_room_memberships to authenticated;

-- Service role retains full access for account-deletion orchestration.
grant select, insert, update, delete on public.shared_room_memberships to service_role;

-- Revoke dangerous table-level privileges that RLS does not govern.
revoke truncate, references, trigger, maintain on public.shared_room_memberships
  from anon, authenticated, service_role;

create policy "Recipients can select own shared room memberships"
  on public.shared_room_memberships
  for select
  to authenticated
  using (recipient_user_id = auth.uid());

create policy "Recipients can insert own shared room memberships"
  on public.shared_room_memberships
  for insert
  to authenticated
  with check (recipient_user_id = auth.uid());

create policy "Recipients can update own shared room memberships"
  on public.shared_room_memberships
  for update
  to authenticated
  using (recipient_user_id = auth.uid())
  with check (recipient_user_id = auth.uid());

-- ── updated_at trigger ─────────────────────────────────────────────────────────
create or replace function public.set_shared_room_memberships_updated_at()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

revoke all on function public.set_shared_room_memberships_updated_at() from public;
revoke all on function public.set_shared_room_memberships_updated_at() from anon;
grant execute on function public.set_shared_room_memberships_updated_at() to authenticated, service_role;

do $$
begin
  if not exists (
    select 1
    from pg_trigger
    where tgname = 'shared_room_memberships_updated_at'
      and tgrelid = 'public.shared_room_memberships'::regclass
  ) then
    create trigger shared_room_memberships_updated_at
      before update on public.shared_room_memberships
      for each row
      execute function public.set_shared_room_memberships_updated_at();
  end if;
end;
$$;

-- ── Save a shared room for the current authenticated recipient ─────────────────
--
-- Validates the active share server-side, no-ops for the room owner, and
-- upserts one membership per recipient/share. Returns deterministic sanitized
-- status values: 'saved', 'already_saved', 'restored', 'owner', 'unavailable',
-- 'unauthenticated', 'malformed'.
create or replace function public.save_shared_room_for_me(p_share_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  normalized_token text;
  target_share record;
  existing_membership record;
  result_status text;
begin
  if current_user_id is null then
    return jsonb_build_object('status', 'unauthenticated');
  end if;

  normalized_token := nullif(btrim(coalesce(p_share_token, '')), '');
  if normalized_token is null or normalized_token !~ '^[A-Za-z0-9_-]+$' then
    return jsonb_build_object('status', 'malformed');
  end if;

  -- Lock the share row to serialize concurrent saves for the same link.
  select
    rs.id,
    rs.room_id,
    dr.user_id as owner_id
  into target_share
  from public.room_shares rs
  join public.dressing_rooms dr on dr.id = rs.room_id
  where rs.share_token = normalized_token
    and rs.access_level = 'view'
    and rs.is_active = true
    and rs.revoked_at is null
    and (rs.expires_at is null or rs.expires_at > now())
  limit 1
  for update of rs;

  if target_share.room_id is null then
    return jsonb_build_object('status', 'unavailable');
  end if;

  -- Owners see their rooms under "My Dressing Rooms", not "Shared with Me".
  if target_share.owner_id = current_user_id then
    return jsonb_build_object('status', 'owner');
  end if;

  -- Determine whether this is a first save, repeat open, or restoration.
  select *
  into existing_membership
  from public.shared_room_memberships
  where share_id = target_share.id
    and recipient_user_id = current_user_id;

  if existing_membership.id is null then
    insert into public.shared_room_memberships (share_id, recipient_user_id, first_opened_at, last_accessed_at)
    values (target_share.id, current_user_id, now(), now());
    result_status := 'saved';
  elsif existing_membership.removed_at is not null then
    update public.shared_room_memberships
    set removed_at = null,
        last_accessed_at = now(),
        updated_at = now()
    where id = existing_membership.id;
    result_status := 'restored';
  else
    update public.shared_room_memberships
    set last_accessed_at = now(),
        updated_at = now()
    where id = existing_membership.id;
    result_status := 'already_saved';
  end if;

  return jsonb_build_object('status', result_status);
end;
$$;

revoke all on function public.save_shared_room_for_me(text) from public;
revoke all on function public.save_shared_room_for_me(text) from anon;
grant execute on function public.save_shared_room_for_me(text) to authenticated;

-- ── List Shared with Me for the current authenticated recipient ────────────────
--
-- Returns one bounded result set. No N+1 token loop. Excludes soft-removed
-- memberships and shares that are revoked, expired, or deleted. Returns only
-- safe, list-renderable fields; no owner IDs, recipient IDs, item arrays, or
-- storage coordinates.
create or replace function public.list_shared_rooms_for_me()
returns table (
  share_token      text,
  title            text,
  item_count       bigint,
  first_opened_at  timestamptz,
  last_accessed_at timestamptz,
  status           text,
  shared_at        timestamptz,
  room_updated_at  timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  with room_item_counts as (
    select dri.dressing_room_id as room_id, count(*)::bigint as cnt
    from public.dressing_room_items dri
    group by dri.dressing_room_id
  )
  select
    rs.share_token,
    dr.title,
    coalesce(ric.cnt, 0::bigint) as item_count,
    srm.first_opened_at,
    srm.last_accessed_at,
    case
      when coalesce(ric.cnt, 0::bigint) = 0 then 'empty'
      else 'active'
    end as status,
    rs.created_at as shared_at,
    dr.updated_at as room_updated_at
  from public.shared_room_memberships srm
  join public.room_shares rs on rs.id = srm.share_id
  join public.dressing_rooms dr on dr.id = rs.room_id
  left join room_item_counts ric on ric.room_id = dr.id
  where srm.recipient_user_id = auth.uid()
    and srm.removed_at is null
    and rs.is_active = true
    and rs.revoked_at is null
    and (rs.expires_at is null or rs.expires_at > now())
  order by srm.last_accessed_at desc
  limit 100;
$$;

revoke all on function public.list_shared_rooms_for_me() from public;
revoke all on function public.list_shared_rooms_for_me() from anon;
grant execute on function public.list_shared_rooms_for_me() to authenticated;

-- ── Touch an existing membership (update last_accessed_at) ─────────────────────
--
-- Requires the associated share to remain active. Affects only the current
-- recipient's non-removed membership. Preserves first_opened_at.
create or replace function public.touch_shared_room_for_me(p_share_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
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
  from public.room_shares rs
  where rs.share_token = normalized_token
    and rs.access_level = 'view'
    and rs.is_active = true
    and rs.revoked_at is null
    and (rs.expires_at is null or rs.expires_at > now())
  limit 1;

  if target_share_id is null then
    return jsonb_build_object('status', 'unavailable');
  end if;

  update public.shared_room_memberships
  set last_accessed_at = now(),
      updated_at = now()
  where share_id = target_share_id
    and recipient_user_id = current_user_id
    and removed_at is null;

  if not found then
    return jsonb_build_object('status', 'unavailable');
  end if;

  return jsonb_build_object('status', 'touched');
end;
$$;

revoke all on function public.touch_shared_room_for_me(text) from public;
revoke all on function public.touch_shared_room_for_me(text) from anon;
grant execute on function public.touch_shared_room_for_me(text) to authenticated;

-- ── Remove a shared room from the recipient's list ─────────────────────────────
--
-- Sets removed_at for the current recipient only. Does not revoke the owner's
-- share and does not affect other recipients. Idempotent.
create or replace function public.remove_shared_room_for_me(p_share_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
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

  -- Resolve the share by token; removal is allowed even if the share has since
  -- been revoked, because the membership row still belongs to the recipient.
  select rs.id
  into target_share_id
  from public.room_shares rs
  where rs.share_token = normalized_token
  limit 1;

  if target_share_id is null then
    return jsonb_build_object('status', 'unavailable');
  end if;

  update public.shared_room_memberships
  set removed_at = now(),
      updated_at = now()
  where share_id = target_share_id
    and recipient_user_id = current_user_id
    and removed_at is null;

  return jsonb_build_object('status', 'removed');
end;
$$;

revoke all on function public.remove_shared_room_for_me(text) from public;
revoke all on function public.remove_shared_room_for_me(text) from anon;
grant execute on function public.remove_shared_room_for_me(text) to authenticated;

-- Rollback guidance (manual):
--   drop table if exists public.shared_room_memberships cascade;
--   drop type if exists public.shared_room_list_item cascade; -- not created, reserved note
--   drop function if exists public.save_shared_room_for_me(text) cascade;
--   drop function if exists public.list_shared_rooms_for_me() cascade;
--   drop function if exists public.touch_shared_room_for_me(text) cascade;
--   drop function if exists public.remove_shared_room_for_me(text) cascade;
--   drop function if exists public.set_shared_room_memberships_updated_at() cascade;
