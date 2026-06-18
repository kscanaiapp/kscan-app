-- Migration: create_waitlist_signups_main_backend
-- Task:      KS-INFRA-001A — Waitlist consolidation into the main K Scan backend
-- Source:    KScan waitlist Project        (ref wyyuqfdxucjksghsmhry)  [legacy, retained, untouched]
-- Dest:      K Scan Privacy Controls        (ref yzqjvdfgefveprobvvyw)  [current production/store backend]
--
-- Posture:   ADDITIVE ONLY. Creates a NEW table for FUTURE waitlist signups.
--            This migration does NOT import any historical rows (decision = Outcome A,
--            fresh start). Historical data remains in the retained source project.
--            Idempotent guards (if not exists) make the migration safe to re-run.
--
-- Access:    Server-side (service_role) insert ONLY. This mirrors the source table,
--            whose only policy was "Service key only access" (service_role). RLS is
--            enabled and NO public policy is created, so anon/authenticated cannot
--            read, insert, update, or delete. Broad default grants are revoked for
--            defense-in-depth. Direct public (anon) insert from a website, if ever
--            wanted, is a deliberate, separate migration.
--
-- Review:    No DROP / TRUNCATE / DELETE / ALTER DROP COLUMN / DISABLE RLS.
--            No FK to auth.users. No public SELECT grant. No service_role policy.
--            No existing table modified. Transaction-wrapped.

begin;

create table if not exists public.waitlist_signups (
  id                   uuid        primary key default gen_random_uuid(),
  email                text        not null,
  name                 text        null,
  source               text        null,
  page                 text        null,
  referrer             text        null,
  consent_recorded_at  timestamptz null,
  metadata             jsonb       not null default '{}'::jsonb,
  created_at           timestamptz not null default now(),
  imported_from        text        null,
  imported_at          timestamptz null,

  constraint waitlist_signups_email_check
    check (position('@' in email) > 1),

  constraint waitlist_signups_metadata_object_check
    check (jsonb_typeof(metadata) = 'object')
);

-- Case-insensitive uniqueness on email (source used a case-sensitive UNIQUE;
-- lower(email) is stricter and prevents Foo@x.com / foo@x.com duplicates).
create unique index if not exists waitlist_signups_email_unique_idx
  on public.waitlist_signups (lower(email));

create index if not exists waitlist_signups_created_at_idx
  on public.waitlist_signups (created_at desc);

alter table public.waitlist_signups enable row level security;

-- Defense-in-depth: remove the broad default grants Supabase attaches to new
-- public tables. Public roles get NO table access; RLS is the second gate.
revoke all on public.waitlist_signups from anon;
revoke all on public.waitlist_signups from authenticated;

-- NOTE: intentionally no policy is created.
--   * service_role bypasses RLS, so server-side inserts continue to work.
--   * anon / authenticated are blocked by both the missing grant and missing policy.
-- If public website signup must insert directly (anon), add a dedicated
-- INSERT-only policy + grant in a later migration after a human decision.

comment on table public.waitlist_signups is
  'K Scan waitlist signups (consolidated main backend). Server-side/service_role insert only; '
  'RLS enabled with no public policies, so anon/authenticated cannot read, insert, update, or delete. '
  'Future direct public insert requires a separate policy migration.';

comment on column public.waitlist_signups.source is
  'Origin surface of the signup (e.g. website page, app). No default: caller must set it explicitly.';
comment on column public.waitlist_signups.metadata is
  'Arbitrary structured metadata (utm, campaign, etc.); must be a JSON object.';
comment on column public.waitlist_signups.imported_from is
  'Provenance tag for rows migrated from a legacy project (e.g. source project ref). NULL for organic signups.';
comment on column public.waitlist_signups.imported_at is
  'Timestamp a historical row was imported. NULL for organic signups.';

commit;
