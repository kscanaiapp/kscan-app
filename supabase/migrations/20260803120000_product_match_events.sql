-- Product Match Foundation V1 — telemetry destination.
--
-- NOT APPLIED. This migration ships with the foundation branch so the event
-- shape in supabase/functions/product-match/telemetry.ts has a reviewed
-- destination, but database writes are not authorized for this phase and
-- nothing in this branch inserts into it. Applying it is a separate,
-- owner-approved step.
--
-- IMPORTANT — this repository's migration history diverges from the production
-- project's applied versions. Do NOT run `supabase db push` against production
-- to apply this file. Apply it explicitly, once, after the divergence is
-- reconciled.
--
-- PRIVACY MODEL
-- Categorical evidence only, following the precedent of llm_routing_events:
-- counts, durations, tiers, provider names and version strings. There is no
-- user_id column, no scan_id column, no image reference, and no free text from
-- a query or a product title. correlation_hash is an opaque caller-supplied
-- digest constrained to hex, so it cannot smuggle an identifier.
--
-- RLS: service-role only. Nothing about product-match telemetry is a user's
-- own data, so there is no owner policy to write and no reason for anon or
-- authenticated to read it.

create table if not exists public.product_match_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),

  -- Version cohorting.
  contract_version integer not null,
  match_version text not null,

  -- Categorical outcome.
  tier text not null,
  empty_reason text,

  -- Result shape.
  family_count integer not null default 0,
  variant_count integer not null default 0,
  listing_count integer not null default 0,

  -- Tier histogram across variants. Object keyed by tier name.
  tier_counts jsonb not null default '{}'::jsonb,

  -- Dedupe accounting, so merge behaviour is auditable without replaying input.
  rows_in integer not null default 0,
  listings_merged_by_url integer not null default 0,
  variants_merged_by_exact_id integer not null default 0,
  variants_merged_by_colorway integer not null default 0,
  variants_with_cross_source_agreement integer not null default 0,

  -- Latency, split exactly the way the phase targets are stated: time to the
  -- first useful match is a different number from time to a complete result,
  -- and conflating them is how a p95 gets reported against the wrong thing.
  first_useful_match_ms integer,
  complete_ms integer not null,
  deadline_exceeded boolean not null default false,
  partial boolean not null default false,

  -- Per-provider execution record: [{source,status,durationMs,rawCount}, ...]
  providers jsonb not null default '[]'::jsonb,

  -- Opaque hex digest supplied by the caller, or null. Never an identifier.
  correlation_hash text,

  app_platform text,
  app_version text,

  constraint product_match_events_tier_check check (
    tier in ('EXACT', 'LIKELY_EXACT', 'PRODUCT_FAMILY', 'SIMILAR', 'NO_CONFIDENT_MATCH')
  ),
  constraint product_match_events_empty_reason_check check (
    empty_reason is null
    or empty_reason in ('no_query', 'no_eligible_providers', 'no_results', 'below_confidence')
  ),
  -- Enforced in the database as well as in telemetry.ts. A regex here is the
  -- backstop for the day someone writes a second emitter that forgets to call
  -- assertProductMatchTelemetry.
  constraint product_match_events_correlation_hash_check check (
    correlation_hash is null or correlation_hash ~ '^[0-9a-f]{8,64}$'
  ),
  constraint product_match_events_platform_check check (
    app_platform is null or app_platform in ('ios', 'android', 'web')
  )
);

comment on table public.product_match_events is
  'Service-role-only categorical product-match evidence. Contains no user identity, no scan identifier, no image reference, no query text, and no product titles or URLs.';

comment on column public.product_match_events.first_useful_match_ms is
  'Milliseconds from request start to the first match at a useful tier (anything other than NO_CONFIDENT_MATCH). Null when no useful match was reached.';

comment on column public.product_match_events.partial is
  'True when at least one provider was lost to a deadline or error while at least one other returned listings.';

-- Time-series reads dominate: "what did latency and tier mix look like last
-- week". A single descending index on created_at serves those; the tier and
-- platform filters are selective enough as a secondary scan at this volume.
create index if not exists product_match_events_created_at_idx
  on public.product_match_events (created_at desc);

create index if not exists product_match_events_tier_created_at_idx
  on public.product_match_events (tier, created_at desc);

alter table public.product_match_events enable row level security;

-- Service role only. Deliberately no anon/authenticated policy of any kind:
-- the absence of a SELECT policy is what makes this table unreadable by a
-- client, and that is the intended access model.
drop policy if exists "Service role can manage product match events" on public.product_match_events;
create policy "Service role can manage product match events"
  on public.product_match_events
  for all
  to service_role
  using (true)
  with check (true);
