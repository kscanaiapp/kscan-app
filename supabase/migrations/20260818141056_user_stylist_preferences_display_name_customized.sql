-- Migration provenance (restored by maintenance/staging-migration-authority-reconciliation, 2026-08-29).
--
-- Owning repository: kscan-app
-- Original authored file: supabase/migrations/20260818000001_add_user_stylist_preferences_display_name_customized.sql
-- Original source commit: 6e97fcf
-- Applied to staging (yzqjvdfgefveprobvvyw) as ledger version: 20260818141056
-- Authored filename timestamp (20260818000001) differs from the Management-API-assigned ledger version; never renamed in source control.
--
-- SQL below reproduces the exact statements Postgres executed on staging
-- (recovered from supabase_migrations.schema_migrations.statements).
-- See docs/staging-rebuild/recovered-migrations/LEDGER_INTEGRITY_CHECK.md
-- for source/ledger SHA-256 hashes and full verification detail.

-- Fix #6 (Build 29 clean repair): distinguish an explicit, user-chosen stylist
-- name from the untouched historical default.
--
-- display_name stays `not null default 'Elise'` exactly as it always has —
-- every existing consumer of that column is unaffected. This adds one
-- narrow, additive boolean: true only when the user has explicitly saved a
-- name through PersonalizeStylistModal. Existing rows automatically default
-- to false when this column is added, which is not a guessed backfill — it
-- is the objectively correct value, since no row could have been "explicitly
-- customized" through a code path that did not exist yet.
--
-- No RLS/policy/grant/auth change: the table's existing per-owner row-level
-- policies already cover this new column because they are defined on the
-- row, not per-column.

alter table public.user_stylist_preferences
  add column if not exists display_name_customized boolean not null default false;

comment on column public.user_stylist_preferences.display_name_customized is
  'True only when the user explicitly set display_name themselves. False (the '
  'default, including for every pre-Fix-#6 row) means display_name is not an '
  'authoritative override — resolve the canonical name for avatar_id instead.';
