-- Repair for Blocker B5 in
-- docs/audits/deletion-hostile-audit-findings-2026-07-22.md:
-- account deactivation was enforced by is_active_account() in exactly one
-- RLS policy (user_device_sessions) plus a handful of edge functions, but
-- none of the RLS policies on Dressing Rooms, Looks, or shared-room tables
-- checked account status at all -- only user_id/owner_id = auth.uid(). A
-- still-valid access token retained full read/write to these tables for its
-- natural remaining lifetime after deletion was initiated, independent of
-- session/refresh-token revocation.
--
-- Uses RESTRICTIVE policies rather than rewriting each existing PERMISSIVE
-- ownership policy: a restrictive policy is ANDed against whatever
-- permissive policies already exist for a table, so this closes the gap for
-- every command (select/insert/update/delete) in one statement per table
-- without touching or risking the existing, already-correct ownership
-- logic. See https://www.postgresql.org/docs/current/sql-createpolicy.html
-- ("PERMISSIVE and RESTRICTIVE Policies").
--
-- Scope: the tables the audit specifically identified as reachable via a
-- still-valid access token after "deletion" -- Dressing Rooms, Looks, and
-- the shared-room surface (transfers, messages, reactions, inspirations).
-- Tables with no verifiable schema in this repo (see Finding B3) are out of
-- scope here; they cannot be safely altered without confirming they exist.

do $$
declare
  t text;
  tables text[] := array[
    'dressing_rooms',
    'dressing_room_items',
    'looks',
    'look_items',
    'room_shares',
    'dressing_room_item_reactions',
    'dressing_room_messages',
    'inspiration_items',
    'dressing_room_inspiration_items'
  ];
begin
  foreach t in array tables loop
    if to_regclass('public.' || t) is not null then
      execute format(
        'drop policy if exists %I on public.%I',
        'Account must be active (deletion guard)', t
      );
      execute format(
        $sql$create policy %I
          on public.%I
          as restrictive
          for all
          to authenticated
          using (public.is_active_account())
          with check (public.is_active_account())$sql$,
        'Account must be active (deletion guard)', t
      );
    else
      raise notice 'Skipping % -- table not found in this schema (cannot verify from migrations, see B3)', t;
    end if;
  end loop;
end;
$$;
