-- B33-CON-001 — Dressing Room item add is not idempotent: two identical
-- "add this to my Dressing Room" requests (a double-tap, a retried request
-- after a dropped response, a client-side race) can create two rows for what
-- the product considers the same item. Proven on staging: two identical
-- inserts were both accepted.
--
-- GOVERNED SOURCE ALREADY HAS THE INTENDED SHAPE OF THIS FIX
--
-- services/dressingRoomDedupe.ts (computeDressingRoomDedupeKey) and
-- services/styleObjects.ts already implement a deterministic, room-scoped
-- dedupe key and a check-before-insert lookup (findExistingRoomItemByDedupe),
-- gated behind the DRESSING_ROOM_DEDUPE_V1 feature flag. The flag is a
-- build-time EXPO_PUBLIC_ constant and is currently false in every EAS
-- profile, so the shipped client never computes or writes a dedupe key today
-- -- this backend change is inert for it.
--
-- WHAT WAS STILL MISSING
--
-- The existing mechanism is check-then-insert from the client: look for an
-- existing row with the same dedupe key, insert only if none is found. That
-- is not atomic -- two identical requests that both pass the check before
-- either one's insert lands still produce two rows. This is exactly the
-- shape of race B33-CON-001 documents. A backend constraint is required to
-- close it; the client-side check alone cannot.
--
-- WHY THIS INDEX AND NOT A GENERIC (source_type, source_id) ONE
--
-- Keying on the governed dedupe key (rather than reinventing a parallel
-- identity notion) means this migration hardens the mechanism the product
-- already decided on -- including its closet-authority-first and
-- request-idempotency-key precedence -- instead of introducing a second,
-- competing notion of "the same item" that could disagree with it once the
-- flag ships.
--
-- WHY THIS IS SAFE FOR THE CURRENTLY SHIPPED CLIENT WITHOUT A NEW BUILD
--
-- The index is partial: it only applies to rows that actually carry a
-- dedupeKey. The shipped client (flag off) never writes one, so it can never
-- violate this constraint -- there is nothing for today's traffic to
-- conflict against, and nothing changes in what the shipped app's raw
-- `.insert()` calls experience. It only becomes load-bearing once a future
-- build turns DRESSING_ROOM_DEDUPE_V1 on, at which point:
--   - it is the atomicity backstop the client-side check does not provide;
--   - the write path for that future build must use an upsert (or catch and
--     resolve 23505) rather than a bare insert, so a legitimate race lands
--     on the existing row instead of erroring -- a client-side change, and
--     out of scope for this backend migration, which only makes the
--     constraint available for that build to rely on.
--
-- Distinct items (different dedupe key, or no dedupe key at all -- the
-- overwhelming majority of rows today) are completely unaffected: standard
-- SQL unique-index semantics never compare NULLs as equal, and this index
-- additionally excludes NULL explicitly via its WHERE clause.

create unique index if not exists dressing_room_items_dedupe_key_key
on public.dressing_room_items (((snapshot_payload -> 'canonical') ->> 'dedupeKey'))
where (snapshot_payload -> 'canonical') ->> 'dedupeKey' is not null;

comment on index public.dressing_room_items_dedupe_key_key is
  'B33-CON-001. Partial unique index on the governed dedupe key (services/dressingRoomDedupe.ts), inert while DRESSING_ROOM_DEDUPE_V1 is off since no row carries the key yet. Provides the atomicity the client-side check-then-insert cannot, once a future build enables the flag and pairs it with an upsert write path.';
