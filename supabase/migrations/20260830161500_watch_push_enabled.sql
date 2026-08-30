-- Build 34 / K+ Smart Watchlist V1 -- K5-C6: per-Watch alert opt-in.
--
-- Deliberately a column on the Watch row, not a global preference (master
-- build brief §51-52): notification permission is requested contextually,
-- only when the user picks "Buy under $X" and then says yes to "alert me",
-- never during onboarding/K+ activation/Watchlist-open. A denied OS
-- permission leaves the Watch valid with push_enabled = false -- creating a
-- Watch never depends on notification permission.

alter table public.user_commerce_watches
  add column if not exists push_enabled boolean not null default false;

comment on column public.user_commerce_watches.push_enabled is
  'True only after the user explicitly said yes to a post-creation "alert me" prompt AND the OS granted notification permission AND a device token was registered. Never set at Watch-creation time itself.';

create or replace function public.set_watch_push_enabled(
  p_user_id uuid,
  p_watch_id uuid,
  p_enabled boolean
)
returns public.user_commerce_watches
language plpgsql
security definer
set search_path = public
as $$
declare
  watch_row public.user_commerce_watches;
begin
  update public.user_commerce_watches
  set push_enabled = p_enabled
  where id = p_watch_id and user_id = p_user_id and deleted_at is null
  returning * into watch_row;

  if watch_row.id is null then
    raise exception 'watch not found' using errcode = 'P0002';
  end if;

  return watch_row;
end;
$$;

revoke all on function public.set_watch_push_enabled(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.set_watch_push_enabled(uuid, uuid, boolean) to service_role;
