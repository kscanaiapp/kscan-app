-- Central migration-authority copy (shared_supabase_central_migration_authority).
-- Restored by maintenance/staging-migration-authority-reconciliation, 2026-08-29.
--
-- This file centralizes a historically-executed shared-database migration
-- for CLI reconciliation purposes only. It does NOT transfer product
-- ownership of the underlying feature/schema to kscan-app.
--
-- logical_owner:            kscan-website
-- source_original_filename: none found in kscan-website (git log --all returns zero hits); confirmed live application state via app/api/investor-inquiry/route.ts reading INQUIRY_TABLE = "investor_inquiries"
-- source_commit:            none found
-- ledger_version:           20260824175813
-- No committed source exists in kscan-website at all -- same ad-hoc-apply-never-commit pattern found for several kscan-app migrations, occurring in a third repository. Table is confirmed real, load-bearing website state, not orphaned.
--
-- SQL below reproduces the exact statements Postgres executed on staging
-- (recovered from supabase_migrations.schema_migrations.statements).
-- See docs/staging-rebuild/recovered-migrations/CENTRAL_MIGRATION_AUTHORITY.md
-- for full provenance metadata and SHA-256 hashes.

create table public.investor_inquiries (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  firm text,
  message text,
  page text,
  created_at timestamptz not null default now()
);

alter table public.investor_inquiries enable row level security;

create policy "allow_service_role_all"
  on public.investor_inquiries
  for all
  to service_role
  using (true)
  with check (true);
