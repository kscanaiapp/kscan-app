-- B34-CON-001 staging reconciliation: retain the safe, additive canonical
-- dedupe-key uniqueness primitive. It is intentionally inert while
-- DRESSING_ROOM_DEDUPE_V1 is off because current rows carry no dedupe key.

create unique index if not exists dressing_room_items_dedupe_key_key
on public.dressing_room_items (((snapshot_payload -> 'canonical') ->> 'dedupeKey'))
where (snapshot_payload -> 'canonical') ->> 'dedupeKey' is not null;

comment on index public.dressing_room_items_dedupe_key_key is
  'B33-CON-001. Partial unique index on the governed dedupe key (services/dressingRoomDedupe.ts), inert while DRESSING_ROOM_DEDUPE_V1 is off since no row carries the key yet. Provides the atomicity the client-side check-then-insert cannot, once a future build enables the flag and pairs it with an upsert write path.';
