-- Privacy-safe model attribution for active LLM workloads.
-- Stores categorical routing metadata only: never user content or identity.

create table if not exists public.llm_routing_events (
  id                        uuid        primary key default gen_random_uuid(),
  request_id                text        not null check (length(request_id) between 8 and 160),
  surface                   text        not null check (surface in ('scanner', 'textscan', 'elise', 'dressing_room')),
  primary_model             text        not null check (length(primary_model) between 1 and 120),
  served_model              text        not null check (length(served_model) between 1 and 120),
  fallback_used             boolean     not null,
  fallback_reason           text,
  attempt_count             integer     not null check (attempt_count between 1 and 3),
  latency_ms                integer     not null check (latency_ms >= 0),
  provider_status           text        not null check (length(provider_status) between 1 and 80),
  response_valid            boolean     not null,
  quota_status              text,
  signature_style_included  boolean,
  created_at                timestamptz not null default now(),
  unique (surface, request_id)
);

create index if not exists llm_routing_events_created_at_idx
  on public.llm_routing_events (created_at desc);

alter table public.llm_routing_events enable row level security;

revoke all on table public.llm_routing_events from public, anon, authenticated;
grant select, insert on table public.llm_routing_events to service_role;

drop policy if exists "Service role can manage LLM routing events"
  on public.llm_routing_events;
create policy "Service role can manage LLM routing events"
  on public.llm_routing_events
  for all
  to service_role
  using (true)
  with check (true);

comment on table public.llm_routing_events is
  'Service-role-only categorical LLM routing evidence. Contains no user identity, prompts, messages, images, or provider response bodies.';
