-- P1 repair: make request-linked StyleChat quota accounting executable and
-- concurrency-safe. The first implementation used unqualified
-- `messages_used` references inside RETURNS TABLE functions, so PostgreSQL
-- treated the output parameter and table column as ambiguous at runtime.

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
set search_path = ''
as $$
declare
  v_user_id  uuid;
  v_limit    integer := 25;
  v_used     integer;
  v_existing text;
begin
  v_user_id := auth.uid();
  if v_user_id is null then
    raise exception 'Not authenticated';
  end if;

  if p_request_id is null
     or length(trim(p_request_id)) < 8
     or length(trim(p_request_id)) > 160 then
    raise exception 'valid request_id required';
  end if;

  p_request_id := trim(p_request_id);

  -- Serialize the same user/request pair before checking or charging. This
  -- prevents concurrent retries from both incrementing daily usage.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_user_id::text || ':' || p_request_id, 0)
  );

  select e.status
    into v_existing
    from public.stylechat_quota_events as e
   where e.user_id = v_user_id
     and e.request_id = p_request_id;

  if v_existing = 'consumed' then
    select u.messages_used
      into v_used
      from public.style_chat_daily_usage as u
     where u.user_id = v_user_id
       and u.usage_date = current_date;
    return query
      select coalesce(v_used, 0), v_limit, false, 'consumed'::text, false;
    return;
  end if;

  if v_existing = 'refunded' then
    select u.messages_used
      into v_used
      from public.style_chat_daily_usage as u
     where u.user_id = v_user_id
       and u.usage_date = current_date;
    return query
      select coalesce(v_used, 0), v_limit, true, 'refunded'::text, false;
    return;
  end if;

  insert into public.style_chat_daily_usage (user_id, usage_date, messages_used)
    values (v_user_id, current_date, 0)
  on conflict (user_id, usage_date) do nothing;

  update public.style_chat_daily_usage as u
     set messages_used = u.messages_used + 1,
         updated_at = now()
   where u.user_id = v_user_id
     and u.usage_date = current_date
     and u.messages_used < v_limit
  returning u.messages_used into v_used;

  if v_used is null then
    select u.messages_used
      into v_used
      from public.style_chat_daily_usage as u
     where u.user_id = v_user_id
       and u.usage_date = current_date;
    return query
      select coalesce(v_used, 0), v_limit, true, 'unconsumed'::text, false;
    return;
  end if;

  insert into public.stylechat_quota_events (user_id, request_id, usage_date, status)
    values (v_user_id, p_request_id, current_date, 'consumed');

  return query
    select v_used, v_limit, false, 'consumed'::text, true;
end;
$$;

revoke execute on function public.consume_stylechat_request_quota(text)
  from public, anon, service_role;
grant execute on function public.consume_stylechat_request_quota(text)
  to authenticated;

create or replace function public.refund_stylechat_request_quota_for_user(
  p_user_id uuid,
  p_request_id text
)
returns table (
  messages_used   integer,
  messages_limit  integer,
  quota_status    text,
  refunded        boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit  integer := 25;
  v_used   integer;
  v_status text;
  v_date   date;
begin
  if p_user_id is null then
    raise exception 'user_id required';
  end if;

  if p_request_id is null
     or length(trim(p_request_id)) < 8
     or length(trim(p_request_id)) > 160 then
    raise exception 'valid request_id required';
  end if;

  p_request_id := trim(p_request_id);

  -- Use the identical narrow lock identity as consume so a refund cannot race
  -- another operation for this user/request pair. Unrelated users and request
  -- IDs derive independent 64-bit advisory-lock keys.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_user_id::text || ':' || p_request_id, 0)
  );

  select e.status, e.usage_date
    into v_status, v_date
    from public.stylechat_quota_events as e
   where e.user_id = p_user_id
     and e.request_id = p_request_id
   for update;

  if v_status is null then
    select u.messages_used
      into v_used
      from public.style_chat_daily_usage as u
     where u.user_id = p_user_id
       and u.usage_date = current_date;
    return query
      select coalesce(v_used, 0), v_limit, 'unconsumed'::text, false;
    return;
  end if;

  if v_status = 'refunded' then
    select u.messages_used
      into v_used
      from public.style_chat_daily_usage as u
     where u.user_id = p_user_id
       and u.usage_date = v_date;
    return query
      select coalesce(v_used, 0), v_limit, 'refunded'::text, false;
    return;
  end if;

  update public.style_chat_daily_usage as u
     set messages_used = greatest(u.messages_used - 1, 0),
         updated_at = now()
   where u.user_id = p_user_id
     and u.usage_date = v_date
  returning u.messages_used into v_used;

  update public.stylechat_quota_events as e
     set status = 'refunded',
         updated_at = now()
   where e.user_id = p_user_id
     and e.request_id = p_request_id
     and e.status = 'consumed';

  return query
    select coalesce(v_used, 0), v_limit, 'refunded'::text, true;
end;
$$;

revoke execute on function public.refund_stylechat_request_quota_for_user(uuid, text)
  from public, anon, authenticated;
grant execute on function public.refund_stylechat_request_quota_for_user(uuid, text)
  to service_role;

comment on function public.consume_stylechat_request_quota(text) is
  'Authenticated, concurrency-safe, idempotent StyleChat daily quota consumption.';
comment on function public.refund_stylechat_request_quota_for_user(uuid, text) is
  'Service-role-only idempotent StyleChat refund invoked after authenticated total provider failure.';
