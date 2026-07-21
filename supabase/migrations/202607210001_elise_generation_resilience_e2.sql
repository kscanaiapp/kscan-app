-- E-2 forward migration: generation resilience operation lifecycle.
-- Additive only. Builds on 202607200001_elise_generation_quota_idempotency.sql.
-- Do not apply to production from this task.
--
-- Purpose:
--   Expand the Elise generation operation ledger with explicit lifecycle states,
--   attempt tracking, assistant-message binding, and atomic reserve/finalize RPCs.
-- Operation identity:
--   Preferred unique key when source_message_id is present:
--     (user_id, session_id, source_message_id, operation_type)
--   Legacy operation_key uniqueness (user_id, operation_key) remains.
-- Quota semantics:
--   Message quota remains owned by increment_stylechat_daily_usage_idempotent.
--   Provider retries within one operation do not create a second message charge.
-- Retry semantics:
--   failed_retryable may be reopened once by reserve RPC when attempt_count < max.
-- Security boundary:
--   auth.uid() required; session and source message must belong to the actor.
--   SECURITY DEFINER with fixed search_path; public execute revoked.
-- Rollback strategy:
--   Disable ELISE_GENERATION_SAFETY_V1_ENABLED / ELISE_QUOTA_IDEMPOTENCY_V1_ENABLED.
--   New columns and RPCs are additive; dropping them is a separate forward migration.

-- Expand status vocabulary (replace narrow check).
alter table public.elise_generation_operations
  drop constraint if exists elise_generation_operations_status_check;

alter table public.elise_generation_operations
  add constraint elise_generation_operations_status_check
  check (status in (
    'reserved',
    'generating',
    'completed',
    'failed_retryable',
    'failed_terminal',
    'cancelled',
    'stale',
    'failed'
  ));

alter table public.elise_generation_operations
  add column if not exists attempt_count integer not null default 1;

alter table public.elise_generation_operations
  add column if not exists assistant_message_id uuid
  references public.style_chat_messages(id) on delete set null;

alter table public.elise_generation_operations
  add column if not exists provider_started_at timestamptz;

alter table public.elise_generation_operations
  add column if not exists completed_at timestamptz;

alter table public.elise_generation_operations
  add column if not exists stable_error_class text;

alter table public.elise_generation_operations
  add column if not exists max_attempts integer not null default 2;

-- Preferred durable uniqueness when a source user message is known.
create unique index if not exists elise_generation_operations_source_unique
  on public.elise_generation_operations (user_id, session_id, source_message_id, operation_type)
  where source_message_id is not null;

create index if not exists elise_generation_operations_assistant_idx
  on public.elise_generation_operations (assistant_message_id)
  where assistant_message_id is not null;

-- Atomic reserve / recover for E-2 generation safety.
create or replace function public.reserve_elise_generation_operation(
  p_session_id uuid,
  p_source_message_id uuid,
  p_operation_key text,
  p_request_id text default null,
  p_operation_type text default 'stylechat_generate_reply'
)
returns table (
  operation_id uuid,
  status text,
  attempt_count integer,
  assistant_message_id uuid,
  is_duplicate boolean,
  may_generate boolean,
  stable_error_class text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_operation_key text;
  v_operation_type text;
  v_request_id text;
  v_session_ok boolean := false;
  v_source_ok boolean := true;
  v_existing public.elise_generation_operations%rowtype;
  v_inserted public.elise_generation_operations%rowtype;
begin
  v_user_id := auth.uid();
  if v_user_id is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  v_operation_key := nullif(btrim(p_operation_key), '');
  v_operation_type := nullif(btrim(p_operation_type), '');
  v_request_id := nullif(btrim(coalesce(p_request_id, '')), '');

  if v_operation_key is null or length(v_operation_key) > 512 then
    raise exception 'Invalid Elise generation operation key' using errcode = '22023';
  end if;
  if v_operation_type is null or length(v_operation_type) > 80 then
    raise exception 'Invalid Elise generation operation type' using errcode = '22023';
  end if;
  if p_session_id is null then
    raise exception 'Session required' using errcode = '22023';
  end if;

  select exists(
    select 1
      from public.style_chat_sessions as s
     where s.id = p_session_id
       and s.user_id = v_user_id
  ) into v_session_ok;
  if not v_session_ok then
    raise exception 'Session not found' using errcode = 'P0002';
  end if;

  if p_source_message_id is not null then
    select exists(
      select 1
        from public.style_chat_messages as m
       where m.id = p_source_message_id
         and m.session_id = p_session_id
         and m.user_id = v_user_id
         and m.sender = 'user'
    ) into v_source_ok;
    if not v_source_ok then
      raise exception 'Source message not found' using errcode = 'P0002';
    end if;
  end if;

  insert into public.elise_generation_operations (
    user_id,
    session_id,
    source_message_id,
    operation_type,
    operation_key,
    status,
    quota_counted,
    request_id,
    attempt_count
  )
  values (
    v_user_id,
    p_session_id,
    p_source_message_id,
    v_operation_type,
    v_operation_key,
    'reserved',
    false,
    v_request_id,
    1
  )
  on conflict (user_id, operation_key) do nothing
  returning * into v_inserted;

  if v_inserted.id is not null then
    return query select
      v_inserted.id,
      v_inserted.status,
      v_inserted.attempt_count,
      v_inserted.assistant_message_id,
      false,
      true,
      v_inserted.stable_error_class;
    return;
  end if;

  select *
    into v_existing
    from public.elise_generation_operations as op
   where op.user_id = v_user_id
     and op.operation_key = v_operation_key;

  if v_existing.id is null then
    raise exception 'Operation reservation failed' using errcode = 'P0001';
  end if;

  -- Completed: recover existing result; do not generate again.
  if v_existing.status = 'completed' then
    return query select
      v_existing.id,
      v_existing.status,
      v_existing.attempt_count,
      v_existing.assistant_message_id,
      true,
      false,
      v_existing.stable_error_class;
    return;
  end if;

  -- In flight: do not start a second provider call.
  if v_existing.status in ('reserved', 'generating') then
    return query select
      v_existing.id,
      v_existing.status,
      v_existing.attempt_count,
      v_existing.assistant_message_id,
      true,
      false,
      v_existing.stable_error_class;
    return;
  end if;

  -- Bounded retry for retryable failures only.
  if v_existing.status in ('failed_retryable', 'failed')
     and v_existing.attempt_count < v_existing.max_attempts then
    update public.elise_generation_operations as op
       set status = 'reserved',
           attempt_count = op.attempt_count + 1,
           request_id = coalesce(v_request_id, op.request_id),
           stable_error_class = null,
           provider_started_at = null,
           completed_at = null,
           updated_at = now()
     where op.id = v_existing.id
     returning * into v_existing;

    return query select
      v_existing.id,
      v_existing.status,
      v_existing.attempt_count,
      v_existing.assistant_message_id,
      true,
      true,
      v_existing.stable_error_class;
    return;
  end if;

  -- Terminal / stale / cancelled / exhausted retries: no generation.
  return query select
    v_existing.id,
    v_existing.status,
    v_existing.attempt_count,
    v_existing.assistant_message_id,
    true,
    false,
    v_existing.stable_error_class;
end;
$$;

create or replace function public.mark_elise_generation_generating(
  p_operation_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_updated integer := 0;
begin
  v_user_id := auth.uid();
  if v_user_id is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  update public.elise_generation_operations
     set status = 'generating',
         provider_started_at = coalesce(provider_started_at, now()),
         updated_at = now()
   where id = p_operation_id
     and user_id = v_user_id
     and status in ('reserved', 'generating');

  get diagnostics v_updated = row_count;
  return v_updated > 0;
end;
$$;

create or replace function public.revalidate_elise_generation_context(
  p_operation_id uuid,
  p_session_id uuid,
  p_source_message_id uuid default null
)
returns table (
  valid boolean,
  reason text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_op public.elise_generation_operations%rowtype;
  v_session_ok boolean := false;
  v_source_ok boolean := true;
begin
  v_user_id := auth.uid();
  if v_user_id is null then
    return query select false, 'not_authenticated';
    return;
  end if;

  select *
    into v_op
    from public.elise_generation_operations as op
   where op.id = p_operation_id
     and op.user_id = v_user_id;

  if v_op.id is null then
    return query select false, 'operation_not_found';
    return;
  end if;

  if v_op.status in ('completed', 'stale', 'cancelled', 'failed_terminal') then
    return query select false, v_op.status;
    return;
  end if;

  select exists(
    select 1
      from public.style_chat_sessions as s
     where s.id = p_session_id
       and s.user_id = v_user_id
  ) into v_session_ok;
  if not v_session_ok then
    update public.elise_generation_operations
       set status = 'stale',
           stable_error_class = 'SESSION_INVALID',
           completed_at = now(),
           updated_at = now()
     where id = v_op.id;
    return query select false, 'session_invalid';
    return;
  end if;

  if p_source_message_id is not null then
    select exists(
      select 1
        from public.style_chat_messages as m
       where m.id = p_source_message_id
         and m.session_id = p_session_id
         and m.user_id = v_user_id
         and m.sender = 'user'
    ) into v_source_ok;
    if not v_source_ok then
      update public.elise_generation_operations
         set status = 'stale',
             stable_error_class = 'SOURCE_MESSAGE_INVALID',
             completed_at = now(),
             updated_at = now()
       where id = v_op.id;
      return query select false, 'source_message_invalid';
      return;
    end if;
  end if;

  return query select true, null::text;
end;
$$;

create or replace function public.finalize_elise_generation_operation(
  p_operation_id uuid,
  p_status text,
  p_assistant_message_id uuid default null,
  p_stable_error_class text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_status text;
  v_updated integer := 0;
begin
  v_user_id := auth.uid();
  if v_user_id is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  v_status := nullif(btrim(p_status), '');
  if v_status is null or v_status not in (
    'completed', 'failed_retryable', 'failed_terminal', 'cancelled', 'stale', 'failed'
  ) then
    raise exception 'Invalid Elise generation final status' using errcode = '22023';
  end if;

  update public.elise_generation_operations
     set status = v_status,
         assistant_message_id = coalesce(p_assistant_message_id, assistant_message_id),
         stable_error_class = coalesce(nullif(btrim(coalesce(p_stable_error_class, '')), ''), stable_error_class),
         completed_at = now(),
         updated_at = now()
   where id = p_operation_id
     and user_id = v_user_id
     and status in ('reserved', 'generating', 'failed_retryable', 'failed');

  get diagnostics v_updated = row_count;
  return v_updated > 0;
end;
$$;

revoke all on function public.reserve_elise_generation_operation(uuid, uuid, text, text, text) from public;
revoke all on function public.mark_elise_generation_generating(uuid) from public;
revoke all on function public.revalidate_elise_generation_context(uuid, uuid, uuid) from public;
revoke all on function public.finalize_elise_generation_operation(uuid, text, uuid, text) from public;

grant execute on function public.reserve_elise_generation_operation(uuid, uuid, text, text, text) to authenticated;
grant execute on function public.mark_elise_generation_generating(uuid) to authenticated;
grant execute on function public.revalidate_elise_generation_context(uuid, uuid, uuid) to authenticated;
grant execute on function public.finalize_elise_generation_operation(uuid, text, uuid, text) to authenticated;
