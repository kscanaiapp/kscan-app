# 05 — DR-3 Messages, Cursor Pagination, and Flat Threads

## Create

RPC: `public.create_dressing_room_message(p_room_id, p_body, p_client_message_id, p_parent_message_id)`

- Access-checked
- Body trimmed; C0 controls stripped; max 1000 chars; non-blank
- `client_message_id` must be UUIDv4
- Idempotent via ledger (`operation = 'message'`)

## Cursor / keyset (no OFFSET)

RPC: `public.list_dressing_room_messages(p_room_id, p_limit, p_cursor_created_at, p_cursor_id, p_direction)`

Ordering: `(created_at, id)`

| Field | Meaning |
| --- | --- |
| `messages` | Ascending page |
| `nextCursor` | `{ createdAt, id, direction: "older" }` for history |
| `newestCursor` | `{ createdAt, id, direction: "newer" }` for reconnect |
| `accessVersion` | Room collaboration epoch |

Initial call (null cursor): latest `limit` rows, returned ascending.

Predicates: `(created_at, id) < cursor` (older) or `>` (newer). Index: `dressing_room_messages_room_created_id_idx`.

Live inserts merge client-side by stable message id (`mergeMessagesById`) without advancing the older cursor incorrectly.

## Flat threads (depth 1)

- `parent_message_id` optional
- Trigger `enforce_dressing_room_message_flat_thread` rejects: missing parent, wrong room, deleted parent, parent that itself has a parent
- UI reply affordance gated by `DRESSING_ROOM_THREADS_V1`

## Client

`services/roomMessages.ts` + `components/rooms/RoomMessagesPanel.tsx` (flags default OFF).
