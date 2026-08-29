-- RECOVERED FROM supabase_migrations.schema_migrations LEDGER (staging: yzqjvdfgefveprobvvyw)
-- version: 20260808115552
-- name: harden_trigger_function_search_path
-- statement_count: 1
-- This file was reconstructed read-only from the executed-statement ledger.
-- It reflects exactly what ran, but original comments/formatting/filename
-- may differ from whatever the true original migration source looked like.

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
