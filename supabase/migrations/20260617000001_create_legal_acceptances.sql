-- Legal Acceptance Persistence for K Scan AI
-- Immutable audit table for terms, privacy, and minimum-age confirmations.

create table if not exists public.legal_acceptances (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  acceptance_type text not null,
  policy_version text not null,
  accepted_at timestamptz not null default now(),
  source text not null default 'mobile',
  app_version text null,
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

drop policy if exists "Users can read their own legal acceptances" on public.legal_acceptances;
create policy "Users can read their own legal acceptances"
on public.legal_acceptances
for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists "Users can insert their own legal acceptances" on public.legal_acceptances;
create policy "Users can insert their own legal acceptances"
on public.legal_acceptances
for insert
to authenticated
with check (auth.uid() = user_id);

create index if not exists legal_acceptances_user_id_idx
on public.legal_acceptances(user_id);

create index if not exists legal_acceptances_user_type_idx
on public.legal_acceptances(user_id, acceptance_type);

create index if not exists legal_acceptances_accepted_at_idx
on public.legal_acceptances(accepted_at);

revoke all on public.legal_acceptances from anon;
grant select, insert on public.legal_acceptances to authenticated;
