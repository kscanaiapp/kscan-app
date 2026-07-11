-- AI Stylist expansion: usage quotas for style-outfit-generate.
--
-- MIGRATION SOURCE ONLY — not applied to any remote environment in this build.
--
-- Mirrors the proven StyleChat quota pattern:
--   * Daily successful-generation quota (default 10/user/day, limit passed by
--     the Edge Function so it stays env-configurable).
--   * Per-minute burst quota (default 3 attempts/minute).
-- Both RPCs are SECURITY DEFINER, derive identity from auth.uid(), and are the
-- only write path — no client insert/update/delete policies exist.

create table if not exists public.style_outfit_daily_usage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  usage_date date not null default current_date,
  generations_used integer not null default 0 check (generations_used >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, usage_date)
);

create index if not exists style_outfit_daily_usage_user_date_idx
  on public.style_outfit_daily_usage (user_id, usage_date desc);

alter table public.style_outfit_daily_usage enable row level security;

drop policy if exists "Users read own outfit daily usage" on public.style_outfit_daily_usage;
create policy "Users read own outfit daily usage"
  on public.style_outfit_daily_usage
  for select
  to authenticated
  using (auth.uid() = user_id);

revoke all on public.style_outfit_daily_usage from anon, public;
grant select on public.style_outfit_daily_usage to authenticated;

create table if not exists public.style_outfit_burst_usage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  window_start timestamptz not null,
  attempts integer not null default 0 check (attempts >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, window_start)
);

alter table public.style_outfit_burst_usage enable row level security;
revoke all on public.style_outfit_burst_usage from anon, public;
-- No client access at all; burst rows are managed only by the RPC.

-- ── Atomic daily quota reservation ────────────────────────────────────────────

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

  -- Atomic create-or-reserve: the UPDATE branch only fires while under the limit.
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

-- ── Atomic per-minute burst check ─────────────────────────────────────────────

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

  -- Atomic create-or-increment burst attempt. PostgreSQL serializes on the
  -- (user_id, window_start) unique row, so parallel requests cannot oversubscribe.
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
