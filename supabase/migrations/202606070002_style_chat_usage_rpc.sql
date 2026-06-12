-- Atomic usage increment RPC for StyleChat.
-- SECURITY DEFINER runs as function owner, bypasses RLS internally,
-- but enforces auth.uid() so a caller can only increment their own row.
-- Mirrors the existing create_or_get_room_share / get_item_reaction_counts RPC pattern.

create or replace function public.increment_style_chat_usage()
returns table (
  messages_used   integer,
  messages_limit  integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id       uuid;
  v_period_start  date;
  v_period_end    date;
  v_messages_used integer;
  v_limit         integer := 50;
begin
  v_user_id := auth.uid();
  if v_user_id is null then
    raise exception 'Not authenticated';
  end if;

  v_period_start := date_trunc('month', current_date)::date;
  v_period_end   := (date_trunc('month', current_date) + interval '1 month - 1 day')::date;

  insert into public.style_chat_usage (user_id, period_start, period_end, messages_used, llm_calls_used)
    values (v_user_id, v_period_start, v_period_end, 1, 0)
  on conflict (user_id, period_start)
  do update set messages_used = public.style_chat_usage.messages_used + 1;

  select u.messages_used into v_messages_used
  from public.style_chat_usage u
  where u.user_id = v_user_id and u.period_start = v_period_start;

  return query select v_messages_used, v_limit;
end;
$$;

revoke execute on function public.increment_style_chat_usage() from public;
grant  execute on function public.increment_style_chat_usage() to authenticated;
