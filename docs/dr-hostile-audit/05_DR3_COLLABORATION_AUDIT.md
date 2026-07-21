# DR-3 collaboration hostile audit

## Test evidence

- `__tests__/dr3Collaboration.test.js` — PASS
- `__tests__/sharedRoomMemberships*.test.js` — PASS (5 files)
- `__tests__/sharedRoomImage*.test.js` — PASS (3 files)
- `__tests__/sharedRoomPreview.test.js` — PASS
- `__tests__/sharedRoomLayout.test.js` — PASS
- `__tests__/sharedWithMe*.test.js` — PASS (2 files)

## A. Access + revocation (server-authoritative)

Migration `20260721170559_dr3_collaborative_interactions.sql` replaces `can_access_room_messages(uuid)` with a strict form:

- Owner: `dr.user_id = auth.uid()` → allowed
- Non-owner: requires a `dressing_room_participants` row joined to an ACTIVE `room_shares` row (`is_active`, `revoked_at IS NULL`, `expires_at IS NULL OR expires_at > clock_timestamp()`, `owner_id = dr.user_id`, `dr.user_id IS DISTINCT FROM auth.uid()`).

Companion `resolve_dressing_room_collaboration_access(uuid)` returns the same access decision as a structured JSON payload (with `accessVersion`).

`revoke_room_share(uuid)`:
- Requires the caller to be the room owner (`42501` if not).
- Sets `is_active = false`, `revoked_at = clock_timestamp()` for all active shares.
- Always bumps `collaboration_access_version` (even when no active share row remained).
- Intentionally does NOT delete historical `dressing_room_messages`, reactions, or participant rows.

**Verdict**: SOURCE VERIFIED. Revoked/expired/participant-only-without-active-share/anonymous/unrelated actors fail closed. History preservation confirmed.

## B. Reactions

`set_dressing_room_item_reaction`:
- Requires JWT; `auth.uid()` derives the actor (no spoofing).
- Enforces `dr3_is_uuid_v4(p_request_id)` (rejects malformed/legacy IDs).
- Validates all null-check inputs, `p_active`, and constrained `reaction_type` enum (`like`, `love`, `favorite`, `looking`, `thumbs_down`).
- Calls `resolve_dressing_room_collaboration_access` and rejects on any non-`ok`.
- Verifies item belongs to the room (`dressing_room_items.dressing_room_id = p_room_id`, `42501` otherwise).
- Idempotency: (`room_id`, `actor_id`, `'reaction'`, `request_id`) after DR-4; exact retry returns cached result; conflicting retry raises "Idempotency key reused with different payload" (payload includes room+item+type+active).

**Verdict**: SOURCE VERIFIED.

## C. Messages

`create_dressing_room_message`:
- Requires JWT; sender derived from `auth.uid()`.
- Requires v4 UUID for `p_client_message_id`.
- Sanitizes body (strip C0 control chars except tab/newline; trim); requires 1..1000 chars.
- Calls `resolve_dressing_room_collaboration_access` and rejects on non-`ok`.
- Idempotency: (`room_id`, `actor_id`, `'message'`, `p_client_message_id`) after DR-4; payload hash includes room, cleaned body, parent id.

**Verdict**: SOURCE VERIFIED.

## D. Flat replies

Trigger `enforce_dressing_room_message_flat_thread`:
- No parent → allow.
- Parent not found → `22023`.
- Parent `deleted_at` set → `22023`.
- Parent belongs to a different room → `22023`.
- Parent already has a parent (reply-to-reply) → `22023`.

Enforced at DB level (`BEFORE INSERT OR UPDATE OF parent_message_id, room_id`). UI cannot bypass by direct table insert (also blocked by RLS unless `can_access_room_messages`).

**Verdict**: SOURCE VERIFIED.

## E. Idempotency (DR-3 + DR-4 scope)

DR-3 shipped `(actor_id, operation, request_id)` uniqueness. That produced a defect: the same request_id reused across rooms failed with "Idempotency key reused with different payload" because payload_hash included room_id.

DR-4 migration:
1. `DELETE FROM dressing_room_collab_idempotency WHERE room_id IS NULL` (defensive).
2. `ALTER COLUMN room_id SET NOT NULL`.
3. `DROP CONSTRAINT dressing_room_collab_idempotency_actor_op_request_key`.
4. `ADD CONSTRAINT dressing_room_collab_idempotency_room_actor_op_request_key UNIQUE (room_id, actor_id, operation, request_id)`.
5. Rebinds `set_dressing_room_item_reaction` and `create_dressing_room_message` to include `room_id` in the ledger lookup.

**Verdict**: SOURCE VERIFIED. Cross-room reuse now permitted; conflicting payload still rejected.

## F. Keyset pagination

`list_dressing_room_messages`:
- Bounded page limit 1..50 (default 30).
- Direction: `older` (default) uses `(created_at, id) < (cursor)` DESC; `newer` uses `> (cursor)` ASC.
- Returns rows ASC internally regardless of direction.
- Emits `nextCursor` (older direction, matches oldest emitted row) only when page is full — no infinite loop at end of history.
- Emits `newestCursor` (newer direction) when any rows returned — used for reconnect catch-up.
- Backing partial index `dressing_room_messages_room_created_id_idx (room_id, created_at, id) WHERE deleted_at IS NULL`.

Hostile cases (SOURCE VERIFIED):
- Equal timestamps: tie-broken by `id`, no skip or duplicate.
- Missing cursor: latest page returned (no infinite scroll to future).
- Cross-room cursor: RLS/access check rejects at `resolve_dressing_room_collaboration_access` before pagination runs.

**Verdict**: SOURCE VERIFIED.

## G. Bounded synchronization

Client `catchUpCollaborationMessages` (`services/dressingRoomCollaboration.ts` line 372-419):
- `maxPages = clamp(input.maxPages ?? 5, 1, 10)`.
- Early exit if page returns fewer than `DR3_COLLAB_PAGE_SIZE` messages.
- Actor-generation checks (`isCurrentCollabGeneration`) inside every tick.
- Bounded refresh (`startCollaborationBoundedRefresh`) uses exponential backoff to `DR3_COLLAB_REFRESH_MAX_MS` (60s) on transient errors, revalidates access each tick, and calls `onAccessLost` on any access-loss.

**Verdict**: SOURCE VERIFIED. No infinite-loop or full-history-refetch path.

## H. Account isolation and stale operations

- `bumpCollabActorGeneration(actorId)` bumps only when actorId changes.
- `getCollabActorGeneration()` / `isCurrentCollabGeneration(gen)` used by every RPC caller (`listRoomMessages`, `sendRoomMessage`, `catchUpRoomMessages`, `listRoomMessagesPage`) to raise `ROOM_MESSAGES_STALE_ERROR` when the actor changed mid-flight.

**Verdict**: SOURCE VERIFIED.

## Verdict

DR-3 collaboration: **PASS (SOURCE + BEHAVIORAL TEST VERIFIED)**. All hostile scenarios attempted resolve to server-authoritative denials or bounded, deterministic behavior. No cross-room, cross-user, spoofing, or infinite-loop issues found.
