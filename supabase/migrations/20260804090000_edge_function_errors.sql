-- Staging/ops edge-function error event foundation (redacted).
--
-- Creates a private `internal` schema table for structured, privacy-safe
-- error events. Not exposed through the Data API (no grants to anon/authenticated).
-- Service role may insert for Edge Function runtime reporting.
--
-- Forward-only. No backfill. No SECURITY DEFINER functions.

create schema if not exists internal;

create table if not exists internal.edge_function_errors (
  id uuid primary key default gen_random_uuid(),
  environment text not null
    check (environment in ('staging', 'production')),
  function_name text not null,
  function_version text null,
  request_id text null,
  error_class text not null,
  error_code text null,
  safe_message text not null,
  status_code integer null,
  duration_ms integer null,
  provider text null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz null
);

create index if not exists edge_function_errors_env_created_idx
  on internal.edge_function_errors (environment, created_at desc);

create index if not exists edge_function_errors_function_created_idx
  on internal.edge_function_errors (function_name, created_at desc);

comment on table internal.edge_function_errors is
  'Redacted Edge Function error events. Never store tokens, bodies, images, emails, or full user IDs.';

alter table internal.edge_function_errors enable row level security;

revoke all on schema internal from anon, authenticated, public;
revoke all on table internal.edge_function_errors from anon, authenticated, public;

-- Service role bypasses RLS; keep explicit table grants minimal.
grant usage on schema internal to service_role;
grant insert, select, update on table internal.edge_function_errors to service_role;
