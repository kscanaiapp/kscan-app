-- RECOVERED FROM supabase_migrations.schema_migrations LEDGER (staging: yzqjvdfgefveprobvvyw)
-- version: 20260808121216
-- name: privacy_request_rate_limits
-- statement_count: 1
-- This file was reconstructed read-only from the executed-statement ledger.
-- It reflects exactly what ran, but original comments/formatting/filename
-- may differ from whatever the true original migration source looked like.

-- Issue #47: per-user abuse rate limiting for privacy-rights Edge Functions.
-- Forward-only. Do not edit.
--
-- Scope: handle-user-deletion, privacy-correction-request, privacy-data-export.
-- These endpoints previously had no volume control. This adds a short fixed
-- window counter so a compromised/malicious authenticated session cannot spam
-- deletion/correction/export intake.
--
-- Rate policy (abuse protection, NOT a daily privacy-rights quota):
--   action keys: account_deletion | privacy_correction | privacy_export
--   default: 5 reservations / 60-second fixed window / (user, action)
-- Rationale:
--   - Matches the StyleChat/outfit burst convention of a short 1-minute window.
--   - Threshold 5 is high enough for legitimate double-taps and flaky retries
--     (clients submit once; they do not intentionally loop).
--   - Low enough to stop spam floods.
--   - Window resets after 60s so a legitimate follow-up is never locked out
--     for hours/days.
--
-- Identity:
--   Edge Functions authenticate the caller JWT first, then call this RPC via
--   the service_role REST client with the validated user id. Clients never
--   supply the identity for rate limiting from request body parameters that
--   bypass JWT validation. Direct anon/authenticated EXECUTE is revoked.
--
-- Concurrency:
--   INSERT ... ON CONFLICT DO UPDATE on (user_id, action, window_start)
--   serializes concurrent reservations on the same row so parallel workers
--   cannot oversubscribe the configured limit.

create table if not exists public.privacy_request_rate_limits (
  user_id       uuid        not null,
  action        text        not null,
  window_start  timestamptz not null,
  request_count integer     not null default 0 check (request_count >= 0),
  updated_at    timestamptz not null default now(),
  primary key (user_id, action, window_start),
  constraint privacy_request_rate_limits_action_check
    check (action in ('account_deletion', 'privacy_correction', 'privacy_export'))
);

create index if not exists privacy_request_rate_limits_updated_idx
  on public.privacy_request_rate_limits (updated_at);

alter table public.privacy_request_rate_limits enable row level security;
-- No client-facing policies: access is only through the SECURITY DEFINER RPC.

revoke all on table public.privacy_request_rate_limits from public;
revoke all on table public.privacy_request_rate_limits from anon, authenticated;
grant all on table public.privacy_request_rate_limits to service_role;

create or replace function public.reserve_privacy_request_rate_limit(
  p_user_id uuid,
  p_action text,
  p_limit integer default 5,
  p_window_seconds integer default 60
)
returns table (
  allowed             boolean,
  remaining           integer,
  reset_at            timestamptz,
  retry_after_seconds integer,
  request_count       integer,
  limit_value         integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_action       text;
  v_window_secs  integer;
  v_limit        integer;
  v_window_start timestamptz;
  v_reset_at     timestamptz;
  v_count        integer;
begin
  if p_user_id is null then
    raise exception 'user_id is required' using errcode = '22023';
  end if;

  v_action := lower(trim(coalesce(p_action, '')));
  if v_action not in ('account_deletion', 'privacy_correction', 'privacy_export') then
    raise exception 'unsupported privacy rate-limit action' using errcode = '22023';
  end if;

  -- Clamp configuration to a short abuse window. Never accept multi-hour
  -- lockouts through this RPC.
  v_window_secs := greatest(10, least(coalesce(p_window_seconds, 60), 300));
  v_limit := greatest(1, least(coalesce(p_limit, 5), 30));

  -- Fixed window aligned to epoch buckets of v_window_secs.
  v_window_start :=
    to_timestamp(
      floor(extract(epoch from now()) / v_window_secs) * v_window_secs
    );
  v_reset_at := v_window_start + make_interval(secs => v_window_secs);

  -- Amortized cleanup: ~1% of calls delete rows older than 1 day.
  if random() < 0.01 then
    delete from public.privacy_request_rate_limits
    where updated_at < now() - interval '1 day';
  end if;

  insert into public.privacy_request_rate_limits (
    user_id,
    action,
    window_start,
    request_count,
    updated_at
  )
  values (
    p_user_id,
    v_action,
    v_window_start,
    1,
    now()
  )
  on conflict (user_id, action, window_start) do update
    set request_count = privacy_request_rate_limits.request_count + 1,
        updated_at = now()
  returning privacy_request_rate_limits.request_count into v_count;

  return query select
    v_count <= v_limit,
    greatest(0, v_limit - v_count),
    v_reset_at,
    greatest(0, extract(epoch from v_reset_at - now())::integer),
    v_count,
    v_limit;
end;
$$;

revoke all on function public.reserve_privacy_request_rate_limit(uuid, text, integer, integer)
  from public;
revoke all on function public.reserve_privacy_request_rate_limit(uuid, text, integer, integer)
  from anon;
revoke all on function public.reserve_privacy_request_rate_limit(uuid, text, integer, integer)
  from authenticated;
grant execute on function public.reserve_privacy_request_rate_limit(uuid, text, integer, integer)
  to service_role;
