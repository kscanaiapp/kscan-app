-- Follow-up to 20260724220000_shared_room_recipient_read_policies.sql.
-- The recipient policies' subqueries execute as the calling role, so
-- authenticated needs table-level SELECT on shared_room_memberships for
-- ANY policy evaluation that references it (including owner INSERT ...
-- RETURNING on dressing_rooms). Rows remain governed by the existing
-- "Recipients can select own shared room memberships" RLS policy —
-- this grant exposes no rows beyond the caller's own memberships.
grant select on public.shared_room_memberships to authenticated;
