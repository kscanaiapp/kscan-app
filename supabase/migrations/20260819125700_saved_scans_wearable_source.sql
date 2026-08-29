-- Migration provenance (restored by maintenance/staging-migration-authority-reconciliation, 2026-08-29).
--
-- Owning repository: kscan-app
-- Original authored file: none found in kscan-app or kscan-glasses-webapp
-- Original source commit: none
-- Applied to staging (yzqjvdfgefveprobvvyw) as ledger version: 20260819125700
-- No standalone authored source found. Superseded same-day by 20260819144630 below, which preserves this migration's effect ('wearable') while adding 'meta_wearable'. Included for completeness of kscan-app's own saved_scans schema history.
--
-- SQL below reproduces the exact statements Postgres executed on staging
-- (recovered from supabase_migrations.schema_migrations.statements).
-- See docs/staging-rebuild/recovered-migrations/LEDGER_INTEGRITY_CHECK.md
-- for source/ledger SHA-256 hashes and full verification detail.

-- Additive extension: allow wearable source for scans originated from Google XR / Meta glasses.
-- Does not affect existing rows; NULL remains valid.

alter table public.saved_scans drop constraint if exists saved_scans_source_check;

alter table public.saved_scans add constraint saved_scans_source_check
  check (source is null or source = any (array['mobile'::text, 'web'::text, 'system'::text, 'wearable'::text]));
