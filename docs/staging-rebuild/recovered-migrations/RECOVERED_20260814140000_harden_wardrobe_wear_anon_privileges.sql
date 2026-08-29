-- RECOVERED FROM supabase_migrations.schema_migrations LEDGER (staging: yzqjvdfgefveprobvvyw)
-- version: 20260814140000
-- name: harden_wardrobe_wear_anon_privileges
-- statement_count: 1
--
-- IMPORTANT PROVENANCE NOTE: this migration's own committed comment states
-- "Source of truth: supabase/migrations/20260814140000_harden_wardrobe_wear_anon_privileges.sql"
-- -- i.e. it claims a real committed file with this exact name/path exists
-- somewhere. It was NOT found on maintenance/b34-def001-backend-authority or
-- integration/*-build34-maintenance-v1. Search across all branches/worktrees
-- for this exact filename before treating this recovered copy as canonical.

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
