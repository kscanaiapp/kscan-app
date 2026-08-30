-- Allow the AI image-processing consent captured on the Before We Begin screen
-- to be recorded in the existing legal acceptance ledger.
--
-- The onboarding client writes all four acceptances in a single atomic upsert,
-- so this migration must be applied before a build carrying the AI consent
-- checkbox is released; otherwise the whole write is rejected and onboarding
-- cannot complete.

alter table public.legal_acceptances
  drop constraint if exists legal_acceptances_acceptance_type_check;

alter table public.legal_acceptances
  add constraint legal_acceptances_acceptance_type_check
  check (acceptance_type in ('terms', 'privacy', 'minimum_age', 'ai_processing'));
