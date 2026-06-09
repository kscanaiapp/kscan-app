-- StyleChat v0.4.2: per-minute burst limiting for authenticated users.
-- Forward-only migration. Do not edit.
--
-- Purpose: prevent rapid-fire abuse and accidental cost spikes during beta.
--
-- Design: fixed 1-minute window aligned to date_trunc('minute', now()).
-- Known boundary behavior: a user may send p_limit requests at the end of one
-- minute window and p_limit more at the start of the next (up to 2x burst at
-- the window edge). This is acceptable for beta. Migrate to a sliding window
-- or token bucket if sustained abuse is observed.
--
-- All attempts (allowed and blocked) are recorded in the burst table.
-- The burst table is not user quota; it exists purely for rate enforcement.
--
-- Cleanup: amortized inside the RPC (~1% chance per call) deletes rows older
-- than 1 day. No pg_cron or external job required.
--
-- Concurrency safety: INSERT ... ON CONFLICT DO UPDATE serializes concurrent
-- updates on the same (user_id, window_start) row via PostgreSQL row-level
-- locking. Two parallel requests cannot both read the same pre-increment count
-- and both be admitted as if they were the same sequence position.

create table if not exists public.style_chat_burst_usage (
  user_id       uuid        not null,
  window_start  timestamptz not null,
  request_count integer     not null default 0 check (request_count >= 0),
  updated_at    timestamptz not null default now(),
  primary key (user_id, window_start)
);

-- Index for amortized cleanup (delete by updated_at).
create index if not exists style_chat_burst_usage_updated_idx
  on public.style_chat_burst_usage (updated_at);

alter table public.style_chat_burst_usage enable row level security;
-- No client-readable RLS policy: all access is through the SECURITY DEFINER
-- RPC only. Direct client reads and writes are prohibited.

-- ── Atomic burst check-and-increment RPC ──────────────────────────────────────
-- Called by the stylechat-generate Edge Function via the user-scoped Supabase
-- client (Bearer JWT forwarded). auth.uid() is the authoritative identity;
-- the function never accepts a user_id parameter from the caller.
--
-- p_limit: maximum accepted requests per 1-minute window (default 4).
--          The Edge Function reads STYLECHAT_BURST_LIMIT_PER_MINUTE and passes
--          it here. Clamped to [1, 60] inside the function.
--
-- Returns:
--   allowed             true  if this request is within the limit
--   remaining           slots remaining after this request (0 if not allowed)
--   reset_at            start of the next window (when the count resets)
--   retry_after_seconds seconds until the next window opens

create or replace function public.check_and_increment_stylechat_burst(
  p_limit integer default 4
)
returns table (
  allowed             boolean,
  remaining           integer,
  reset_at            timestamptz,
  retry_after_seconds integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id      uuid;
  v_window_start timestamptz;
  v_count        integer;
  v_limit        integer;
  v_reset_at     timestamptz;
begin
  v_user_id := auth.uid();
  if v_user_id is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  -- Clamp limit to a safe range to prevent misconfiguration.
  v_limit        := greatest(1, least(coalesce(p_limit, 4), 60));
  v_window_start := date_trunc('minute', now());
  v_reset_at     := v_window_start + interval '1 minute';

  -- Amortized cleanup: ~1% of calls delete rows older than 1 day.
  -- Keeps the table small without requiring pg_cron or a separate job.
  if random() < 0.01 then
    delete from public.style_chat_burst_usage
    where updated_at < now() - interval '1 day';
  end if;

  -- Always record the attempt (allowed or blocked), atomically.
  -- INSERT creates the row on the first request in a window.
  -- ON CONFLICT DO UPDATE increments it on subsequent requests.
  -- PostgreSQL serializes concurrent UPDATEs on the same primary-key row,
  -- so two parallel requests cannot read the same count and both be admitted
  -- as if they were at the same sequence position.
  -- RETURNING always yields the post-operation count (never NULL here).
  insert into public.style_chat_burst_usage (user_id, window_start, request_count, updated_at)
    values (v_user_id, v_window_start, 1, now())
  on conflict (user_id, window_start) do update
    set request_count = style_chat_burst_usage.request_count + 1,
        updated_at    = now()
  returning request_count into v_count;

  return query select
    v_count <= v_limit,                                            -- allowed
    greatest(0, v_limit - v_count),                               -- remaining
    v_reset_at,                                                    -- reset_at
    greatest(0, extract(epoch from v_reset_at - now())::integer); -- retry_after_seconds
end;
$$;

revoke all on function public.check_and_increment_stylechat_burst(integer) from public;
grant execute on function public.check_and_increment_stylechat_burst(integer) to authenticated;
