-- Migration provenance (restored by maintenance/staging-migration-authority-reconciliation, 2026-08-29).
--
-- Owning repository: kscan-app
-- Original authored file: (same name)
-- Original source commit: 3d38744
-- Applied to staging (yzqjvdfgefveprobvvyw) as ledger version: 20260814140000
--
-- SQL below reproduces the exact statements Postgres executed on staging
-- (recovered from supabase_migrations.schema_migrations.statements).
-- See docs/staging-rebuild/recovered-migrations/LEDGER_INTEGRITY_CHECK.md
-- for source/ledger SHA-256 hashes and full verification detail.

-- Build 29 Closet V2 / S7B — anon privilege hardening for the two pre-existing
-- wear-history utility tables. Source of truth:
-- supabase/migrations/20260814140000_harden_wardrobe_wear_anon_privileges.sql
--
-- Privilege layer only. No DDL, no RLS or policy change, no data touched.
-- authenticated privileges are restated exactly as
-- 20260704175544_free_tier_utility_tables.sql already grants them, because
-- revoking from PUBLIC can strip a privilege the role was inheriting rather
-- than holding directly.

revoke all on public.wardrobe_wear_events from anon, public;

grant select, insert, update, delete
  on public.wardrobe_wear_events to authenticated;

revoke all on public.wardrobe_utility_items from anon, public;

grant select, insert, update, delete
  on public.wardrobe_utility_items to authenticated;
