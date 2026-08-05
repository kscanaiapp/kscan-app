-- Shared-room item contributions (iOS collaboration hotfix -- LOCAL ONLY,
-- do not apply to production without owner approval).
--
-- Contribution access must be stricter than the historical Room Chat helper:
-- a participant row alone is not enough. The participant must still be tied
-- through joined_via_share_id to an active, unrevoked, unexpired share for the
-- same room. The room owner remains an implicit collaborator.

-- Contributor identity is durable and immutable. Existing items were created
-- by the room owner, so backfill them before enforcing NOT NULL. Deleting a
-- contributor account deletes that contributor's items instead of leaving
-- ownerless rows behind; deleting an owner already cascades through the room.
alter table public.dressing_room_items
  add column if not exists created_by uuid
  references auth.users(id) on delete cascade;

comment on column public.dressing_room_items.created_by is
  'Immutable contributor identity. Existing rows are backfilled to the room owner; new rows default to auth.uid().';

alter table public.dressing_room_items
  alter column created_by set default auth.uid();

update public.dressing_room_items i
   set created_by = r.user_id
  from public.dressing_rooms r
 where r.id = i.dressing_room_id
   and i.created_by is null;

alter table public.dressing_room_items
  alter column created_by set not null;

create index if not exists dressing_room_items_created_by_idx
  on public.dressing_room_items (created_by);

-- Owner OR current participant/share relationship for this exact room.
-- SECURITY DEFINER avoids RLS recursion while every relation is fully
-- qualified and execution is denied to PUBLIC/anon.
create or replace function public.can_contribute_to_dressing_room(p_room_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and (
      exists (
        select 1
          from public.dressing_rooms dr
         where dr.id = p_room_id
           and dr.user_id = (select auth.uid())
      )
      or exists (
        select 1
          from public.dressing_room_participants drp
          join public.room_shares rs
            on rs.id = drp.joined_via_share_id
           and rs.room_id = p_room_id
         where drp.dressing_room_id = p_room_id
           and drp.user_id = (select auth.uid())
           and rs.is_active = true
           and rs.revoked_at is null
           and (rs.expires_at is null or rs.expires_at > now())
      )
    );
$$;

revoke all on function public.can_contribute_to_dressing_room(uuid) from public;
revoke all on function public.can_contribute_to_dressing_room(uuid) from anon;
grant execute on function public.can_contribute_to_dressing_room(uuid) to authenticated;

-- created_by and dressing_room_id are ownership coordinates, not editable
-- item attributes. Enforce immutability independently of client payloads and
-- RLS OR-composition with the existing owner policy.
create or replace function public.guard_dressing_room_item_contribution_identity()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.created_by is distinct from old.created_by then
    raise exception 'Contributor identity is immutable' using errcode = '42501';
  end if;
  if new.dressing_room_id is distinct from old.dressing_room_id then
    raise exception 'Dressing room identity is immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_dressing_room_item_contribution_identity()
  from public, anon, authenticated;

drop trigger if exists dressing_room_items_guard_contribution_identity
  on public.dressing_room_items;
create trigger dressing_room_items_guard_contribution_identity
before update of created_by, dressing_room_id on public.dressing_room_items
for each row
execute function public.guard_dressing_room_item_contribution_identity();

drop policy if exists "Active participants can insert room items"
  on public.dressing_room_items;
create policy "Active participants can insert room items"
  on public.dressing_room_items
  for insert
  to authenticated
  with check (
    created_by = (select auth.uid())
    and public.can_contribute_to_dressing_room(dressing_room_id)
  );

drop policy if exists "Contributors can update own room items"
  on public.dressing_room_items;
create policy "Contributors can update own room items"
  on public.dressing_room_items
  for update
  to authenticated
  using (
    created_by = (select auth.uid())
    and public.can_contribute_to_dressing_room(dressing_room_id)
  )
  with check (
    created_by = (select auth.uid())
    and public.can_contribute_to_dressing_room(dressing_room_id)
  );

drop policy if exists "Contributors can delete own room items"
  on public.dressing_room_items;
create policy "Contributors can delete own room items"
  on public.dressing_room_items
  for delete
  to authenticated
  using (
    created_by = (select auth.uid())
    and public.can_contribute_to_dressing_room(dressing_room_id)
  );

-- Table CRUD grants already exist in
-- 202606180001_fix_staging_grants_saved_scans_soft_delete.sql and are retained.
-- RLS remains the row-level security boundary; room administration policies
-- are not changed here.
