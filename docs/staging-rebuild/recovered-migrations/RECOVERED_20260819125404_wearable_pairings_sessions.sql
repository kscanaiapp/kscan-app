-- RECOVERED FROM supabase_migrations.schema_migrations LEDGER (staging: yzqjvdfgefveprobvvyw)
-- version: 20260819125404
-- name (embedded original timestamp): 20260815015710_wearable_pairings_sessions
-- statement_count: 1
--
-- PROVENANCE NOTE: "wearable-bridge" and the sibling wearable-* Edge
-- Functions are documented elsewhere in this repo (config/backend-authority.json's
-- notGoverned block, docs/staging-rebuild/backend-authority-manifest.md) as
-- deployed from a DIFFERENT repository entirely: kscan-glasses-webapp, not
-- kscan-app. This table family is almost certainly sourced from that repo's
-- own migrations, not a gap in this one. Check kscan-glasses-webapp for a
-- file named 20260815015710_wearable_pairings_sessions.sql before treating
-- this as belonging to kscan-app at all.

-- Shared wearable primitives for private Google XR companion testing.
-- All access is mediated by the wearable-bridge Edge Function. No table is
-- directly exposed to anon/authenticated clients.

create extension if not exists pgcrypto with schema extensions;

create table public.wearable_pairings (
  id uuid primary key default gen_random_uuid(),
  pairing_handle uuid not null unique default gen_random_uuid(),
  challenge_hash text not null,
  pairing_secret_hash text not null,
  request_id uuid not null unique,
  device_id uuid not null,
  device_model text not null check (char_length(device_model) between 1 and 80),
  device_app_version text not null check (char_length(device_app_version) between 1 and 40),
  protocol_version integer not null check (protocol_version = 1),
  user_id uuid references auth.users(id) on delete cascade,
  phone_device_id uuid,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'denied', 'expired', 'consumed')),
  expires_at timestamptz not null,
  approved_at timestamptz,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  check (expires_at > created_at),
  check ((status = 'pending' and user_id is null) or status <> 'pending')
);

create unique index wearable_pairings_one_pending_device
  on public.wearable_pairings(device_id)
  where status = 'pending';
create index wearable_pairings_pending_expiry
  on public.wearable_pairings(expires_at)
  where status = 'pending';
create index wearable_pairings_user_created
  on public.wearable_pairings(user_id, created_at desc)
  where user_id is not null;

create table public.wearable_sessions (
  id uuid primary key default gen_random_uuid(),
  pairing_id uuid not null unique references public.wearable_pairings(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid not null,
  protocol_version integer not null check (protocol_version = 1),
  token_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoke_reason text check (revoke_reason in ('user_revoked', 'expired', 'replaced', 'sign_out', 'error')),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  check (expires_at > created_at),
  check ((revoked_at is null and revoke_reason is null) or (revoked_at is not null and revoke_reason is not null))
);

create unique index wearable_sessions_one_active_device
  on public.wearable_sessions(device_id)
  where revoked_at is null;
create index wearable_sessions_user_active
  on public.wearable_sessions(user_id, expires_at)
  where revoked_at is null;
create index wearable_sessions_expiry
  on public.wearable_sessions(expires_at)
  where revoked_at is null;

create table public.wearable_messages (
  id bigint generated always as identity primary key,
  session_id uuid not null references public.wearable_sessions(id) on delete cascade,
  direction text not null check (direction in ('to_phone', 'to_wearable')),
  request_id uuid not null,
  message_type text not null check (char_length(message_type) between 3 and 48),
  frame jsonb not null,
  expires_at timestamptz not null,
  acknowledged_at timestamptz,
  created_at timestamptz not null default now(),
  unique(session_id, direction, request_id, message_type),
  check (octet_length(frame::text) <= 65536),
  check (expires_at > created_at)
);

create index wearable_messages_poll
  on public.wearable_messages(session_id, direction, id);
create index wearable_messages_expiry on public.wearable_messages(expires_at);

create table public.wearable_results (
  id uuid primary key,
  session_id uuid not null references public.wearable_sessions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  scan_id uuid not null,
  revision integer not null default 1 check (revision between 1 and 1000),
  status text not null check (status in ('completed', 'partial', 'failed')),
  payload jsonb not null,
  saved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(session_id, scan_id),
  check (octet_length(payload::text) <= 49152)
);

create index wearable_results_user_created on public.wearable_results(user_id, created_at desc);

create table public.wearable_actions (
  id uuid primary key,
  session_id uuid not null references public.wearable_sessions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  result_id uuid references public.wearable_results(id) on delete cascade,
  action_type text not null check (action_type in ('save', 'open_on_phone', 'cancel', 'retry')),
  status text not null default 'pending' check (status in ('pending', 'completed', 'failed', 'cancelled')),
  safe_error_code text check (safe_error_code is null or char_length(safe_error_code) <= 48),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  unique(session_id, id)
);

create index wearable_actions_phone_poll
  on public.wearable_actions(user_id, status, created_at)
  where status = 'pending';

alter table public.wearable_pairings enable row level security;
alter table public.wearable_sessions enable row level security;
alter table public.wearable_messages enable row level security;
alter table public.wearable_results enable row level security;
alter table public.wearable_actions enable row level security;

revoke all on table public.wearable_pairings from anon, authenticated;
revoke all on table public.wearable_sessions from anon, authenticated;
revoke all on table public.wearable_messages from anon, authenticated;
revoke all on table public.wearable_results from anon, authenticated;
revoke all on table public.wearable_actions from anon, authenticated;
revoke all on sequence public.wearable_messages_id_seq from anon, authenticated;

comment on table public.wearable_sessions is
  'Short-lived shared wearable sessions. token_hash stores SHA-256 only; raw wearable tokens are never persisted.';
comment on table public.wearable_messages is
  'Bounded result-only bridge frames. Image bytes and credentials are prohibited by the Edge Function validator.';
