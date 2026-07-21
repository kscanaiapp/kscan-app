# 04 — DR-3 Reactions and Idempotency

## Approved reaction enum

`like` | `love` | `favorite` | `looking` | `thumbs_down`

(Uniqueness remains one reaction row per `(item_id, user_id)`.)

## Desired-state mutation

RPC: `public.set_dressing_room_item_reaction(p_room_id, p_item_id, p_reaction_type, p_active, p_request_id)`

```json
{
  "roomId": "<uuid>",
  "itemId": "<uuid>",
  "reactionType": "<enum>",
  "active": true,
  "requestId": "<UUIDv4>"
}
```

## Idempotency

| Rule | Enforcement |
| --- | --- |
| Client generates UUIDv4 | `createCollabRequestId()` / `crypto.randomUUID` |
| Scoped to actor + operation | `dressing_room_collab_idempotency (actor_id, operation, request_id)` |
| Exact retry returns prior result | ledger `result_json` |
| Same key, different payload | rejected (`22023`) |
| Concurrent set/unset | last committed row + ledger first-writer |

## Access

Every mutation calls `resolve_dressing_room_collaboration_access` and verifies the item belongs to `p_room_id`.

## Client path

- Flag ON: `setItemReaction(itemId, type, { roomId, active, requestId })` → RPC
- Flag OFF: legacy upsert/delete (old clients unchanged)

## Rollback

Disable `DRESSING_ROOM_REACTIONS_V1` / `DRESSING_ROOM_COLLABORATION_V1`. Leave migration in place (additive).
