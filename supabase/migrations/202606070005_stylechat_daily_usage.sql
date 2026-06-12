-- StyleChat v0.4: daily usage tracking for beta AI cap enforcement.
-- Forward-only migration. Do not edit.
-- Separate from style_chat_usage (monthly) to avoid period_start conflicts.

-- ── Daily usage table ─────────────────────────────────────────────────────────

create table public.style_chat_daily_usage (
  id            uuid        primary key default gen_random_uuid(),
  user_id       uuid        not null references auth.users(id) on delete cascade,
  usage_date    date        not null default current_date,
  messages_used integer     not null default 0 check (messages_used >= 0),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (user_id, usage_date)
);

create index style_chat_daily_usage_user_date
  on public.style_chat_daily_usage (user_id, usage_date desc);

alter table public.style_chat_daily_usage enable row level security;

-- Users may read their own daily usage for display purposes.
-- All writes go through the SECURITY DEFINER RPC — no direct client writes.
create policy "Users read own daily usage"
  on public.style_chat_daily_usage
  for select
  using (auth.uid() = user_id);

-- ── Atomic daily quota reservation RPC ────────────────────────────────────────
-- SECURITY DEFINER runs as function owner, bypasses RLS for writes,
-- but enforces auth.uid() so a caller can only increment their own row.
-- Quota is enforced atomically: the UPDATE only succeeds if messages_used < limit.
-- Returns (messages_used, messages_limit, limit_reached).

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
  v_user_id      uuid;
  v_limit        integer := 25;
  v_used         integer;
  v_hit_limit    boolean;
begin
  v_user_id := auth.uid();
  if v_user_id is null then
    raise exception 'Not authenticated';
  end if;

  -- Ensure today's row exists with 0 count (no-op if already present).
  insert into public.style_chat_daily_usage (user_id, usage_date, messages_used)
    values (v_user_id, current_date, 0)
  on conflict (user_id, usage_date) do nothing;

  -- Atomically reserve a slot only if under the daily limit.
  update public.style_chat_daily_usage
    set messages_used = messages_used + 1,
        updated_at    = now()
    where user_id   = v_user_id
      and usage_date = current_date
      and messages_used < v_limit
  returning messages_used into v_used;

  if v_used is null then
    -- Quota already exhausted — read the current count without incrementing.
    select u.messages_used into v_used
      from public.style_chat_daily_usage u
     where u.user_id   = v_user_id
       and u.usage_date = current_date;

    v_hit_limit := true;
  else
    v_hit_limit := false;
  end if;

  return query select v_used, v_limit, v_hit_limit;
end;
$$;

revoke execute on function public.increment_stylechat_daily_usage() from public;
grant  execute on function public.increment_stylechat_daily_usage() to authenticated;

-- ── Read-only helper RPC (optional — mobile can query table directly via RLS) ──

create or replace function public.get_stylechat_daily_usage()
returns table (
  messages_used  integer,
  messages_limit integer,
  reset_at       timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_used    integer;
  v_limit   integer := 25;
begin
  v_user_id := auth.uid();
  if v_user_id is null then
    raise exception 'Not authenticated';
  end if;

  select u.messages_used into v_used
    from public.style_chat_daily_usage u
   where u.user_id   = v_user_id
     and u.usage_date = current_date;

  return query select
    coalesce(v_used, 0),
    v_limit,
    (current_date + interval '1 day')::timestamptz;
end;
$$;

revoke execute on function public.get_stylechat_daily_usage() from public;
grant  execute on function public.get_stylechat_daily_usage() to authenticated;
