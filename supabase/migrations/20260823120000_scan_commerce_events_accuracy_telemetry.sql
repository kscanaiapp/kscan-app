-- Build 32 commerce accuracy telemetry (v124/v127 repair).
--
-- Additive and nullable throughout — every existing row remains valid, and
-- every existing reader/writer of scan_commerce_events is unaffected.
--
-- NOT APPLIED as part of this change. Source-only per the governing repair
-- scope: activation and staging validation are separate, later steps.
--
-- Why these five columns, and not more:
--   query_strategy              already computed (FastCommerceResult /
--                                ScanCommerceResult .queryStrategy), bounded
--                                enum, never the query string itself.
--   top_agreement_score         already computed — filterAndDedupeProducts'
--                                relevance stats already carry a
--                                descending-order agreementScores[] array;
--                                this is simply its first element.
--   top_agreement_band          deterministically derived from the score
--                                above via the existing, already-exported
--                                agreementBandFromScore() — no new scoring.
--   commerce_identity_version   a version constant (COMMERCE_IDENTITY_VERSION),
--                                stamped only when v124 identity evidence
--                                was actually supplied for this request —
--                                mirrors the existing textscan_parity_version
--                                column's conditional-stamp convention exactly.
--   commerce_funnel_version     same pattern for v127
--                                (COMMERCE_FUNNEL_VERSION).
--
-- Deliberately NOT added here: identity_brand_matched. The per-product brand
-- match flag is computed inside scoreProductAgreement's identity breakdown,
-- but is discarded before it reaches ProductFilterStats, and picking which
-- ranked product counts as "top" for this flag is a scoped design decision,
-- not pure transport plumbing. Left for a separately reviewed follow-up
-- rather than folded in here under this repair's "no new ranking logic" and
-- "no new confidence model" constraints.

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
