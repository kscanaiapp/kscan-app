-- Step 2B: request-linked StyleChat quota consume/refund.
-- Extends daily usage with idempotent per-request events.
-- Forward-only. Does not change the 25/day entitlement amount.

create table if not exists public.stylechat_quota_events (
  id           uuid        primary key default gen_random_uuid(),
  user_id      uuid        not null references auth.users(id) on delete cascade,
  request_id   text        not null,
  usage_date   date        not null default current_date,
  status       text        not null check (status in ('consumed', 'refunded')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (user_id, request_id)
);

create index if not exists stylechat_quota_events_user_date
  on public.stylechat_quota_events (user_id, usage_date desc);

alter table public.stylechat_quota_events enable row level security;

-- No direct client access; RPCs are the only write path.
revoke all on table public.stylechat_quota_events from public, anon, authenticated;
grant select on table public.stylechat_quota_events to service_role;

-- ── Consume exactly one unit for a request (idempotent) ───────────────────────
create or replace function public.consume_stylechat_request_quota(p_request_id text)
returns table (
  messages_used  integer,
  messages_limit integer,
  limit_reached  boolean,
  quota_status   text,
  charged        boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id   uuid;
  v_limit     integer := 25;
  v_used      integer;
  v_existing  text;
begin
  v_user_id := auth.uid();
  if v_user_id is null then
    raise exception 'Not authenticated';
  end if;

  if p_request_id is null or length(trim(p_request_id)) < 8 then
    raise exception 'request_id required';
  end if;

  -- Idempotent replay of an already-consumed request: no second charge.
  select e.status into v_existing
    from public.stylechat_quota_events e
   where e.user_id = v_user_id
     and e.request_id = trim(p_request_id);

  if v_existing = 'consumed' then
    select u.messages_used into v_used
      from public.style_chat_daily_usage u
     where u.user_id = v_user_id
       and u.usage_date = current_date;
    return query select coalesce(v_used, 0), v_limit, false, 'consumed'::text, false;
    return;
  end if;

  -- Refunded requests must not be re-consumed under the same request_id.
  if v_existing = 'refunded' then
    select u.messages_used into v_used
      from public.style_chat_daily_usage u
     where u.user_id = v_user_id
       and u.usage_date = current_date;
    return query select coalesce(v_used, 0), v_limit, true, 'refunded'::text, false;
    return;
  end if;

  insert into public.style_chat_daily_usage (user_id, usage_date, messages_used)
    values (v_user_id, current_date, 0)
  on conflict (user_id, usage_date) do nothing;

  update public.style_chat_daily_usage
    set messages_used = messages_used + 1,
        updated_at    = now()
    where user_id = v_user_id
      and usage_date = current_date
      and messages_used < v_limit
  returning messages_used into v_used;

  if v_used is null then
    select u.messages_used into v_used
      from public.style_chat_daily_usage u
     where u.user_id = v_user_id
       and u.usage_date = current_date;
    return query select coalesce(v_used, 0), v_limit, true, 'unconsumed'::text, false;
    return;
  end if;

  insert into public.stylechat_quota_events (user_id, request_id, usage_date, status)
    values (v_user_id, trim(p_request_id), current_date, 'consumed');

  return query select v_used, v_limit, false, 'consumed'::text, true;
end;
$$;

revoke execute on function public.consume_stylechat_request_quota(text) from public;
grant execute on function public.consume_stylechat_request_quota(text) to authenticated;

-- ── Refund exactly once for a consumed request ────────────────────────────────
create or replace function public.refund_stylechat_request_quota(p_request_id text)
returns table (
  messages_used   integer,
  messages_limit  integer,
  quota_status    text,
  refunded        boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id  uuid;
  v_limit    integer := 25;
  v_used     integer;
  v_status   text;
  v_date     date;
begin
  v_user_id := auth.uid();
  if v_user_id is null then
    raise exception 'Not authenticated';
  end if;

  if p_request_id is null or length(trim(p_request_id)) < 8 then
    raise exception 'request_id required';
  end if;

  select e.status, e.usage_date into v_status, v_date
    from public.stylechat_quota_events e
   where e.user_id = v_user_id
     and e.request_id = trim(p_request_id)
   for update;

  if v_status is null then
    -- Never consumed → cannot refund.
    select u.messages_used into v_used
      from public.style_chat_daily_usage u
     where u.user_id = v_user_id
       and u.usage_date = current_date;
    return query select coalesce(v_used, 0), v_limit, 'unconsumed'::text, false;
    return;
  end if;

  if v_status = 'refunded' then
    select u.messages_used into v_used
      from public.style_chat_daily_usage u
     where u.user_id = v_user_id
       and u.usage_date = v_date;
    return query select coalesce(v_used, 0), v_limit, 'refunded'::text, false;
    return;
  end if;

  update public.style_chat_daily_usage
    set messages_used = greatest(messages_used - 1, 0),
        updated_at    = now()
    where user_id = v_user_id
      and usage_date = v_date
  returning messages_used into v_used;

  update public.stylechat_quota_events
    set status = 'refunded',
        updated_at = now()
    where user_id = v_user_id
      and request_id = trim(p_request_id)
      and status = 'consumed';

  return query select coalesce(v_used, 0), v_limit, 'refunded'::text, true;
end;
$$;

revoke execute on function public.refund_stylechat_request_quota(text) from public;
grant execute on function public.refund_stylechat_request_quota(text) to authenticated;
