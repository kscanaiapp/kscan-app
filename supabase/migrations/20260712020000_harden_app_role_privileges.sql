-- Tighten public-schema application role privileges after the Elise hardening
-- migrations. The earlier restore migration granted the intended CRUD surface
-- to service_role, but a fresh local replay showed Supabase default ACLs still
-- left TRUNCATE, REFERENCES, TRIGGER, and Postgres 17 MAINTAIN on public app
-- tables for app roles.
--
-- Existing migrations are immutable for this audit, so this is a forward-only
-- corrective migration.

grant usage on schema public to service_role;

-- Current app tables: PostgREST clients need table CRUD grants plus RLS, not
-- schema-management privileges.
revoke truncate, references, trigger, maintain on all tables in schema public
  from anon, authenticated, service_role;

-- The app schema uses UUID defaults rather than public sequences. Keep future
-- sequence use explicit instead of inherited.
revoke all privileges on all sequences in schema public
  from anon, authenticated, service_role;

grant select, insert, update, delete on all tables in schema public
  to service_role;

-- Future app objects created by the migration role should not inherit unsafe
-- app-role table or sequence privileges. Service-role clients should inherit
-- only the CRUD surface used by Edge Functions and deletion tooling.
alter default privileges in schema public
  revoke truncate, references, trigger, maintain on tables
  from anon, authenticated, service_role;

alter default privileges in schema public
  revoke all privileges on sequences
  from anon, authenticated, service_role;

alter default privileges in schema public
  grant select, insert, update, delete on tables
  to service_role;

-- Later-ledger safety: 20260711195508 originally introduced this column, but
-- targets that already recorded later July 12 migrations can miss that earlier
-- file unless operators explicitly include it. Keep the latest migration
-- self-healing for the runtime room-share contract.
alter table public.room_shares
  add column if not exists max_redemptions integer not null default 10;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'room_shares_max_redemptions_check'
      and conrelid = 'public.room_shares'::regclass
  ) then
    alter table public.room_shares
      add constraint room_shares_max_redemptions_check
      check (max_redemptions between 1 and 100);
  end if;
end;
$$;

comment on column public.room_shares.max_redemptions is
  'Maximum permitted redemptions for a room share link.';

-- Quota RPCs must not keep accepting requests from actors whose account is
-- already locked or pending deletion. Existing client routing blocks those
-- users, but valid JWTs can outlive the routing transition, so enforce the
-- lifecycle boundary before any counter is consumed.

create or replace function public.increment_stylechat_daily_usage()
returns table (
  messages_used  integer,
  messages_limit integer,
  limit_reached  boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id   uuid;
  v_limit     integer := 25;
  v_used      integer;
  v_hit_limit boolean;
begin
  v_user_id := auth.uid();
  if v_user_id is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  if exists (
    select 1
    from public.profiles p
    where p.id = v_user_id
      and p.account_status in ('pending_deletion', 'locked')
  ) then
    raise exception 'Account is not available for Elise usage' using errcode = '42501';
  end if;

  insert into public.style_chat_daily_usage (user_id, usage_date, messages_used)
    values (v_user_id, current_date, 1)
  on conflict (user_id, usage_date) do update
    set messages_used = style_chat_daily_usage.messages_used + 1,
        updated_at    = now()
    where style_chat_daily_usage.messages_used < v_limit
  returning style_chat_daily_usage.messages_used into v_used;

  if v_used is null then
    select usage_row.messages_used
      into v_used
      from public.style_chat_daily_usage as usage_row
     where usage_row.user_id = v_user_id
       and usage_row.usage_date = current_date;

    v_hit_limit := true;
  else
    v_hit_limit := false;
  end if;

  return query select coalesce(v_used, 0), v_limit, v_hit_limit;
end;
$$;

revoke execute on function public.increment_stylechat_daily_usage() from public;
grant execute on function public.increment_stylechat_daily_usage() to authenticated;

create or replace function public.check_and_increment_stylechat_burst(
  p_limit integer default 4
)
returns table (
  allowed             boolean,
  remaining           integer,
  reset_at            timestamptz,
  retry_after_seconds integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id      uuid;
  v_window_start timestamptz;
  v_count        integer;
  v_limit        integer;
  v_reset_at     timestamptz;
begin
  v_user_id := auth.uid();
  if v_user_id is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  if exists (
    select 1
    from public.profiles p
    where p.id = v_user_id
      and p.account_status in ('pending_deletion', 'locked')
  ) then
    raise exception 'Account is not available for Elise usage' using errcode = '42501';
  end if;

  v_limit        := greatest(1, least(coalesce(p_limit, 4), 60));
  v_window_start := date_trunc('minute', now());
  v_reset_at     := v_window_start + interval '1 minute';

  if random() < 0.01 then
    delete from public.style_chat_burst_usage
    where updated_at < now() - interval '1 day';
  end if;

  insert into public.style_chat_burst_usage (user_id, window_start, request_count, updated_at)
    values (v_user_id, v_window_start, 1, now())
  on conflict (user_id, window_start) do update
    set request_count = style_chat_burst_usage.request_count + 1,
        updated_at    = now()
  returning request_count into v_count;

  return query select
    v_count <= v_limit,
    greatest(0, v_limit - v_count),
    v_reset_at,
    greatest(0, extract(epoch from v_reset_at - now())::integer);
end;
$$;

revoke all on function public.check_and_increment_stylechat_burst(integer) from public;
grant execute on function public.check_and_increment_stylechat_burst(integer) to authenticated;

create or replace function public.increment_style_outfit_daily_usage(p_limit integer default 10)
returns table (
  generations_used integer,
  generations_limit integer,
  limit_reached boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_limit integer := greatest(1, least(coalesce(p_limit, 10), 100));
  v_used integer;
  v_hit_limit boolean;
begin
  if v_user_id is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  if exists (
    select 1
    from public.profiles p
    where p.id = v_user_id
      and p.account_status in ('pending_deletion', 'locked')
  ) then
    raise exception 'Account is not available for Elise usage' using errcode = '42501';
  end if;

  insert into public.style_outfit_daily_usage (user_id, usage_date, generations_used)
    values (v_user_id, current_date, 1)
  on conflict (user_id, usage_date) do update
    set generations_used = style_outfit_daily_usage.generations_used + 1,
        updated_at = now()
    where style_outfit_daily_usage.generations_used < v_limit
  returning style_outfit_daily_usage.generations_used into v_used;

  if v_used is null then
    select u.generations_used into v_used
      from public.style_outfit_daily_usage u
     where u.user_id = v_user_id
       and u.usage_date = current_date;
    v_hit_limit := true;
  else
    v_hit_limit := false;
  end if;

  return query select coalesce(v_used, 0), v_limit, v_hit_limit;
end;
$$;

revoke all on function public.increment_style_outfit_daily_usage(integer) from public;
revoke all on function public.increment_style_outfit_daily_usage(integer) from anon;
grant execute on function public.increment_style_outfit_daily_usage(integer) to authenticated;

create or replace function public.check_and_increment_style_outfit_burst(p_limit integer default 3)
returns table (
  allowed boolean,
  retry_after_seconds integer,
  reset_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_limit integer := greatest(1, least(coalesce(p_limit, 3), 60));
  v_window timestamptz := date_trunc('minute', now());
  v_attempts integer;
begin
  if v_user_id is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  if exists (
    select 1
    from public.profiles p
    where p.id = v_user_id
      and p.account_status in ('pending_deletion', 'locked')
  ) then
    raise exception 'Account is not available for Elise usage' using errcode = '42501';
  end if;

  insert into public.style_outfit_burst_usage (user_id, window_start, attempts)
    values (v_user_id, v_window, 1)
  on conflict (user_id, window_start) do update
    set attempts = style_outfit_burst_usage.attempts + 1,
        updated_at = now()
    where style_outfit_burst_usage.attempts < v_limit
  returning style_outfit_burst_usage.attempts into v_attempts;

  if v_attempts is null then
    return query select
      false,
      greatest(1, extract(epoch from (v_window + interval '1 minute' - now()))::integer),
      v_window + interval '1 minute';
  else
    return query select true, 0, v_window + interval '1 minute';
  end if;
end;
$$;

revoke all on function public.check_and_increment_style_outfit_burst(integer) from public;
revoke all on function public.check_and_increment_style_outfit_burst(integer) from anon;
grant execute on function public.check_and_increment_style_outfit_burst(integer) to authenticated;

-- Enforce room-share redemption limits at the actual join RPC. The
-- max_redemptions column existed, but the runtime join function did not read
-- it. Lock the share row so concurrent joiners cannot oversubscribe the link.
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

  if coalesce(target_max_redemptions, 0) <= 0 then
    raise exception 'Shared room is unavailable' using errcode = '42501';
  end if;

  select count(*)
  into current_redemptions
  from public.dressing_room_participants p
  where p.joined_via_share_id = target_share_id;

  if current_redemptions >= target_max_redemptions then
    raise exception 'Shared room is full' using errcode = '42501';
  end if;

  insert into public.dressing_room_participants (dressing_room_id, user_id, role, joined_via_share_id)
  values (target_room_id, current_user_id, 'participant', target_share_id);

  return target_room_id;
end;
$$;

revoke all on function public.join_room_via_share_token(text) from public;
revoke all on function public.join_room_via_share_token(text) from anon;
grant execute on function public.join_room_via_share_token(text) to authenticated;
