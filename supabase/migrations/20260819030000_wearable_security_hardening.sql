-- Wearable bridge security hardening: per-user attempt throttle for
-- pair.approve / pair.deny so the 6-digit challenge cannot be brute-forced
-- inside its 120s TTL. Service-role only; no direct client access.

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
