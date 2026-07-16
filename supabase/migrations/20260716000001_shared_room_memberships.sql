-- Shared Dressing Room memberships v1 - account-anchored "Shared with Me" backend.
--
-- The authoritative relationship is:
--   shared_room_memberships -> room_shares -> dressing_rooms -> owner
--
-- This state is deliberately separate from dressing_room_participants. Saving
-- a room provides account-scoped discovery only; it does not join messaging,
-- grant participant access, or consume room_shares.max_redemptions. The latter
-- remains the collaboration-participant cap enforced by
-- join_room_via_share_token().

-- Production has these two redemption-path indexes, but their creation is
-- absent from the historical migration ledger. Converge clean replays with the
-- verified live schema before adding the new membership table.
create index if not exists dressing_room_participants_joined_via_share_id_idx
  on public.dressing_room_participants (joined_via_share_id);

create index if not exists dressing_room_participants_share_user_idx
  on public.dressing_room_participants (joined_via_share_id, user_id);

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
  'Recipient-private Shared with Me discovery state. It neither grants room/message access nor consumes participant redemptions.';
comment on column public.shared_room_memberships.share_id is
  'Authoritative share row. Share deletion, including original-owner account deletion after room transfer, cascades this recipient-private state.';
comment on column public.shared_room_memberships.removed_at is
  'Recipient soft-removal time. Reopening the same still-active share clears this value after server-side token validation.';

create index if not exists shared_room_memberships_recipient_idx
  on public.shared_room_memberships (recipient_user_id);

create index if not exists shared_room_memberships_recipient_active_idx
  on public.shared_room_memberships (recipient_user_id, last_accessed_at desc, share_id)
  where removed_at is null;

create index if not exists shared_room_memberships_share_idx
  on public.shared_room_memberships (share_id);

-- RPC-only client architecture. Keep recipient-only RLS as defense in depth,
-- but expose no direct table operation to authenticated clients.
alter table public.shared_room_memberships enable row level security;

revoke all on table public.shared_room_memberships
  from public, anon, authenticated;

grant select, insert, update, delete on table public.shared_room_memberships
  to service_role;

revoke truncate, references, trigger, maintain on table public.shared_room_memberships
  from anon, authenticated, service_role;

drop policy if exists "Recipients can select own shared room memberships"
  on public.shared_room_memberships;
drop policy if exists "Recipients can insert own shared room memberships"
  on public.shared_room_memberships;
drop policy if exists "Recipients can update own shared room memberships"
  on public.shared_room_memberships;

create policy "Recipients can select own shared room memberships"
  on public.shared_room_memberships
  for select
  to authenticated
  using (
    (select auth.uid()) is not null
    and recipient_user_id = (select auth.uid())
  );

-- A trigger function needs no elevated privileges and is not a client RPC.
create or replace function public.set_shared_room_memberships_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $$
begin
  new.updated_at = clock_timestamp();
  return new;
end;
$$;

revoke all on function public.set_shared_room_memberships_updated_at()
  from public, anon, authenticated, service_role;

drop trigger if exists shared_room_memberships_updated_at
  on public.shared_room_memberships;
create trigger shared_room_memberships_updated_at
  before update on public.shared_room_memberships
  for each row
  execute function public.set_shared_room_memberships_updated_at();

-- Save or restore one recipient membership after validating the canonical
-- active share. Locking the share serializes save against revocation and makes
-- the saved/already_saved/restored distinction deterministic across devices.
create or replace function public.save_shared_room_for_me(p_share_token text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
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
$$;

revoke all on function public.save_shared_room_for_me(text)
  from public, anon, authenticated, service_role;
grant execute on function public.save_shared_room_for_me(text)
  to authenticated;

-- Return a bounded, account-scoped list. Revoked, expired, and ownership-stale
-- shares remain as sanitized unavailable rows so recipients can remove them;
-- room/share deletion cascades memberships, so deleted entries disappear.
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
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
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
$$;

revoke all on function public.list_shared_rooms_for_me()
  from public, anon, authenticated, service_role;
grant execute on function public.list_shared_rooms_for_me()
  to authenticated;

create or replace function public.touch_shared_room_for_me(p_share_token text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
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
  from public.room_shares as rs
  join public.dressing_rooms as dr
    on dr.id = rs.room_id
   and dr.user_id = rs.owner_id
  where rs.share_token = normalized_token
    and rs.access_level = 'view'
    and rs.is_active = true
    and rs.revoked_at is null
    and (rs.expires_at is null or rs.expires_at > now())
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
$$;

revoke all on function public.touch_shared_room_for_me(text)
  from public, anon, authenticated, service_role;
grant execute on function public.touch_shared_room_for_me(text)
  to authenticated;

-- Removal is intentionally independent of share activity. It also returns the
-- same sanitized result for absent rows and unknown well-formed tokens, so it
-- cannot be used to enumerate shares or another recipient's membership.
create or replace function public.remove_shared_room_for_me(p_share_token text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  current_user_id uuid := auth.uid();
  normalized_token text;
begin
  if current_user_id is null then
    return jsonb_build_object('status', 'unauthenticated');
  end if;

  normalized_token := nullif(btrim(coalesce(p_share_token, '')), '');
  if normalized_token is null or normalized_token !~ '^[A-Za-z0-9_-]+$' then
    return jsonb_build_object('status', 'malformed');
  end if;

  update public.shared_room_memberships as srm
  set removed_at = clock_timestamp()
  where srm.recipient_user_id = current_user_id
    and srm.removed_at is null
    and srm.share_id = (
      select rs.id
      from public.room_shares as rs
      where rs.share_token = normalized_token
      limit 1
    );

  return jsonb_build_object('status', 'removed');
end;
$$;

revoke all on function public.remove_shared_room_for_me(text)
  from public, anon, authenticated, service_role;
grant execute on function public.remove_shared_room_for_me(text)
  to authenticated;

-- Rollback guidance (manual, reverse dependency order):
--   drop function if exists public.save_shared_room_for_me(text) cascade;
--   drop function if exists public.list_shared_rooms_for_me() cascade;
--   drop function if exists public.touch_shared_room_for_me(text) cascade;
--   drop function if exists public.remove_shared_room_for_me(text) cascade;
--   drop trigger if exists shared_room_memberships_updated_at on public.shared_room_memberships;
--   drop function if exists public.set_shared_room_memberships_updated_at() cascade;
--   drop table if exists public.shared_room_memberships cascade;
