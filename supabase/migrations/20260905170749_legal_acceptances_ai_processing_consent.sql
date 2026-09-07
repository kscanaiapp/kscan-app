-- Migration provenance (recovered by RP-108 backend authority reconciliation, 2026-09-07).
--
-- Owning repository: kscan-app
-- Original authored file: NONE. No commit on any fetched ref ever added a file
--   for this version -- verified with `git log --all --diff-filter=A` over the
--   path. This migration existed only in the applied ledgers, which is exactly
--   the remote-only drift RP-108 exists to close.
-- Applied to staging    (yzqjvdfgefveprobvvyw) as ledger version: 20260905170749
-- Applied to production (wyyuqfdxucjksghsmhry) as ledger version: 20260905171030
--
-- The SQL below reproduces the exact statements Postgres executed, recovered
-- read-only from supabase_migrations.schema_migrations.statements on BOTH
-- projects. The two ledgers hold byte-identical statement text under the same
-- logical name, differing only in the version each environment recorded.
--
-- The STAGING version identity is preserved as this file's name because that is
-- the identity this repository's tooling reconciles against (approvedProjectRef
-- in config/backend-authority.json). The production alias is registered in
-- config/migration-authority-manifest.json so the divergence is explained by
-- source rather than remembered. Nothing is renamed, deleted or re-applied:
-- both ledgers keep the versions they already hold.
--
-- Replay safety: the effect is already true in both environments and the DDL is
-- idempotent (drop constraint if exists, then add), so restoring it to source
-- introduces no pending change.

-- Allow the AI image-processing consent acceptance type recorded by the
-- restored onboarding AI consent checkbox (see app/onboarding/index.tsx,
-- services/legalAcceptance.ts). Additive only: existing acceptance types
-- are unchanged.

alter table public.legal_acceptances
  drop constraint if exists legal_acceptances_acceptance_type_check;

alter table public.legal_acceptances
  add constraint legal_acceptances_acceptance_type_check
  check (acceptance_type in ('terms', 'privacy', 'minimum_age', 'ai_processing'));
