-- KScan Closet fix (integration/free-tier-beta-into-style-dna)
-- Physical Android beta smoke found two release-blocking Closet issues. Both are
-- scoped to the inspiration/closet feature and fixed here.
--
-- 1) Deleting an uploaded Closet/Inspiration item failed with
--    "new row violates row-level security policy for table inspiration_items".
--    Cause: deleteInspirationItem() performs a SOFT delete (sets deleted_at),
--    but the SELECT policy required deleted_at IS NULL. The post-update row no
--    longer satisfied that visibility predicate, so Postgres rejected the
--    UPDATE. Fix mirrors the existing saved_scans precedent
--    (202606180002_fix_saved_scans_soft_delete_select_policy): keep OWNERSHIP as
--    the SELECT RLS boundary. Active lists already filter "deleted_at is null"
--    explicitly in the query layer (services/styleObjects.ts).
--
-- 2) Closet items could not be added to Dressing Rooms. Cause: the link table
--    dressing_room_inspiration_items had NO privileges granted to the
--    authenticated role (only service_role), so every add/remove/list returned
--    "permission denied for table dressing_room_inspiration_items". Grant the
--    standard authenticated privileges (per-row ownership is still enforced by
--    RLS) and align its SELECT policy with the same soft-delete-safe pattern so
--    "remove from room" (also a soft delete) does not hit issue #1.

-- ── 1. inspiration_items: ownership-only SELECT so owner soft-delete succeeds ──
drop policy if exists "inspiration_items_select" on public.inspiration_items;

create policy "inspiration_items_select"
  on public.inspiration_items
  for select
  to authenticated
  using (user_id = auth.uid());

-- ── 2. dressing_room_inspiration_items: authenticated grants + safe SELECT ─────
grant select, insert, update, delete
  on public.dressing_room_inspiration_items
  to authenticated;

drop policy if exists "dressing_room_inspiration_select"
  on public.dressing_room_inspiration_items;

create policy "dressing_room_inspiration_select"
  on public.dressing_room_inspiration_items
  for select
  to authenticated
  using (
    user_id = auth.uid()
    and exists (
      select 1 from public.dressing_rooms dr
      where dr.id = room_id and dr.user_id = auth.uid()
    )
  );
