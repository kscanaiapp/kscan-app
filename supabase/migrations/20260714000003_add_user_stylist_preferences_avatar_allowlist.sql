-- Phase 1 server-side allowlist for shipped abstract stylist avatars.
--
-- RLS controls row ownership, not column values. Refuse to add the constraint
-- when unsupported existing values are present; remediation must be an
-- explicit separate decision, never an implicit rewrite in this migration.

do $$
declare
  unsupported_row_count bigint;
begin
  select count(*)
    into unsupported_row_count
  from public.user_stylist_preferences
  where avatar_id not in (
    'elise_default',
    'editorial_plum',
    'chrome_muse',
    'deep_space',
    'cream_gold',
    'obsidian_orchid'
  );

  if unsupported_row_count > 0 then
    raise exception using
      errcode = 'check_violation',
      message = format(
        'user_stylist_preferences has %s unsupported avatar_id row(s); explicit remediation is required',
        unsupported_row_count
      );
  end if;
end
$$;

alter table public.user_stylist_preferences
  add constraint user_stylist_preferences_avatar_id_check
  check (
    avatar_id in (
      'elise_default',
      'editorial_plum',
      'chrome_muse',
      'deep_space',
      'cream_gold',
      'obsidian_orchid'
    )
  );
