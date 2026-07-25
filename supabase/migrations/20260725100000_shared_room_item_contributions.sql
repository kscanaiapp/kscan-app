-- Shared-room item contributions (iOS collaboration hotfix — LOCAL ONLY,
-- do not apply to production without owner approval).
--
-- Production already authorizes participant chat + reactions
-- (202606240001, 202606240002, DR-3), but dressing_room_items has no
-- contribution-ownership column and no recipient mutation policies, so
-- "add / edit own / remove own" cannot be enforced safely for recipients.
--
-- This additive migration:
--   1. adds created_by (contributor identity, server-derived default),
--   2. backfills existing rows to the room owner,
--   3. allows ACTIVE participants to insert items into rooms they can
--      access, with contributor identity pinned to auth.uid(),
--   4. allows contributors to update/delete ONLY their own contributions.
--
-- It reuses public.can_access_room_messages(room_id) — the deployed
-- canonical owner-or-active-participant predicate used by the chat
-- policies — so membership semantics stay identical across features.
-- Owner-only administration (room rename/delete, membership management)
-- is untouched. No unrestricted policy predicates anywhere.

alter table public.dressing_room_items
  add column if not exists created_by uuid references auth.users(id) on delete set null;

comment on column public.dressing_room_items.created_by is
  'Contributor identity (auth.uid() at insert). Backfilled to the room owner for pre-migration rows.';

-- Server-derived default: clients never supply contributor identity.
alter table public.dressing_room_items
  alter column created_by set default auth.uid();

update public.dressing_room_items i
   set created_by = r.user_id
  from public.dressing_rooms r
 where r.id = i.dressing_room_id
   and i.created_by is null;

create index if not exists dressing_room_items_created_by_idx
  on public.dressing_room_items (created_by);

-- Active participants (owner or joined, non-removed membership — the same
-- predicate the deployed chat policies use) may contribute items to rooms
-- they can access. Contributor identity must be the authenticated actor.
create policy "Active participants can insert room items"
  on public.dressing_room_items
  for insert
  to authenticated
  with check (
    created_by = (select auth.uid())
    and public.can_access_room_messages(dressing_room_id)
  );

-- Contributors may update ONLY their own contributions, and only while they
-- retain active access to the room. Owner-created and other members' items
-- remain covered exclusively by the existing owner policies.
create policy "Contributors can update own room items"
  on public.dressing_room_items
  for update
  to authenticated
  using (
    created_by = (select auth.uid())
    and public.can_access_room_messages(dressing_room_id)
  )
  with check (
    created_by = (select auth.uid())
    and public.can_access_room_messages(dressing_room_id)
  );

create policy "Contributors can delete own room items"
  on public.dressing_room_items
  for delete
  to authenticated
  using (
    created_by = (select auth.uid())
    and public.can_access_room_messages(dressing_room_id)
  );
