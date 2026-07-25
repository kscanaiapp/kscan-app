-- Shared-room recipient read policies (Batch 6B, owner-approved).
--
-- Product model: shared rooms are collaborative resources — access follows
-- active membership. stylechat-generate resolves shared-room attachment
-- evidence under the CALLER's RLS (defense in depth: no service-role key),
-- and legitimate room participants need the same authorized visibility.
-- Recipients previously had no SELECT path on room_shares, dressing_rooms,
-- or dressing_room_items, so authorized shared attachments always denied.
--
-- These three additive PERMISSIVE policies compose with the existing
-- owner-only policies (owner OR recipient) and the restrictive
-- "Account must be active (deletion guard)" policies still apply on top.
-- room_shares carries no invitation PII (token/state/ids only), and the
-- only share rows a recipient can see are ones they already redeemed.
--
-- Revocation safety: policies 2 and 3 require an ACTIVE, unrevoked,
-- unexpired share; revoking a share removes visibility immediately.
-- Read-only: no INSERT/UPDATE/DELETE access is added or changed.

-- 1) room_shares: a recipient may see the share row backing their own
--    live membership (needed for is_active/revoked/expiry checks).
create policy "Recipients can select shares backing own memberships"
  on public.room_shares
  for select
  to authenticated
  using (
    exists (
      select 1 from public.shared_room_memberships m
      where m.share_id = room_shares.id
        and m.recipient_user_id = (select auth.uid())
        and m.removed_at is null
    )
  );

-- 2) dressing_rooms: visible only through an ACTIVE share the caller
--    holds a live membership in (resolver performs owner-staleness check).
create policy "Recipients can select rooms via active shares"
  on public.dressing_rooms
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.shared_room_memberships m
      join public.room_shares s on s.id = m.share_id
      where s.room_id = dressing_rooms.id
        and m.recipient_user_id = (select auth.uid())
        and m.removed_at is null
        and s.is_active = true
        and s.revoked_at is null
        and (s.expires_at is null or s.expires_at > now())
    )
  );

-- 3) dressing_room_items: same active-share gate via the item's actual
--    parent room — Room A membership can never expose a Room B item.
create policy "Recipients can select items via active shares"
  on public.dressing_room_items
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.shared_room_memberships m
      join public.room_shares s on s.id = m.share_id
      where s.room_id = dressing_room_items.dressing_room_id
        and m.recipient_user_id = (select auth.uid())
        and m.removed_at is null
        and s.is_active = true
        and s.revoked_at is null
        and (s.expires_at is null or s.expires_at > now())
    )
  );
