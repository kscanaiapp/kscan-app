-- RECOVERED FROM supabase_migrations.schema_migrations LEDGER
--   staging:    yzqjvdfgefveprobvvyw  version 20260905170749
--   production: wyyuqfdxucjksghsmhry  version 20260905171030
-- name: legal_acceptances_ai_processing_consent
-- statement_count: 1
-- ledger statement sha256: 560b3f08cc25c042130c8373640729bf6a55a55ff300ca53a9327563bb606700
-- content match: EXACT BYTE MATCH between the two ledgers; the restored
--   canonical file's body reproduces this text verbatim.
-- classification: REMOTE_ONLY_DRIFT_RECOVERED (RP-108, 2026-09-07) -- no
--   authored source existed on any ref in any repository; both reads were
--   read-only and neither ledger was modified.

-- Allow the AI image-processing consent acceptance type recorded by the
-- restored onboarding AI consent checkbox (see app/onboarding/index.tsx,
-- services/legalAcceptance.ts). Additive only: existing acceptance types
-- are unchanged.

alter table public.legal_acceptances
  drop constraint if exists legal_acceptances_acceptance_type_check;

alter table public.legal_acceptances
  add constraint legal_acceptances_acceptance_type_check
  check (acceptance_type in ('terms', 'privacy', 'minimum_age', 'ai_processing'));
