-- Migration provenance (restored by maintenance/staging-migration-authority-reconciliation, 2026-08-29).
--
-- Owning repository: kscan-app
-- Original authored file: (same name)
-- Original source commit: 0346506
-- Applied to staging (yzqjvdfgefveprobvvyw) as ledger version: 20260816120000
--
-- SQL below reproduces the exact statements Postgres executed on staging
-- (recovered from supabase_migrations.schema_migrations.statements).
-- See docs/staging-rebuild/recovered-migrations/LEDGER_INTEGRITY_CHECK.md
-- for source/ledger SHA-256 hashes and full verification detail.

-- Elise first-use styling-department context (Build 29 QA fix #5).
--
-- Adds a single nullable column to the existing, RLS-hardened
-- user_stylist_preferences table rather than a new table: that table is
-- already the narrow, client-writable "Elise customer experience
-- preferences" surface (see 20260713000001_user_stylist_preferences.sql),
-- with owner-only select/insert/update policies and account-deletion
-- cascade already in place. No RLS or grant changes are required here.
--
-- This is an explicit, user-provided styling baseline (Man / Woman / Choose
-- not to say) used only when the user selects it themselves. It is never
-- inferred from photos, names, voice, Closet items, avatar choice, or scan
-- history. NULL means "not yet answered" and is the default for every
-- existing row, so no backfill is required or attempted.

alter table public.user_stylist_preferences
  add column if not exists gender_styling_context text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'user_stylist_preferences_gender_styling_context_check'
      and conrelid = 'public.user_stylist_preferences'::regclass
  ) then
    alter table public.user_stylist_preferences
      add constraint user_stylist_preferences_gender_styling_context_check
      check (gender_styling_context is null or gender_styling_context in ('man', 'woman', 'prefer_not_to_say'));
  end if;
end;
$$;

comment on column public.user_stylist_preferences.gender_styling_context is
  'Explicit, user-selected Elise styling baseline (man/woman/prefer_not_to_say) or NULL when unanswered. Never inferred.';
