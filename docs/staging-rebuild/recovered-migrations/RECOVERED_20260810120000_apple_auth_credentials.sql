-- RECOVERED FROM supabase_migrations.schema_migrations LEDGER (staging: yzqjvdfgefveprobvvyw)
-- version: 20260810120000
-- name: apple_auth_credentials
-- statement_count: 7
-- This file was reconstructed read-only from the executed-statement ledger.

-- ---------------------------------------------------------------------------
-- IOS29-NEW-003 — Sign in with Apple credential storage for account deletion.
--
-- Apple requires that deleting an account which was created with Sign in with
-- Apple also revokes the user's Apple authorization through the Sign in with
-- Apple REST API (TN3194, and Guideline 5.1.1(v)). Revocation needs a valid
-- refresh or access token, which only exists if we exchanged the authorization
-- code at sign-in time and kept the result. This table is that store.
--
-- It holds ONE secret per user and nothing else. No Apple profile data, no
-- identity token, no email, no name — none of which revocation needs, and all
-- of which would widen the blast radius for no benefit. The single-use
-- authorization code is spent during exchange and is never written here.
--
-- Access model, matching public.deletion_state_transitions:
--   * RLS enabled with NO policies, so anon and authenticated match nothing.
--   * REVOKE ALL from anon and authenticated, so the table stays unreachable
--     even if a policy is ever added to it by accident.
--   * service_role only, which bypasses RLS and is held solely by Edge
--     Functions and the operator deletion processor.
--
-- The token value is ALSO encrypted (AES-256-GCM) by the Edge Function before
-- it is written, under a key that lives only in the function environment and is
-- never reachable from SQL. A database dump, replica, or backup therefore
-- yields ciphertext only. See supabase/functions/_shared/appleAuth/credentialStore.ts.
--
-- Forward-only. No previously applied migration is edited.
-- ---------------------------------------------------------------------------

create table if not exists public.apple_auth_credentials (
  -- One live Apple authorization per user. Re-authorising replaces the row:
  -- Apple issues a new refresh token per authorization and the previous one no
  -- longer represents the user's current grant.
  user_id uuid primary key references auth.users (id) on delete cascade,

  -- AES-256-GCM envelope, "v1.<base64 iv>.<base64 ciphertext>". Never plaintext.
  -- The column name states what it holds so no future reader mistakes it for a
  -- bearer value that can be used directly.
  encrypted_refresh_token text not null
    constraint apple_auth_credentials_envelope_shape
      check (encrypted_refresh_token ~ '^v1\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$'),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.apple_auth_credentials is
  'Server-only store of the encrypted Apple refresh token used to revoke a user''s Sign in with Apple authorization during account deletion (TN3194). Never client-readable.';

comment on column public.apple_auth_credentials.encrypted_refresh_token is
  'AES-256-GCM envelope produced by the Edge Function. The key is not stored in the database and is not reachable from SQL.';

-- ---------------------------------------------------------------------------
-- Access control
-- ---------------------------------------------------------------------------

alter table public.apple_auth_credentials enable row level security;

-- Intentionally NO policies. With RLS on and no policy, anon and authenticated
-- match zero rows for every operation; service_role bypasses RLS entirely.
-- The REVOKE below is the belt to that braces: it removes the privilege itself,
-- so a policy added later to this table still cannot open it up on its own.
revoke all on table public.apple_auth_credentials from anon, authenticated;

grant select, insert, update, delete on table public.apple_auth_credentials to service_role;

-- ---------------------------------------------------------------------------
-- Deletion-lifecycle support
-- ---------------------------------------------------------------------------

-- The FK cascade is a safety net, not the intended path. Normal deletion
-- revokes with Apple and erases this row BEFORE the auth user is removed, so
-- the cascade should find nothing. If a purge ever bypasses revocation, the
-- cascade at least guarantees the secret does not outlive the account.

create index if not exists apple_auth_credentials_updated_at_idx
  on public.apple_auth_credentials (updated_at desc);
