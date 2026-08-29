-- RECOVERED FROM supabase_migrations.schema_migrations LEDGER (staging: yzqjvdfgefveprobvvyw)
-- version: 20260819125700
-- name (embedded original timestamp): 20260819020000_saved_scans_wearable_source
-- statement_count: 1
-- NOTE: modifies public.saved_scans (a kscan-app table), unlike the sibling
-- wearable_* migrations which create wearable-only tables. This one likely
-- DOES belong in this repo's history, superseded/widened by 20260819144630
-- below.

-- Additive extension: allow wearable source for scans originated from Google XR / Meta glasses.
-- Does not affect existing rows; NULL remains valid.

alter table public.saved_scans drop constraint if exists saved_scans_source_check;

alter table public.saved_scans add constraint saved_scans_source_check
  check (source is null or source = any (array['mobile'::text, 'web'::text, 'system'::text, 'wearable'::text]));
