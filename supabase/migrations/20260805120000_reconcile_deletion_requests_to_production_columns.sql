-- Forward reconciliation: bring public.deletion_requests up to the production
-- column contract.
--
-- WHY THIS IS NEEDED. The staging project began life as the website
-- privacy/waitlist backend and already had its own public.deletion_requests
-- table before the mobile lineage's 202605130003_deletion_requests ever ran
-- there. That migration creates the table with CREATE TABLE IF NOT EXISTS, so on
-- staging it silently no-opped and the pre-existing website-shaped table
-- survived. Object-level comparison against production
-- (wyyuqfdxucjksghsmhry, read-only) found staging missing three columns that
-- production defines:
--
--     processed_at                timestamptz null
--     confirmation_email_sent_at  timestamptz null
--     notes                       text        null
--
-- The later lifecycle migrations added every other production column to staging
-- correctly, because they use ALTER TABLE ... ADD COLUMN IF NOT EXISTS. Only the
-- three columns from the original CREATE were missed.
--
-- ADDITIVE ONLY. Staging additionally carries four legacy website-era columns
-- that production does not define: user_email, scheduled_deletion_date,
-- completed_at, internal_notes. They are deliberately NOT dropped here:
--   - dropping columns is destructive and this rebuild does not drop data;
--   - scheduled_deletion_date is NOT NULL but carries a default, and the other
--     three are nullable, so none of them can block an insert written against
--     the production contract;
--   - they are recorded as a known intentional staging difference in
--     docs/staging-rebuild/backend-authority-manifest.md.
--
-- These columns are nullable with no default in production, so adding them is
-- safe against the 2 existing staging rows and requires no backfill.

alter table public.deletion_requests
  add column if not exists processed_at timestamptz,
  add column if not exists confirmation_email_sent_at timestamptz,
  add column if not exists notes text;

comment on column public.deletion_requests.processed_at is
  'Production contract column, reconciled onto staging 2026-08-05.';
comment on column public.deletion_requests.confirmation_email_sent_at is
  'Production contract column, reconciled onto staging 2026-08-05.';
comment on column public.deletion_requests.notes is
  'Production contract column, reconciled onto staging 2026-08-05.';
