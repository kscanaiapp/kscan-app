-- Build 34 backend closure -- B34-BE-PERF-001: index the foreign keys whose
-- referential action fans out per deleted parent row on a customer lifecycle path.
--
-- WHY THESE SIX AND NOT THE OTHER ADVISOR FINDINGS
--
-- Postgres enforces ON DELETE SET NULL / CASCADE with a per-row trigger on the
-- referenced table: every deleted parent row runs one query against the child
-- table. With no index whose LEADING column is the foreign key, each of those
-- queries scans the whole child table, so deleting M parent rows costs M full
-- scans. For the six keys below the parent is a high-volume table that customers
-- and the account-deletion worker delete from routinely (chat messages, chat
-- sessions, room messages, room items, saved scans), so the cost grows with
-- (rows deleted) x (child table size) -- quadratic for the two self-referencing
-- message tables, where deleting a session or room deletes every message in it.
-- Session/room/scan deletion runs under the authenticated statement timeout, and
-- account deletion must complete for erasure to be honoured.
--
-- Staging evidence (2026-09-17, read-only): with sequential scans disabled, the
-- RI query shape for each key below still planned a Seq Scan, except
-- elise_generation_operations.source_message_id, which can only use the third
-- column of a composite index (a full-index traversal on Postgres 17). The
-- control key look_items.source_saved_scan_id, which already has this exact
-- index, planned an Index Scan; outfit_decision_option_items recorded 6,610
-- sequential scans against 6,571 saved_scans deletions.
--
-- Keys whose parent is auth.users fire once per account (one scan per child
-- table, not per row) and keys already served by a leading-column index are
-- dispositioned in docs/audits/build34-backend-performance-disposition-2026-09-17.md.
--
-- SAFETY. Additive only: no table, column, policy, grant or function changes.
-- Partial indexes match the existing look_items_source_*_idx convention; an
-- equality lookup on the key implies IS NOT NULL, so the RI query can use them.
-- Plain CREATE INDEX (migrations run in a transaction) briefly blocks writes to
-- each table while it builds; row counts are a migration-day check.

create index if not exists style_chat_messages_source_message_idx
  on public.style_chat_messages (source_message_id)
  where source_message_id is not null;

create index if not exists elise_generation_operations_source_message_idx
  on public.elise_generation_operations (source_message_id)
  where source_message_id is not null;

create index if not exists elise_generation_operations_session_idx
  on public.elise_generation_operations (session_id);

create index if not exists dressing_room_messages_parent_message_idx
  on public.dressing_room_messages (parent_message_id)
  where parent_message_id is not null;

create index if not exists look_items_source_dressing_room_item_idx
  on public.look_items (source_dressing_room_item_id)
  where source_dressing_room_item_id is not null;

create index if not exists outfit_decision_option_items_source_saved_scan_idx
  on public.outfit_decision_option_items (source_saved_scan_id)
  where source_saved_scan_id is not null;

-- Post-condition: every index exists, is valid, and leads with its foreign key.
do $verify$
declare
  v_expected constant text[][] := array[
    ['style_chat_messages', 'style_chat_messages_source_message_idx', 'source_message_id'],
    ['elise_generation_operations', 'elise_generation_operations_source_message_idx', 'source_message_id'],
    ['elise_generation_operations', 'elise_generation_operations_session_idx', 'session_id'],
    ['dressing_room_messages', 'dressing_room_messages_parent_message_idx', 'parent_message_id'],
    ['look_items', 'look_items_source_dressing_room_item_idx', 'source_dressing_room_item_id'],
    ['outfit_decision_option_items', 'outfit_decision_option_items_source_saved_scan_idx', 'source_saved_scan_id']
  ];
  v_row text[];
  v_ok boolean;
begin
  foreach v_row slice 1 in array v_expected loop
    select exists (
      select 1
      from pg_index ix
      join pg_class i on i.oid = ix.indexrelid
      join pg_class t on t.oid = ix.indrelid
      join pg_namespace n on n.oid = t.relnamespace
      join pg_attribute a on a.attrelid = t.oid and a.attnum = ix.indkey[0]
      where n.nspname = 'public'
        and t.relname = v_row[1]
        and i.relname = v_row[2]
        and a.attname = v_row[3]
        and ix.indisvalid
    ) into v_ok;
    if not v_ok then
      raise exception 'B34-BE-PERF-001 post-condition failed: %.% on %', v_row[1], v_row[2], v_row[3];
    end if;
  end loop;
end
$verify$;
