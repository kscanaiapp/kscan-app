-- Tighten Room Messaging v1 table grants.
--
-- The original migration intended authenticated clients to have only
-- SELECT/INSERT, with UPDATE/DELETE unavailable in v1. Revoke any broader
-- inherited/default privileges and re-grant the exact client surface.

revoke all on public.dressing_room_messages from authenticated;
grant select, insert on public.dressing_room_messages to authenticated;
