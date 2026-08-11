-- Fixture: false positive guard. The dangerous statements below appear ONLY
-- inside comments (a rollback note, which this repo genuinely does write --
-- see supabase/migrations/20260806153233_dressing_room_user_blocking_ROLLBACK.md).
-- The detector must not flag commented-out DDL.
--
-- Rollback (documentation only, never executed by this migration):
--   drop table public.dressing_room_user_blocks;
--   alter table public.dressing_room_participants drop column left_at;
--   truncate public.some_table;

/*
 * Block-comment form of the same note:
 *   drop table public.another_thing;
 */

create table if not exists public.release_drill_notes (
  id uuid primary key default gen_random_uuid(),
  note text not null
);
