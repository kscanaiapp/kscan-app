-- RECOVERED FROM supabase_migrations.schema_migrations LEDGER (staging: yzqjvdfgefveprobvvyw)
-- version: 20260812031312
-- name: legal_acceptances_restore_ai_processing
-- statement_count: 1

-- Restore the approved Welcome Tree AI image-processing consent contract on
-- staging. The prior Android migration used prefix 20260805120000, which is
-- already occupied on this lineage by deletion-request reconciliation.

alter table public.legal_acceptances
  drop constraint if exists legal_acceptances_acceptance_type_check;

alter table public.legal_acceptances
  add constraint legal_acceptances_acceptance_type_check
  check (acceptance_type in ('terms', 'privacy', 'minimum_age', 'ai_processing'));
