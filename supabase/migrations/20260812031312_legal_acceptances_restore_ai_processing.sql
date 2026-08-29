-- Migration provenance (restored by maintenance/staging-migration-authority-reconciliation, 2026-08-29).
--
-- Owning repository: kscan-app
-- Original authored file: (same name)
-- Original source commit: e9afbad
-- Applied to staging (yzqjvdfgefveprobvvyw) as ledger version: 20260812031312
--
-- SQL below reproduces the exact statements Postgres executed on staging
-- (recovered from supabase_migrations.schema_migrations.statements).
-- See docs/staging-rebuild/recovered-migrations/LEDGER_INTEGRITY_CHECK.md
-- for source/ledger SHA-256 hashes and full verification detail.

-- Restore the approved Welcome Tree AI image-processing consent contract on
-- staging. The prior Android migration used prefix 20260805120000, which is
-- already occupied on this lineage by deletion-request reconciliation.

alter table public.legal_acceptances
  drop constraint if exists legal_acceptances_acceptance_type_check;

alter table public.legal_acceptances
  add constraint legal_acceptances_acceptance_type_check
  check (acceptance_type in ('terms', 'privacy', 'minimum_age', 'ai_processing'));
