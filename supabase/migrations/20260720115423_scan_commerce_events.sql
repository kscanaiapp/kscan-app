-- Additive, idempotent commerce outcome telemetry (v123).
-- Reconciled into source from production migration ledger
-- (project wyyuqfdxucjksghsmhry). Already applied in production —
-- do not re-apply. Present here so local migration history matches prod.
create table if not exists public.scan_commerce_events (
  id                            uuid        primary key default gen_random_uuid(),
  created_at                    timestamptz not null default now(),
  request_mode                  text        not null,
  source_class                  text,
  app_platform                  text,
  app_version                   text,
  status                        text        not null,
  is_fashion                    boolean     not null default false,
  category_route                text,
  quality_band                  text,
  commerce_query_detail_level   text,
  provider_outcome              text,
  providers_tried               text[],
  primary_result_count          integer,
  fallback_used                 boolean     not null default false,
  products_before_filter        integer,
  products_after_filter         integer,
  products_before_dedupe        integer,
  products_after_dedupe         integer,
  category_mismatch_removals    integer,
  retailer_count                integer,
  commerce_duration_ms          integer,
  total_duration_ms             integer,
  failure_reason                text,
  quality_tune_version          text,
  scanner_intelligence_version  text,
  commerce_relevance_version    text,
  textscan_parity_version       text,
  correlation_hash              text
);

create index if not exists scan_commerce_events_created_at_idx
  on public.scan_commerce_events (created_at desc);

create index if not exists scan_commerce_events_request_mode_idx
  on public.scan_commerce_events (request_mode);

create index if not exists scan_commerce_events_category_route_idx
  on public.scan_commerce_events (category_route);

create index if not exists scan_commerce_events_provider_outcome_idx
  on public.scan_commerce_events (provider_outcome);

create index if not exists scan_commerce_events_failure_reason_idx
  on public.scan_commerce_events (failure_reason);

alter table public.scan_commerce_events enable row level security;

revoke all on public.scan_commerce_events from anon, authenticated;

grant insert, select on public.scan_commerce_events to service_role;

drop policy if exists "Service role can manage scan commerce events" on public.scan_commerce_events;

create policy "Service role can manage scan commerce events"
  on public.scan_commerce_events
  for all
  to service_role
  using (true)
  with check (true);
