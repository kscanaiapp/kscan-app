-- Phase 2 expansion of the stylist avatar allowlist to sixteen IDs.
--
-- Replaces the Phase 1 CHECK constraint with the same named constraint that
-- now permits the six abstract presets and the ten shipped portrait presets.
-- No rows are rewritten, no RLS/policies/grants/triggers are changed, and the
-- foreign-key cascade on auth.users remains untouched.

do $$
declare
  invalid_row_count bigint;
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.user_stylist_preferences'::regclass
      and conname = 'user_stylist_preferences_avatar_id_check'
  ) then
    raise exception 'Phase 1 avatar allowlist constraint is not applied';
  end if;

  select count(*) into invalid_row_count
  from public.user_stylist_preferences
  where avatar_id not in (
    'elise_default',
    'editorial_plum',
    'chrome_muse',
    'deep_space',
    'cream_gold',
    'obsidian_orchid',
    'stylist_portrait_01',
    'stylist_portrait_02',
    'stylist_portrait_03',
    'stylist_portrait_04',
    'stylist_portrait_05',
    'stylist_portrait_06',
    'stylist_portrait_07',
    'stylist_portrait_08',
    'stylist_portrait_09',
    'stylist_portrait_10'
  );

  if invalid_row_count > 0 then
    raise exception 'user_stylist_preferences contains % invalid avatar_id row(s)', invalid_row_count;
  end if;
end
$$;

alter table public.user_stylist_preferences
  drop constraint user_stylist_preferences_avatar_id_check,
  add constraint user_stylist_preferences_avatar_id_check
  check (
    avatar_id in (
      'elise_default',
      'editorial_plum',
      'chrome_muse',
      'deep_space',
      'cream_gold',
      'obsidian_orchid',
      'stylist_portrait_01',
      'stylist_portrait_02',
      'stylist_portrait_03',
      'stylist_portrait_04',
      'stylist_portrait_05',
      'stylist_portrait_06',
      'stylist_portrait_07',
      'stylist_portrait_08',
      'stylist_portrait_09',
      'stylist_portrait_10'
    )
  );
