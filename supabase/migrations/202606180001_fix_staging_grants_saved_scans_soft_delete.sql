-- KS-REL-005E
-- Fix authenticated table grants and saved_scans soft-delete RLS.
-- Staging-discovered defect; RLS remains the security boundary.

grant usage on schema public to authenticated;

grant select, insert, update, delete on table
  public.profiles,
  public.privacy_settings,
  public.saved_scans,
  public.dressing_rooms,
  public.dressing_room_items,
  public.dressing_room_messages,
  public.inspiration_items,
  public.style_chat_sessions,
  public.style_chat_messages,
  public.style_memory_events
to authenticated;

-- legal_acceptances is an immutable compliance ledger.
-- Users may create and read their own records only.
grant select, insert on table public.legal_acceptances to authenticated;
revoke update, delete on table public.legal_acceptances from authenticated;

-- Drop all existing saved_scans policies so the table has one known policy set.
do $$
declare
  pol record;
begin
  for pol in
    select policyname
    from pg_policies
    where schemaname = 'public'
      and tablename = 'saved_scans'
  loop
    execute format('drop policy if exists %I on public.saved_scans', pol.policyname);
  end loop;
end $$;

alter table public.saved_scans enable row level security;

create policy "saved_scans_select_own_active"
on public.saved_scans
for select
to authenticated
using (
  auth.uid() = user_id
  and deleted_at is null
);

create policy "saved_scans_insert_own_active"
on public.saved_scans
for insert
to authenticated
with check (
  auth.uid() = user_id
  and deleted_at is null
);

create policy "saved_scans_update_own_active"
on public.saved_scans
for update
to authenticated
using (
  auth.uid() = user_id
  and deleted_at is null
)
with check (
  auth.uid() = user_id
);

-- No client DELETE policy: saved_scans removal is soft-delete only via UPDATE.
