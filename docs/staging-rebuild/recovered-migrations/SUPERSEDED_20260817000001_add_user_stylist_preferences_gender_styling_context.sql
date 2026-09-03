-- SUPERSEDED -- MIG-03 (2026-09-02). Never applied to staging or production
-- (confirmed read-only via list_migrations on both projects) and NOT a
-- replayable migration: relocated here, out of supabase/migrations/, from its
-- original path supabase/migrations/20260817000001_add_user_stylist_preferences_
-- gender_styling_context.sql, added by commit 26d5e4c one day AFTER
-- 20260816120000_user_stylist_preferences_gender_context.sql already added the
-- identical column + CHECK constraint and was applied to staging (2026-08-16,
-- source commit 0346506) -- independent, duplicate authorship of the same
-- feature, most likely from a branch that had not picked up 0346506 yet.
--
-- This file is UNSAFE to ever replay after its sibling: the do-block below
-- RAISES AN EXCEPTION if the CHECK constraint already exists (see line ~22
-- below), rather than skipping like 20260816120000's `if not exists` guard
-- does. Applying both to any environment in filename order (816 then 817)
-- would abort the whole migration run on this file. Kept here for historical
-- reference only -- note its one genuine improvement over the file that
-- shipped, an existing-invalid-row check before adding the constraint, which
-- 20260816120000 does not have; if that validation is wanted going forward it
-- needs a new, forward-only reconciliation migration, not revival of this
-- file. See config/migration-authority-manifest.json's 20260816120000 entry
-- and the Build 34 migration-governance repair PR description for the full
-- reconciliation record.
--
-- Original header follows, unmodified:
--
-- Fix #5 (Build 29 clean repair): explicit, self-disclosed baseline styling
-- context for first-use Elise personalization.
--
-- This is NOT a demographic/identity field and must not be treated as one:
-- it is a nullable, user-chosen styling preference on the same narrow,
-- RLS-isolated table already used for display_name/avatar_id. No backfill,
-- no RLS change, no grant change, no auth change — the existing per-user
-- SELECT/INSERT/UPDATE policies on user_stylist_preferences already cover
-- this new column because they are defined on the row, not per-column.

alter table public.user_stylist_preferences
  add column if not exists gender_styling_context text;

comment on column public.user_stylist_preferences.gender_styling_context is
  'Explicit, self-disclosed baseline styling context (man / woman / prefer_not_to_say). '
  'Null means the first-use prompt has not been answered yet. Never inferred.';

do $$
declare
  invalid_row_count bigint;
begin
  if exists (
    select 1
    from pg_constraint
    where conrelid = 'public.user_stylist_preferences'::regclass
      and conname = 'user_stylist_preferences_gender_styling_context_check'
  ) then
    raise exception 'gender_styling_context CHECK constraint already exists';
  end if;

  select count(*) into invalid_row_count
  from public.user_stylist_preferences
  where gender_styling_context is not null
    and gender_styling_context not in ('man', 'woman', 'prefer_not_to_say');

  if invalid_row_count > 0 then
    raise exception 'Existing gender_styling_context values outside the allowed set: %', invalid_row_count;
  end if;

  alter table public.user_stylist_preferences
    add constraint user_stylist_preferences_gender_styling_context_check
    check (gender_styling_context is null or gender_styling_context in ('man', 'woman', 'prefer_not_to_say'));
end;
$$;
