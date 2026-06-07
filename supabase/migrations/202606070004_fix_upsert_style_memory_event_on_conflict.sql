-- Fix upsert_style_memory_event: ON CONFLICT must include the WHERE predicate
-- that matches the partial unique index (style_memory_events_unique_daily_signal).
-- Without WHERE signal_key IS NOT NULL, PostgreSQL cannot resolve the partial
-- index and raises "no unique or exclusion constraint matching ON CONFLICT".
-- Forward-only migration. Do not edit.

create or replace function public.upsert_style_memory_event(
  p_source       text,
  p_event_type   text,
  p_signal_key   text,
  p_signal_date  date,
  p_payload      jsonb,
  p_confidence   numeric,
  p_source_refs  jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id  uuid := auth.uid();
  v_event_id uuid;
begin
  if v_user_id is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if p_source is null or length(trim(p_source)) = 0 then
    raise exception 'source is required' using errcode = '22023';
  end if;
  if p_event_type is null or length(trim(p_event_type)) = 0 then
    raise exception 'event_type is required' using errcode = '22023';
  end if;
  if p_signal_key is null or length(trim(p_signal_key)) = 0 then
    raise exception 'signal_key is required' using errcode = '22023';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'payload must be a JSON object' using errcode = '22023';
  end if;

  insert into public.style_memory_events (
    user_id, source, event_type, signal_key, signal_date,
    payload, confidence, source_refs
  )
  values (
    v_user_id,
    trim(p_source),
    trim(p_event_type),
    trim(p_signal_key),
    coalesce(p_signal_date, current_date),
    p_payload,
    coalesce(p_confidence, 0.5),
    coalesce(p_source_refs, '[]'::jsonb)
  )
  on conflict (user_id, event_type, source, signal_key, signal_date)
    where signal_key is not null
  do update set
    payload            = excluded.payload,
    confidence         = excluded.confidence,
    source_refs        = excluded.source_refs,
    stale_source_count = 0
  returning id into v_event_id;

  return v_event_id;
end;
$$;

revoke all on function public.upsert_style_memory_event(text, text, text, date, jsonb, numeric, jsonb) from public;
grant execute on function public.upsert_style_memory_event(text, text, text, date, jsonb, numeric, jsonb) to authenticated;
