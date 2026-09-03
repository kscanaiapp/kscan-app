-- Build 34 / K+ Smart Watchlist V1 -- K5-C6: general push-token infrastructure.
--
-- The first notification producer this codebase has ever had (C0 audit §42:
-- no expo-notifications dependency, no plugin, no token table, no
-- preferences anywhere in source). Named and scoped generally on purpose
-- (master build brief §53: "user_device_push_tokens", not
-- "watchlist_push_tokens") -- Watchlist is the first CONSUMER of this
-- infrastructure, not its owner. Scope stays narrow: registration,
-- revocation, and the current actor association. No notification center,
-- no per-category preferences beyond the one column Watchlist itself needs
-- (push_enabled on the Watch row -- see 20260830150000_user_commerce_watches.sql
-- and its companion migration below).

create table if not exists public.user_device_push_tokens (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  push_token    text not null,
  platform      text not null,
  device_id     text not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz,

  constraint user_device_push_tokens_push_token_len check (char_length(push_token) between 1 and 400),
  constraint user_device_push_tokens_platform_enum check (platform in ('ios', 'android')),
  constraint user_device_push_tokens_device_id_len check (char_length(device_id) between 1 and 200)
);

comment on table public.user_device_push_tokens is
  'Build 34 K5-C6. General device push-token registry -- Watchlist is the first consumer, not the owner. One row per (user, device); re-registering the same device updates the existing row rather than creating a duplicate.';
comment on column public.user_device_push_tokens.device_id is
  'A stable per-installation identifier the client already has (e.g. expo-application installationId), NOT the push token itself -- the push token can rotate while the device identity does not, and this is what the unique index dedupes on.';
comment on column public.user_device_push_tokens.revoked_at is
  'Set when the OS reports the token invalid (delivery receipt error) or the user disables notifications. A revoked token is never selected for delivery but the row is kept for audit rather than deleted.';

create unique index if not exists user_device_push_tokens_user_device_uidx
  on public.user_device_push_tokens (user_id, device_id);

create index if not exists user_device_push_tokens_deliverable_idx
  on public.user_device_push_tokens (user_id)
  where revoked_at is null;

alter table public.user_device_push_tokens enable row level security;

drop policy if exists "select own device push tokens" on public.user_device_push_tokens;
create policy "select own device push tokens"
  on public.user_device_push_tokens
  for select
  to authenticated
  using (user_id = auth.uid());

-- No client INSERT/UPDATE/DELETE: registration and revocation both go
-- through the RPCs below, consistent with every other Watchlist-adjacent
-- write in this feature (server re-stamps identity; the client never
-- supplies a user id).
revoke all on public.user_device_push_tokens from anon, authenticated, public;
grant select on public.user_device_push_tokens to authenticated;
grant select, insert, update, delete on public.user_device_push_tokens to service_role;
revoke truncate, references, trigger, maintain on public.user_device_push_tokens
  from anon, authenticated, service_role;

create or replace function public.register_device_push_token(
  p_user_id uuid,
  p_push_token text,
  p_platform text,
  p_device_id text
)
returns public.user_device_push_tokens
language plpgsql
security definer
set search_path = public
as $$
declare
  row_out public.user_device_push_tokens;
begin
  if p_user_id is null then
    raise exception 'user_id required' using errcode = '23502';
  end if;

  insert into public.user_device_push_tokens (user_id, push_token, platform, device_id, last_used_at)
  values (p_user_id, p_push_token, p_platform, p_device_id, now())
  on conflict (user_id, device_id) do update
    set push_token = excluded.push_token,
        platform = excluded.platform,
        revoked_at = null,
        last_used_at = now(),
        updated_at = now()
  returning * into row_out;

  return row_out;
end;
$$;

revoke all on function public.register_device_push_token(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.register_device_push_token(uuid, text, text, text) to service_role;

create or replace function public.revoke_device_push_token(p_user_id uuid, p_device_id text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  affected int;
begin
  update public.user_device_push_tokens
  set revoked_at = now(), updated_at = now()
  where user_id = p_user_id and device_id = p_device_id and revoked_at is null;
  get diagnostics affected = row_count;
  return affected > 0;
end;
$$;

revoke all on function public.revoke_device_push_token(uuid, text) from public, anon, authenticated;
grant execute on function public.revoke_device_push_token(uuid, text) to service_role;
