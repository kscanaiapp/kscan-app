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
