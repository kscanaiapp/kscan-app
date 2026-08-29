-- Migration provenance (restored by maintenance/staging-migration-authority-reconciliation, 2026-08-29).
--
-- Owning repository: kscan-app
-- Original authored file: (same name)
-- Original source commit: fd35e91
-- Applied to staging (yzqjvdfgefveprobvvyw) as ledger version: 20260808115552
--
-- SQL below reproduces the exact statements Postgres executed on staging
-- (recovered from supabase_migrations.schema_migrations.statements).
-- See docs/staging-rebuild/recovered-migrations/LEDGER_INTEGRITY_CHECK.md
-- for source/ledger SHA-256 hashes and full verification detail.

-- Pin search_path on the four remaining mutable-search_path functions.
--
-- Supabase advisor: function_search_path_mutable. A function without a pinned
-- search_path resolves unqualified names against the caller's search_path, so a
-- caller-controlled schema earlier in the path can shadow an intended object.
--
-- All four bodies were read from live staging before this change. Each references
-- only NEW and pg_catalog built-ins (now, btrim, coalesce, nullif, char_length) and
-- touches no table or schema-qualified object, so pinning the path is behaviour-
-- preserving. Signatures and bodies are unchanged: ALTER FUNCTION ... SET only
-- attaches the configuration parameter.
--
-- Forward-only. Applied migrations are never edited to change live history.

alter function public.normalize_dressing_room_note() set search_path = pg_catalog, public;
alter function public.set_profiles_updated_at() set search_path = pg_catalog, public;
alter function public.set_style_objects_updated_at() set search_path = pg_catalog, public;
alter function public.set_updated_at() set search_path = pg_catalog, public;
