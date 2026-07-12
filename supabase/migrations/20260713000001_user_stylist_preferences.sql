-- Narrow user-facing stylist identity preference table.
--
-- This table stores only the editable customer-facing display name and local
-- avatar preset for the unified Elise layer. It does NOT replace or rename any
-- internal identifiers (StyleChat, AI Stylist, stylechat-generate, etc.).
--
-- RLS guarantees row-level isolation: an authenticated user can only read,
-- insert, or update their own row. Account deletion cascades automatically via
-- the auth.users foreign key, and the user_id column is immutable to callers.

create table if not exists public.user_stylist_preferences (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'Elise',
  avatar_id    text not null default 'elise_default',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint display_name_length check (char_length(trim(display_name)) between 2 and 24),
  constraint no_control_chars check (display_name !~ '[\x00-\x1F\x7F]')
);

comment on table public.user_stylist_preferences is
  'User-facing stylist identity preferences for the Elise customer experience.';
comment on column public.user_stylist_preferences.display_name is
  'Customer-facing stylist display name; validated between 2 and 24 visible characters.';
comment on column public.user_stylist_preferences.avatar_id is
  'Reference to a bundled local avatar preset; no remote URLs or user uploads.';

alter table public.user_stylist_preferences enable row level security;

-- Authenticated users can only see their own preference row.
create policy "Users can select own stylist preferences"
  on public.user_stylist_preferences
  for select
  to authenticated
  using (auth.uid() = user_id);

-- Authenticated users can only insert their own row.
create policy "Users can insert own stylist preferences"
  on public.user_stylist_preferences
  for insert
  to authenticated
  with check (auth.uid() = user_id);

-- Authenticated users can only update their own row; user_id is immutable.
create policy "Users can update own stylist preferences"
  on public.user_stylist_preferences
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Service role retains CRUD for account-deletion orchestration and migrations.
grant select, insert, update, delete on public.user_stylist_preferences to service_role;

-- App/authenticated roles should not have direct table grants beyond what RLS
-- provides; this migration follows the hardened privilege baseline.
revoke truncate, references, trigger, maintain on public.user_stylist_preferences
  from anon, authenticated, service_role;

-- Lightweight updated_at trigger for preference rows.
create or replace function public.set_user_stylist_preferences_updated_at()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

revoke all on function public.set_user_stylist_preferences_updated_at() from public;
grant execute on function public.set_user_stylist_preferences_updated_at() to authenticated, service_role;

do $$
begin
  if not exists (
    select 1
    from pg_trigger
    where tgname = 'user_stylist_preferences_updated_at'
      and tgrelid = 'public.user_stylist_preferences'::regclass
  ) then
    create trigger user_stylist_preferences_updated_at
      before update on public.user_stylist_preferences
      for each row
      execute function public.set_user_stylist_preferences_updated_at();
  end if;
end;
$$;
