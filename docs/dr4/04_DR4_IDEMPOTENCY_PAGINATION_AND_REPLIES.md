# 04 — DR-4 Idempotency, Pagination, and Replies

## Idempotency — P1 repair

| Field | Detail |
| ----- | ------ |
| Defect | DR-3 unique `(actor_id, operation, request_id)` omitted `room_id` |
| Impact | Same `requestId` reused legitimately in another room collided (payload hash includes `room_id` → "Idempotency key reused with different payload") |
| Repair migration | `supabase/migrations/20260721183308_dr4_collab_idempotency_room_scope.sql` |

### Effective uniqueness scope (required)

| Scope element | Enforced |
| ------------- | -------- |
| `room_id` | NOT NULL + unique key member |
| `actor_id` | Unique key member |
| `operation` | `reaction` \| `message` |
| `request_id` | UUIDv4 (`client_message_id` for messages) |

### RPC lookup change

| RPC | Lookup predicate |
| --- | ---------------- |
| `set_dressing_room_item_reaction` | `room_id = p_room_id AND actor_id AND operation='reaction' AND request_id` |
| `create_dressing_room_message` | `room_id = p_room_id AND actor_id AND operation='message' AND request_id` |

### Replay rules (unchanged semantics, room-scoped)

| Case | Expected |
| ---- | -------- |
| Exact replay same room/actor/op/request + same payload hash | Return prior `result_json` |
| Same key, different payload hash | Reject |
| Same requestId, different actor | Separate ledger rows |
| Same requestId, different room | Allowed after DR-4 |

## Message table uniqueness (NOT A DEFECT)

| Constraint | Scope |
| ---------- | ----- |
| `dressing_room_messages_sender_room_client_msg_uidx` | `(sender_id, room_id, client_message_id)` |

## Pagination — P2 repair + verified baseline

| Topic | Status |
| ----- | ------ |
| Keyset `(created_at, id)` no OFFSET | NOT A DEFECT (DR-3) |
| Bounded refresh never walked newer cursor | P2 REPAIRED |
| Repair | `catchUpCollaborationMessages` / `catchUpRoomMessages` + `newestCursorRef` in `RoomMessagesPanel` |

### Catch-up contract

| Parameter | Value |
| --------- | ----- |
| Direction | `newer` |
| Page size | `DR3_COLLAB_PAGE_SIZE` (30) |
| Max pages | `DR3_COLLAB_CATCHUP_MAX_PAGES` (5), clamp ≤10 |
| Merge | `mergeMessagesById` (stable under equal timestamps) |

## Flat replies (NOT A DEFECT)

| Rule | Enforcement |
| ---- | ----------- |
| Depth-1 only | Trigger `Replies to replies are not allowed` |
| Parent same room, root only | Server trigger |
| UI | Reply offered only when `!replyTo.parentMessageId` and threads flag ON |

## Production status

| Gate | State |
| ---- | ----- |
| DR-4 migration applied | **No** |
| Live idempotency/keyset RPC exercise | NEXT-BUILD / staging EXTERNAL GATE |
