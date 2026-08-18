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
