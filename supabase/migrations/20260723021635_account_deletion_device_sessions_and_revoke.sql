create table if not exists public.user_device_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  device_key text not null,
  platform text not null
    check (platform in ('phone', 'tablet', 'desktop', 'smart_glasses', 'watch', 'other')),
  label text null,
  auth_session_id uuid null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz null,
  unique (user_id, device_key)
);
create index if not exists user_device_sessions_user_active_idx on public.user_device_sessions (user_id, last_seen_at desc) where revoked_at is null;
alter table public.user_device_sessions enable row level security;
revoke all on public.user_device_sessions from anon, authenticated;
grant select, insert, update on public.user_device_sessions to authenticated;
grant all on public.user_device_sessions to service_role;
drop policy if exists "Users manage own device sessions" on public.user_device_sessions;
create policy "Users manage own device sessions" on public.user_device_sessions for all to authenticated using (user_id = auth.uid() and public.is_active_account()) with check (user_id = auth.uid() and public.is_active_account());

create or replace function public.register_user_device_session(p_device_key text, p_platform text, p_label text default null, p_auth_session_id uuid default null) returns public.user_device_sessions language plpgsql security definer set search_path = public as $$
declare v_user_id uuid := auth.uid(); v_row public.user_device_sessions; v_active_count integer;
begin
  if v_user_id is null then raise exception 'not authenticated'; end if;
  if p_device_key is null or length(trim(p_device_key)) < 4 then raise exception 'invalid device key'; end if;
  if p_platform not in ('phone', 'tablet', 'desktop', 'smart_glasses', 'watch', 'other') then raise exception 'invalid platform'; end if;
  if not public.is_active_account() then raise exception 'account deactivated'; end if;
  insert into public.user_device_sessions as uds (user_id, device_key, platform, label, auth_session_id, last_seen_at, revoked_at)
  values (v_user_id, trim(p_device_key), p_platform, p_label, p_auth_session_id, now(), null)
  on conflict (user_id, device_key) do update set platform = excluded.platform, label = coalesce(excluded.label, uds.label), auth_session_id = coalesce(excluded.auth_session_id, uds.auth_session_id), last_seen_at = now(), revoked_at = null returning * into v_row;
  select count(*)::int into v_active_count from public.user_device_sessions where user_id = v_user_id and revoked_at is null;
  if v_active_count > 5 then update public.user_device_sessions set revoked_at = now() where id in (select id from public.user_device_sessions where user_id = v_user_id and revoked_at is null order by last_seen_at asc offset 5); end if;
  return v_row;
end; $$;
revoke all on function public.register_user_device_session(text, text, text, uuid) from public;
grant execute on function public.register_user_device_session(text, text, text, uuid) to authenticated, service_role;

create or replace function public.revoke_user_device_sessions(p_user_id uuid) returns integer language plpgsql security definer set search_path = public as $$
declare v_count integer; begin if p_user_id is null then return 0; end if; update public.user_device_sessions set revoked_at = now() where user_id = p_user_id and revoked_at is null; get diagnostics v_count = row_count; return v_count; end; $$;
revoke all on function public.revoke_user_device_sessions(uuid) from public;
grant execute on function public.revoke_user_device_sessions(uuid) to service_role;

drop function if exists public.revoke_user_sessions(uuid);
create function public.revoke_user_sessions(p_user_id uuid) returns void language plpgsql security definer set search_path = public, auth as $$ begin if p_user_id is null then return; end if; delete from auth.refresh_tokens where user_id = p_user_id; delete from auth.sessions where user_id = p_user_id; perform public.revoke_user_device_sessions(p_user_id); end; $$;
revoke all on function public.revoke_user_sessions(uuid) from public;
grant execute on function public.revoke_user_sessions(uuid) to service_role;
