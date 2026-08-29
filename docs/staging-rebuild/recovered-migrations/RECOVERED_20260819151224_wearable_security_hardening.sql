-- RECOVERED FROM supabase_migrations.schema_migrations LEDGER (staging: yzqjvdfgefveprobvvyw)
-- version: 20260819151224
-- name (embedded original timestamp): 20260819030000_wearable_security_hardening
-- statement_count: 1
-- Same cross-repo provenance note as RECOVERED_20260819125404: likely
-- belongs to kscan-glasses-webapp, not this repo.

create table public.wearable_auth_attempts (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  operation text not null check (operation in ('pair.approve', 'pair.deny')),
  attempted_at timestamptz not null default now()
);

create index wearable_auth_attempts_window
  on public.wearable_auth_attempts(user_id, operation, attempted_at);

alter table public.wearable_auth_attempts enable row level security;

revoke all on table public.wearable_auth_attempts from anon, authenticated;
revoke all on sequence public.wearable_auth_attempts_id_seq from anon, authenticated;

comment on table public.wearable_auth_attempts is
  'Bounded per-user attempt log used by the wearable-bridge Edge Function to throttle pairing challenge guesses. Service-role only.';
