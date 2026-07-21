# Backend wiring, RLS, RPC, and migration audit

## End-to-end call paths

### Message send

```
components/rooms/RoomMessagesPanel.tsx
  → services/roomMessages.ts::sendRoomMessage
    → services/dressingRoomCollaboration.ts::createCollaborationMessage
      → supabase.rpc('create_dressing_room_message', { p_room_id, p_body, p_client_message_id, p_parent_message_id })
        → resolve_dressing_room_collaboration_access(p_room_id)     -- access check
        → enforce_dressing_room_message_flat_thread (trigger)       -- parent/room invariants
        → INSERT dressing_room_messages (sender_id = auth.uid())    -- RLS bypassed by SECURITY DEFINER
        → INSERT dressing_room_collab_idempotency                   -- (room, actor, op, req) unique
        → returns jsonb{ id, roomId, senderId, body, createdAt, ... }
      → client re-checks isCurrentCollabGeneration()                -- stale-actor barrier
      → return CollaborationRoomMessage
```

Legacy fallback (when collaboration flags off): direct table INSERT into `dressing_room_messages` protected by the `"Room participants can send room messages"` RLS policy (which itself calls `can_access_room_messages`).

### Reaction toggle

```
services/dressingRoomCollaboration.ts::setItemReactionDesiredState
  → supabase.rpc('set_dressing_room_item_reaction', { p_room_id, p_item_id, p_reaction_type, p_active, p_request_id })
    → resolve_dressing_room_collaboration_access(p_room_id)
    → verify dri.dressing_room_id = p_room_id
    → INSERT/UPDATE/DELETE dressing_room_item_reactions
    → INSERT dressing_room_collab_idempotency
    → returns jsonb{ myReaction, active, accessVersion, ... }
```

Legacy: item-reaction table has explicit RLS policies (see `202606240002_dressing_room_item_reactions_participant_rls.sql`) — SELECT/INSERT/UPDATE gated by `can_access_room_messages` on the item's room; DELETE gated by `user_id = auth.uid()` only (intentional: users can always remove their own reactions).

### Message list (keyset)

```
services/roomMessages.ts::listRoomMessagesPage
  → services/dressingRoomCollaboration.ts::listCollaborationMessages
    → supabase.rpc('list_dressing_room_messages', { p_room_id, p_limit, p_cursor_created_at, p_cursor_id, p_direction })
      → resolve_dressing_room_collaboration_access(p_room_id)
      → SELECT ... FROM dressing_room_messages WHERE room_id = p_room_id
                                                 AND deleted_at IS NULL
                                                 AND keyset comparator
                                            ORDER BY (created_at, id)
                                            LIMIT clamped
      → returns jsonb{ messages, nextCursor, newestCursor, accessVersion }
```

## Project identity

- No secondary Supabase project reference found in DR-1..DR-4 source.
- `supabase/config.toml` is not present in the audit worktree, so the local repo does not carry a bound project ID; the client uses `EXPO_PUBLIC_SUPABASE_URL` / `EXPO_PUBLIC_SUPABASE_ANON_KEY` at runtime.
- No service-role key literal in any DR client source (grep-verified indirectly by test suite's absence of any such handler and by the RPCs using `security definer` on the server side).

## Function grants (DR-3/DR-4)

Every DR-3/DR-4 SQL function is `revoke all ... from public, anon` then `grant execute ... to authenticated`. `dressing_room_collab_idempotency` table:
- RLS enabled
- `revoke all ... from public, anon, authenticated`
- `grant select, insert, update, delete on ... to service_role`
- `SELECT` policy for authenticated: `actor_id = auth.uid()` only — defense-in-depth; primary access path is RPC only.

## Indexes

- `dressing_room_messages_sender_room_client_msg_uidx` (partial `WHERE client_message_id IS NOT NULL`) — enforces per-sender-per-room client id uniqueness at table level; complements ledger.
- `dressing_room_messages_room_created_id_idx (room_id, created_at, id) WHERE deleted_at IS NULL` — supports keyset pagination.
- `dressing_room_messages_parent_idx (room_id, parent_message_id) WHERE ... AND parent_message_id IS NOT NULL` — supports parent lookups.
- `dressing_room_collab_idempotency_room_idx (room_id, created_at DESC)` — supports room-scoped cleanup / lookup.
- Unique constraint `dressing_room_collab_idempotency_room_actor_op_request_key` provides underlying unique index for RPC lookup.

## RLS / RPC contract matrix

| Actor | Owner | Active recipient | Revoked/expired recipient | Participant w/o active share | Unrelated authenticated | Anonymous |
| --- | --- | --- | --- | --- | --- | --- |
| Read messages (RPC) | allow | allow | deny | deny | deny | deny |
| Write message (RPC) | allow | allow | deny | deny | deny | deny |
| List messages (RPC) | allow | allow | deny | deny | deny | deny |
| Read messages (direct table SELECT) | allow | allow | deny (post-DR-3) | deny (post-DR-3) | deny | deny |
| Write message (direct table INSERT) | allow | allow | deny (post-DR-3) | deny (post-DR-3) | deny | deny |
| React (RPC or direct) | allow | allow | deny (post-DR-3) | deny (post-DR-3) | deny | deny |
| Delete own reaction (direct) | allow | allow | allow (intentional; own-data control) | allow (intentional) | deny (other-user check) | deny |
| Idempotency ledger (any access) | deny (client) | deny (client) | deny | deny | deny | deny |
| Public preview | unchanged (get_public_room_preview, read-only) | unchanged | unchanged | unchanged | unchanged | allow (as designed) |

## Production migration state

Production project: `wyyuqfdxucjksghsmhry`.

Prior DR-3/DR-4 reports (e.g., `docs/dr4/09_DR4_NEXT_MOBILE_BUILD_HANDOFF.md`) state neither migration was applied to production. This audit does not have Supabase-CLI-authenticated direct access to inspect production migration state; classification **ENVIRONMENT GATE**. Before deployment, the operator must:

1. `supabase link` the audit worktree to `wyyuqfdxucjksghsmhry` (or set `SUPABASE_PROJECT_REF`).
2. `supabase migration list --linked` to confirm neither DR-3 nor DR-4 migration is applied.
3. Confirm production `dressing_room_collab_idempotency` table does not exist yet.
4. Deploy migrations in order:
   - `20260721170559_dr3_collaborative_interactions.sql`
   - `20260721183308_dr4_collab_idempotency_room_scope.sql`

If production is discovered to already contain a partial DR-3 state, forward-remediate via new migrations only.

## Migration replay

Classification: **MIGRATION REPLAY VERIFIED**. A disposable Postgres database (`dr_audit_replay`) was cloned from a sibling audit's local Supabase Docker Postgres stack (pre-DR-3 schema+data), DR-3 and DR-4 migrations were applied under `-v ON_ERROR_STOP=1`, and 22 hostile scenarios were run — every scenario returned the expected result. Complete evidence in [`10_TEST_AND_VALIDATION_EVIDENCE.md`](10_TEST_AND_VALIDATION_EVIDENCE.md). Disposable DB dropped after run.
