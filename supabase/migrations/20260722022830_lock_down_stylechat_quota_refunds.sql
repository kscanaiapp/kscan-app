-- P1 repair: StyleChat quota refunds are an Edge Function authority, not a
-- client capability. The original authenticated RPC allowed callers to refund
-- successful requests because clients choose and know their own request IDs.

revoke execute on function public.refund_stylechat_request_quota(text)
  from public, anon, authenticated, service_role;

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
  v_limit   integer := 25;
  v_used    integer;
  v_status  text;
  v_date    date;
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

  select e.status, e.usage_date
    into v_status, v_date
    from public.stylechat_quota_events e
   where e.user_id = p_user_id
     and e.request_id = p_request_id
   for update;

  if v_status is null then
    select u.messages_used
      into v_used
      from public.style_chat_daily_usage u
     where u.user_id = p_user_id
       and u.usage_date = current_date;
    return query
      select coalesce(v_used, 0), v_limit, 'unconsumed'::text, false;
    return;
  end if;

  if v_status = 'refunded' then
    select u.messages_used
      into v_used
      from public.style_chat_daily_usage u
     where u.user_id = p_user_id
       and u.usage_date = v_date;
    return query
      select coalesce(v_used, 0), v_limit, 'refunded'::text, false;
    return;
  end if;

  update public.style_chat_daily_usage
     set messages_used = greatest(messages_used - 1, 0),
         updated_at = now()
   where user_id = p_user_id
     and usage_date = v_date
  returning messages_used into v_used;

  update public.stylechat_quota_events
     set status = 'refunded',
         updated_at = now()
   where user_id = p_user_id
     and request_id = p_request_id
     and status = 'consumed';

  return query
    select coalesce(v_used, 0), v_limit, 'refunded'::text, true;
end;
$$;

revoke execute on function public.refund_stylechat_request_quota_for_user(uuid, text)
  from public, anon, authenticated;
grant execute on function public.refund_stylechat_request_quota_for_user(uuid, text)
  to service_role;

comment on function public.refund_stylechat_request_quota_for_user(uuid, text) is
  'Service-role-only idempotent StyleChat refund invoked after authenticated total provider failure.';
