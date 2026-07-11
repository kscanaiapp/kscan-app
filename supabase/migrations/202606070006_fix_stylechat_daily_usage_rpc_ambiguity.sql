-- StyleChat v0.4: fix ambiguous output-column references in daily usage RPC.

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
    raise exception 'Not authenticated';
  end if;

  -- Atomically create-or-reserve a slot in one statement. PostgreSQL serializes
  -- conflicting updates on the (user_id, usage_date) unique row, so parallel
  -- callers cannot both observe messages_used < v_limit and increment.
  insert into public.style_chat_daily_usage (user_id, usage_date, messages_used)
    values (v_user_id, current_date, 1)
  on conflict (user_id, usage_date) do update
    set messages_used = style_chat_daily_usage.messages_used + 1,
        updated_at    = now()
    where style_chat_daily_usage.messages_used < v_limit
  returning style_chat_daily_usage.messages_used into v_used;

  if v_used is null then
    -- Quota already exhausted — read the current count without incrementing.
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
