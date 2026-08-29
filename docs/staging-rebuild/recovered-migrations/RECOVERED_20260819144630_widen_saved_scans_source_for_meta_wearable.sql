-- RECOVERED FROM supabase_migrations.schema_migrations LEDGER (staging: yzqjvdfgefveprobvvyw)
-- version: 20260819144630
-- name: widen_saved_scans_source_for_meta_wearable
-- statement_count: 1
-- Supersedes RECOVERED_20260819125700 by widening the same constraint again.

-- Widen saved_scans.source to accept 'meta_wearable' while PRESERVING the
-- existing 'wearable' value already present in the staging constraint.
-- Shape mirrors the deployed constraint (source IS NULL OR source = ANY(...)).
ALTER TABLE public.saved_scans DROP CONSTRAINT IF EXISTS saved_scans_source_check;
ALTER TABLE public.saved_scans ADD CONSTRAINT saved_scans_source_check
  CHECK ((source IS NULL) OR (source = ANY (ARRAY['mobile'::text, 'web'::text, 'system'::text, 'wearable'::text, 'meta_wearable'::text])));
