-- Migration provenance (restored by maintenance/staging-migration-authority-reconciliation, 2026-08-29).
--
-- Owning repository: kscan-app
-- Original authored file: kscan-glasses-webapp: supabase/migrations/20260819000001_add_wearable_pairing_session.sql (bundled with unrelated wearable-table DDL, not a standalone kscan-app file)
-- Original source commit: 9311442 (kscan-glasses-webapp)
-- Applied to staging (yzqjvdfgefveprobvvyw) as ledger version: 20260819144630
-- This migration alters a kscan-app-owned table (saved_scans) but was authored inside kscan-glasses-webapp's own migration file alongside its wearable tables. Included here because kscan-app's own schema history for its own table should not depend on a different repository.
--
-- SQL below reproduces the exact statements Postgres executed on staging
-- (recovered from supabase_migrations.schema_migrations.statements).
-- See docs/staging-rebuild/recovered-migrations/LEDGER_INTEGRITY_CHECK.md
-- for source/ledger SHA-256 hashes and full verification detail.

-- Widen saved_scans.source to accept 'meta_wearable' while PRESERVING the
-- existing 'wearable' value already present in the staging constraint.
-- Shape mirrors the deployed constraint (source IS NULL OR source = ANY(...)).
ALTER TABLE public.saved_scans DROP CONSTRAINT IF EXISTS saved_scans_source_check;
ALTER TABLE public.saved_scans ADD CONSTRAINT saved_scans_source_check
  CHECK ((source IS NULL) OR (source = ANY (ARRAY['mobile'::text, 'web'::text, 'system'::text, 'wearable'::text, 'meta_wearable'::text])));
