-- Migration provenance (restored by maintenance/staging-migration-authority-reconciliation, 2026-08-29).
--
-- Owning repository: kscan-app
-- Original authored file: supabase/migrations/20260823120000_scan_commerce_events_accuracy_telemetry.sql
-- Original source commit: dbfd66f
-- Applied to staging (yzqjvdfgefveprobvvyw) as ledger version: 20260823175314
-- Authored filename timestamp (20260823120000) differs from the Management-API-assigned ledger version. The committed source itself carries a 'NOT APPLIED... later steps' comment that was aspirational/incorrect at authoring time -- it was in fact applied. Flagged for the owner as a process gap, independent of content provenance.
--
-- SQL below reproduces the exact statements Postgres executed on staging
-- (recovered from supabase_migrations.schema_migrations.statements).
-- See docs/staging-rebuild/recovered-migrations/LEDGER_INTEGRITY_CHECK.md
-- for source/ledger SHA-256 hashes and full verification detail.

-- Build 32 commerce accuracy telemetry (v124/v127 repair).
--
-- Additive and nullable throughout — every existing row remains valid, and
-- every existing reader/writer of scan_commerce_events is unaffected.

alter table public.scan_commerce_events
  add column if not exists query_strategy text,
  add column if not exists top_agreement_score integer,
  add column if not exists top_agreement_band text,
  add column if not exists commerce_identity_version text,
  add column if not exists commerce_funnel_version text;

comment on column public.scan_commerce_events.query_strategy is
  'v125 query-strategy classification (exact_identity / brand_distinctive / '
  'attribute_only / fallback), when v125 ran. Bounded enum — never the query '
  'string itself.';

comment on column public.scan_commerce_events.top_agreement_score is
  'The highest v124/v122 agreement score among ranked candidates for this '
  'request, when the relevance path ran. 0-100. Null when relevance was off '
  'or no candidates were scored.';

comment on column public.scan_commerce_events.top_agreement_band is
  'agreementBandFromScore(top_agreement_score) — strong / usable / weak. '
  'Deterministic function of the column above, persisted alongside it so a '
  'query does not need to know the score->band thresholds.';

comment on column public.scan_commerce_events.commerce_identity_version is
  'Stamped with the v124 identity version only when commerce identity '
  'evidence was supplied for this request. Null when v124 was off, matching '
  'the existing textscan_parity_version column''s conditional-stamp pattern.';

comment on column public.scan_commerce_events.commerce_funnel_version is
  'Stamped with the v127 funnel version only when the request went through '
  'the deferred commerce funnel (MODE B / commerce_only). Null otherwise.';
