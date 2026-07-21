# DR-3 Messages: Cursor and Threading

## Schema additions

| Column / object | Purpose |
| --------------- | ------- |
| `client_message_id uuid` | Client idempotency / dedupe key |
| `parent_message_id uuid` | Flat reply → root message FK (`ON DELETE SET NULL`) |
| Unique `(sender_id, room_id, client_message_id)` | Partial where client id set |
| Index `(room_id, created_at, id)` | Keyset; live rows only (`deleted_at is null`) |
| Index `(room_id, parent_message_id)` | Reply lookups |

## Flat-thread invariant

Trigger `dressing_room_messages_flat_thread` → `enforce_dressing_room_message_flat_thread`:

| Check | Failure |
| ----- | ------- |
| Parent exists | `Parent message not found` |
| Parent not soft-deleted | `Parent message unavailable` |
| Same `room_id` | `Parent message must belong to the same room` |
| Parent has `parent_message_id is null` | `Replies to replies are not allowed` |

Depth is exactly **0 (root) or 1 (reply to root)**. No nested threads.

## Cursor shape (no SQL OFFSET)

```ts
type MessageCursor = {
  createdAt: string; // timestamptz
  id: string;        // uuid
  direction?: 'older' | 'newer';
};
```

`list_dressing_room_messages`:

| Mode | Predicate | Order into page |
| ---- | --------- | --------------- |
| Initial (null cursor) | Latest `limit` | Returned ascending |
| `older` | `(created_at, id) < cursor` | Ascending after reverse fetch |
| `newer` | `(created_at, id) > cursor` | Ascending (reconnect) |

| Limit | Clamp |
| ----- | ----- |
| Default | 30 |
| Max | 50 |

Response:

| Field | Meaning |
| ----- | ------- |
| `messages[]` | Ascending rows + `isMine` |
| `nextCursor` | Oldest edge for further `older` pages (or null) |
| `newestCursor` | Newest edge + `direction: 'newer'` |
| `accessVersion` | Current room access epoch |

Client constants: `DR3_COLLAB_PAGE_SIZE = 30`.

## Client merge rules

`mergeMessagesById`:

- Dedupe by stable server `id`.
- Sort by `(createdAt, id)`.
- Live/newer inserts must not invent historical OFFSET; older cursor advances only from older pages.

`RoomMessagesPanel`:

- Initial + “Load older” via `listRoomMessagesPage`.
- Reply UI when `DRESSING_ROOM_THREADS_V1`; only roots are reply targets (`!replyTo.parentMessageId`).
- Soft-deleted/hidden content filtering unchanged (UGC hide/report).

## Flag matrix for messages

| Flags | Path |
| ----- | ---- |
| Collab OFF or Messages OFF | Legacy `.from('dressing_room_messages')` full list / insert |
| Collab + Messages ON | RPC list/create + cursors |
| + Threads ON | Pass `parentMessageId` on send; reply chrome |

`subscribeToRoomMessages` still throws — Realtime not shipped; use bounded refresh when sync flag ON.
