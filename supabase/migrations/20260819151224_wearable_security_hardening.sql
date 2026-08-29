-- Central migration-authority copy (shared_supabase_central_migration_authority).
-- Restored by maintenance/staging-migration-authority-reconciliation, 2026-08-29.
--
-- This file centralizes a historically-executed shared-database migration
-- for CLI reconciliation purposes only. It does NOT transfer product
-- ownership of the underlying feature/schema to kscan-app.
--
-- logical_owner:            kscan-glasses-webapp
-- source_original_filename: none found as a standalone file in kscan-glasses-webapp; content is folded idempotently into that repo's 20260823170850_reconcile_wearable_schema_with_staging.sql
-- source_commit:            none standalone (kscan-glasses-webapp)
-- ledger_version:           20260819151224
-- No discrete original commit found for this version in isolation; its effect (wearable_auth_attempts table) is independently confirmed live and matches the idempotent CREATE TABLE IF NOT EXISTS block in the reconcile migration.
--
-- SQL below reproduces the exact statements Postgres executed on staging
-- (recovered from supabase_migrations.schema_migrations.statements).
-- See docs/staging-rebuild/recovered-migrations/CENTRAL_MIGRATION_AUTHORITY.md
-- for full provenance metadata and SHA-256 hashes.

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
