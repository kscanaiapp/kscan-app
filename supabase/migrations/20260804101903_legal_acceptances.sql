-- Recovered migration source for staging history row 20260804101903.
--
-- PROVENANCE: this file did not exist in source control. Its SQL was recovered
-- verbatim from the target project's own authoritative record --
-- supabase_migrations.schema_migrations.statements on yzqjvdfgefveprobvvyw --
-- and is reproduced here so staging's applied history is fully backed by
-- source. Nothing was invented, and no migration-history row was hand-edited.
--
-- WHY IT EXISTS SEPARATELY: staging applied legal_acceptances under this
-- version, while the production lineage applies the equivalent table under
-- 20260617000001_create_legal_acceptances. That is a history-only difference:
-- the resulting table, constraints, RLS policies and grants are identical, so
-- no schema divergence follows from it. Without this file the remote history
-- row has no local counterpart, and controlled migration tooling refuses to
-- proceed -- the alternative being a `migration repair`, which this rebuild
-- does not permit.
--
-- SAFE TO REPLAY: every statement is idempotent (create table if not exists,
-- drop policy if exists before create policy), so applying it after
-- 20260617000001 has already created the table is a no-op.

create table if not exists public.legal_acceptances (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  acceptance_type text not null,
  policy_version text not null,
  accepted_at timestamptz not null default now(),
  source text not null default 'mobile',
  app_version text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint legal_acceptances_acceptance_type_check
    check (acceptance_type in ('terms', 'privacy', 'minimum_age')),
  constraint legal_acceptances_source_check
    check (source in ('mobile', 'web', 'admin', 'system')),
  constraint legal_acceptances_policy_version_nonempty_check
    check (length(trim(policy_version)) > 0),
  constraint legal_acceptances_metadata_object_check
    check (jsonb_typeof(metadata) = 'object'),
  constraint legal_acceptances_user_type_version_unique
    unique (user_id, acceptance_type, policy_version)
);

alter table public.legal_acceptances enable row level security;

drop policy if exists "Users can insert their own legal acceptances" on public.legal_acceptances;
create policy "Users can insert their own legal acceptances"
on public.legal_acceptances
for insert
to authenticated
with check (auth.uid() = user_id);

drop policy if exists "Users can read their own legal acceptances" on public.legal_acceptances;
create policy "Users can read their own legal acceptances"
on public.legal_acceptances
for select
to authenticated
using (auth.uid() = user_id);

grant insert, select on public.legal_acceptances to authenticated;
