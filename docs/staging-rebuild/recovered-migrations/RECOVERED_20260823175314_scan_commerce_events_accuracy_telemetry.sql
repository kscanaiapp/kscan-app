-- RECOVERED FROM supabase_migrations.schema_migrations LEDGER (staging: yzqjvdfgefveprobvvyw)
-- version: 20260823175314
-- name: scan_commerce_events_accuracy_telemetry
-- statement_count: 1
--
-- *** CRITICAL PROVENANCE FLAG ***
-- This migration's OWN comment says: "NOT APPLIED as part of this change.
-- Source-only per the governing repair scope: activation and staging
-- validation are separate, later steps." Yet it unambiguously IS applied --
-- it is recorded in staging's schema_migrations ledger with a real executed
-- timestamp. This is direct evidence that whatever process pushed this file
-- (an ad-hoc CLI checkout per the DEF-001 pattern) applied source that its
-- own author explicitly marked "do not apply yet." Flag for the owner:
-- confirm whether scan_commerce_events on staging actually has these five
-- columns as a deliberate, later-approved decision, or as an accidental
-- side effect of an unrelated push sweeping up a dirty working tree.

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
