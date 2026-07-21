# DR-3 Reactions and Idempotency

## Reaction enum

Server and client agree on:

| Type | Notes |
| ---- | ----- |
| `like` | Active UI type |
| `love` | Active UI type |
| `favorite` | Allowed by RPC; not in `ACTIVE_DRESSING_ROOM_REACTION_TYPES` UI set |
| `looking` | Active UI type |
| `thumbs_down` | Active UI type (replaced historical `fire`) |

Source: `types/styleObjects.ts` + RPC check in `set_dressing_room_item_reaction`.

## Desired-state semantics

| `p_active` | Effect |
| ---------- | ------ |
| `true` | Upsert `(item_id, user_id)` → `reaction_type` (one reaction per user per item) |
| `false` | Delete row only if current type matches `p_reaction_type` |

Response includes `active` (whether that type is currently mine), `myReaction`, `requestId`, `accessVersion`.

## Idempotency ledger

Table: `public.dressing_room_collab_idempotency`

| Column | Role |
| ------ | ---- |
| `actor_id` | Authenticated user |
| `operation` | `reaction` \| `message` |
| `request_id` | Client UUIDv4 |
| `payload_hash` | SHA-256 (or md5 fallback) of canonical payload string |
| `result_json` | Cached successful result |
| Unique | `(actor_id, operation, request_id)` |

Replay rules:

- Same key + same payload hash → return cached `result_json` (no second write).
- Same key + different payload hash → error `Idempotency key reused with different payload` (`22023`).

### Reaction payload key

```
room_id|item_id|reaction_type|1|0
```

### Message payload key

```
room_id|cleaned_body|parent_message_id_or_empty
```

Message also has unique index `(sender_id, room_id, client_message_id)` where client id present.

## Client ID generation

`createCollabRequestId()` / `isUuidV4()` in `dressingRoomCollaboration.ts`:

- Prefer `crypto.randomUUID()`.
- Fallback: RFC4122 v4 via `getRandomValues`.
- **Forbidden:** `Date.now()` + `Math.random()`.

## Client wiring

| Path | Condition | Behavior |
| ---- | --------- | -------- |
| Collab RPC | `DRESSING_ROOM_COLLABORATION_V1 && DRESSING_ROOM_REACTIONS_V1 && roomId` | `setItemReactionDesiredState` with auto/`options.requestId` |
| Legacy | Otherwise | Direct upsert/delete on `dressing_room_item_reactions` |

Screens pass `{ roomId, active: true|false }` so deactivate is explicit.

## Privacy / deletion

`scripts/process-deletion-request.js` includes:

```
{ table: 'dressing_room_collab_idempotency', column: 'actor_id', action: 'auth_delete_cascade', optional: true }
```

Table has FK `actor_id → auth.users ON DELETE CASCADE`. Authenticated grants: select own rows only; mutations are RPC/service_role.
