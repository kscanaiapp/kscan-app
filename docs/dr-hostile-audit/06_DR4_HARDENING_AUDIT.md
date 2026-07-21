# DR-4 hardening hostile audit

## A. Composite idempotency migration

Migration `20260721183308_dr4_collab_idempotency_room_scope.sql`:

- Drops any pre-existing `room_id IS NULL` rows in the ledger before adding the NOT NULL. Safe because the DR-3 RPCs always insert a `room_id`; the DELETE only removes rows that could not have originated from those RPCs.
- Adds `NOT NULL` on `room_id`.
- Drops old `dressing_room_collab_idempotency_actor_op_request_key` unique.
- Adds new `dressing_room_collab_idempotency_room_actor_op_request_key UNIQUE (room_id, actor_id, operation, request_id)`.
- Rebinds `set_dressing_room_item_reaction` and `create_dressing_room_message` to include `room_id` in the ledger lookup, matching the new scope.
- Old constraint dropped before new one is added — no unintended dual uniqueness lingers.
- Old-client compatibility: legacy clients writing to `dressing_room_messages` directly do not use the ledger and are unaffected.

**Verdict**: SOURCE VERIFIED. Migration is safe under expected pre-DR-4 state.

## B. Newer-message catch-up

`catchUpCollaborationMessages` (services/dressingRoomCollaboration.ts):

- Uses `list_dressing_room_messages(direction='newer', p_cursor_created_at=fromCursor.createdAt, p_cursor_id=fromCursor.id)`.
- Iterates up to `maxPages = clamp(maxPages ?? 5, 1, 10)`.
- Stops on partial page or page returning fewer than `DR3_COLLAB_PAGE_SIZE` (30) records.
- Deduplicates by `id` via `mergeMessagesById`.
- Ordering: ascending by `(createdAt, id)`.

Hostile checks:

- Equal timestamps: keyset includes `id` tiebreak; no skip/duplicate.
- Repeated cursor detection: the `newer` direction always uses the last emitted `newestCursor`; without a `newestCursor` (empty page), the loop terminates.
- No historical-page corruption: `newest`-direction pages never overwrite `nextCursor` (older) state.
- Access loss during tick: `resolveCollaborationAccess` returning `!ok` invokes `onAccessLost` and stops the loop.
- Account switch during tick: `isCurrentCollabGeneration(actorGeneration)` short-circuits.

**Verdict**: SOURCE VERIFIED.

## C. Access-loss callback

`startCollaborationBoundedRefresh.run`:

- Re-resolves access before every tick.
- Only invokes `onAccessLost` when `resolveCollaborationAccess` returns `!ok` OR when `isCollaborationAccessError(err)` returns true.
- Transient errors do exponential backoff up to 60s; they do NOT trigger `onAccessLost`.
- Correctly classifies error strings/objects using `/no longer have access|unavailable|unauthorized|42501|PGRST301/i`. Broad enough to catch RLS + PostgREST auth failures but not accidental network timeouts.
- Stops the timer on both stale generation and access loss.

**Verdict**: SOURCE VERIFIED.

## D. Stale-send handling

- `sendRoomMessage`, `listRoomMessages`, `listRoomMessagesPage`, `catchUpRoomMessages`, and `subscribeToRoomMessages` all snapshot `getCollabActorGeneration()` before the RPC and re-check on completion.
- On stale generation, throws `ROOM_MESSAGES_STALE_ERROR` — distinct from `ROOM_MESSAGES_ACCESS_ERROR` used for actual revocation, and from `ROOM_MESSAGE_SEND_ERROR` used for network/quota failure.
- Optimistic state cleanup deterministic (server returns stable id; `mergeRoomMessages` dedupes by id).

**Verdict**: SOURCE VERIFIED.

## Verdict

DR-4 hardening: **PASS (SOURCE + BEHAVIORAL TEST VERIFIED)**. Each DR-4 claim maps to a specific migration statement or client change and behaves as advertised.
