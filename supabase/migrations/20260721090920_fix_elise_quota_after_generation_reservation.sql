-- Fix Elise quota idempotency after E-2 operation reservation.
--
-- E-2 reserves an elise_generation_operations row before quota reservation so
-- duplicate generation requests can recover or fail closed before provider work.
-- The original quota idempotency RPC treated any existing operation row as a
-- duplicate, which meant the first fully-upgraded request could avoid the daily
-- message charge. This forward migration preserves duplicate safety while
-- charging exactly once when the existing row is an uncounted active reservation.

create or replace function public.increment_stylechat_daily_usage_idempotent(
  p_operation_key text
)
returns table (
  messages_used integer,
  messages_limit integer,
  limit_reached boolean,
  duplicate_request boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_limit integer := 25;
  v_used integer;
  v_operation_key text;
  v_duplicate boolean := false;
  v_reserved boolean := false;
  v_row_count integer := 0;
  v_existing_status text;
  v_existing_quota_counted boolean;
begin
  v_user_id := auth.uid();
  if v_user_id is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  v_operation_key := nullif(btrim(p_operation_key), '');
  if v_operation_key is null or length(v_operation_key) > 512 then
    raise exception 'Invalid Elise generation operation key' using errcode = '22023';
  end if;

  insert into public.elise_generation_operations (
    user_id,
    operation_type,
    operation_key,
    quota_counted
  )
  values (
    v_user_id,
    'stylechat_generate_reply',
    v_operation_key,
    false
  )
  on conflict (user_id, operation_key) do nothing;

  get diagnostics v_row_count = row_count;
  v_reserved := v_row_count > 0;
  v_duplicate := not v_reserved;

  if v_duplicate then
    select op.status,
           op.quota_counted
      into v_existing_status,
           v_existing_quota_counted
      from public.elise_generation_operations as op
     where op.user_id = v_user_id
       and op.operation_key = v_operation_key
     for update;

    select usage_row.messages_used
      into v_used
      from public.style_chat_daily_usage as usage_row
     where usage_row.user_id = v_user_id
       and usage_row.usage_date = current_date;

    if v_existing_quota_counted then
      return query select coalesce(v_used, 0), v_limit, false, true;
      return;
    end if;

    -- A previous quota attempt may have failed before counting. Preserve that
    -- terminal quota outcome instead of reopening charges on repeated retries.
    if v_existing_status = 'failed' and not v_existing_quota_counted then
      return query select coalesce(v_used, 0), v_limit, true, true;
      return;
    end if;

    -- This is the first quota reservation for an operation row that E-2
    -- deliberately created before quota. It should charge once and should not
    -- be reported as a quota duplicate.
    v_duplicate := false;
  end if;

  insert into public.style_chat_daily_usage (user_id, usage_date, messages_used)
    values (v_user_id, current_date, 1)
  on conflict (user_id, usage_date) do update
    set messages_used = style_chat_daily_usage.messages_used + 1,
        updated_at = now()
    where style_chat_daily_usage.messages_used < v_limit
  returning style_chat_daily_usage.messages_used into v_used;

  if v_used is null then
    select usage_row.messages_used
      into v_used
      from public.style_chat_daily_usage as usage_row
     where usage_row.user_id = v_user_id
       and usage_row.usage_date = current_date;

    update public.elise_generation_operations
       set status = 'failed',
           updated_at = now()
     where user_id = v_user_id
       and operation_key = v_operation_key
       and quota_counted = false;

    return query select coalesce(v_used, 0), v_limit, true, v_duplicate;
    return;
  end if;

  update public.elise_generation_operations
     set quota_counted = true,
         updated_at = now()
   where user_id = v_user_id
     and operation_key = v_operation_key;

  return query select v_used, v_limit, false, v_duplicate;
end;
$$;

revoke all on function public.increment_stylechat_daily_usage_idempotent(text) from public;
grant execute on function public.increment_stylechat_daily_usage_idempotent(text) to authenticated;

drop policy if exists "Users read own Elise generation operations"
  on public.elise_generation_operations;

create policy "Users read own Elise generation operations"
  on public.elise_generation_operations
  for select
  to authenticated
  using ((select auth.uid()) = user_id);
