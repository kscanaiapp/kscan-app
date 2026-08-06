-- Elise backend foundation repair: generation identity and quota idempotency.
-- Additive only. Do not apply to production from this task.

alter table public.style_chat_messages
  add column if not exists source_message_id uuid
  references public.style_chat_messages(id) on delete set null;

create unique index if not exists style_chat_assistant_source_message_unique
  on public.style_chat_messages (user_id, session_id, sender, source_message_id)
  where sender = 'assistant' and source_message_id is not null;

create table if not exists public.elise_generation_operations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid references public.style_chat_sessions(id) on delete cascade,
  source_message_id uuid references public.style_chat_messages(id) on delete set null,
  operation_type text not null,
  operation_key text not null,
  status text not null default 'reserved'
    check (status in ('reserved', 'completed', 'failed')),
  quota_counted boolean not null default false,
  request_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, operation_key)
);

create index if not exists elise_generation_operations_user_created_idx
  on public.elise_generation_operations (user_id, created_at desc);

alter table public.elise_generation_operations enable row level security;

create policy "Users read own Elise generation operations"
  on public.elise_generation_operations
  for select
  using (auth.uid() = user_id);

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
       and op.operation_key = v_operation_key;

    select usage_row.messages_used
      into v_used
      from public.style_chat_daily_usage as usage_row
     where usage_row.user_id = v_user_id
       and usage_row.usage_date = current_date;

    return query select
      coalesce(v_used, 0),
      v_limit,
      coalesce(v_existing_status = 'failed' and not v_existing_quota_counted, false),
      true;
    return;
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
       and operation_key = v_operation_key;

    return query select coalesce(v_used, 0), v_limit, true, false;
    return;
  end if;

  update public.elise_generation_operations
     set quota_counted = true,
         updated_at = now()
   where user_id = v_user_id
     and operation_key = v_operation_key;

  return query select v_used, v_limit, false, false;
end;
$$;

revoke all on function public.increment_stylechat_daily_usage_idempotent(text) from public;
grant execute on function public.increment_stylechat_daily_usage_idempotent(text) to authenticated;
