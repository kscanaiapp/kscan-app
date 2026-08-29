-- RECOVERED FROM supabase_migrations.schema_migrations LEDGER (staging: yzqjvdfgefveprobvvyw)
-- version: 20260824175813
-- name: create_investor_inquiries
-- statement_count: 1
--
-- PROVENANCE NOTE: "investor_inquiries" with a "page" column and a
-- service-role-only policy has no relationship to the K Scan AI mobile app
-- at all -- this is almost certainly the marketing website's investor
-- contact form (kscan-website repo), sharing this same Supabase staging
-- project the way the documented "website privacy stack" tables
-- (privacy-controls, public-sale-share-opt-out) already do per
-- config/backend-authority.json's notGoverned block. Check kscan-website
-- before assuming this belongs in kscan-app's migration history at all.

create table public.investor_inquiries (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  firm text,
  message text,
  page text,
  created_at timestamptz not null default now()
);

alter table public.investor_inquiries enable row level security;

create policy "allow_service_role_all"
  on public.investor_inquiries
  for all
  to service_role
  using (true)
  with check (true);
