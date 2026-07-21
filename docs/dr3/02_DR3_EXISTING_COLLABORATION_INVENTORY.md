# DR-3 Existing Collaboration Inventory

Status classes used below: **IMPLEMENTED** · **SOURCE VERIFIED** · **BEHAVIORAL TEST VERIFIED** · **NEXT-BUILD CLIENT GATE** · **MIGRATION REQUIRED** · **NOT IMPLEMENTED**.

## Pre-DR-3 surfaces (inherited)

| Capability | Pre-DR-3 state | Key paths | Notes |
| ---------- | -------------- | --------- | ----- |
| Room share create / public preview | IMPLEMENTED | `room_shares`, `get_public_room_preview` | Messages never exposed on public preview |
| Join via share token | IMPLEMENTED | `join_room_via_share_token`, `services/roomMessages.ts` | Auth required |
| Participant membership rows | IMPLEMENTED | `dressing_room_participants` | Survives revoke (by design post-DR-3) |
| In-room messages (direct table) | IMPLEMENTED | `dressing_room_messages`, RLS via `can_access_room_messages` | Pre-DR-3 access ignored share revocation |
| Message UI panel | IMPLEMENTED | `components/rooms/RoomMessagesPanel.tsx` | Legacy full-list path when flags OFF |
| Item reactions (direct upsert) | IMPLEMENTED | `dressing_room_item_reactions`, `setItemReaction` | Enum already includes thumbs_down |
| Reaction counts RPC | IMPLEMENTED | `get_item_reaction_counts` | Unchanged by DR-3 |
| Revoke share | IMPLEMENTED | `revoke_room_share` | Pre-DR-3 did not bump access version |
| Realtime message subscribe | NOT IMPLEMENTED | `subscribeToRoomMessages` throws | Stub retained; unsafe if naively enabled |
| Per-user read-state | NOT IMPLEMENTED | — | Deferred DR-4 |

## DR-3 additive inventory

| Capability | Status | Evidence |
| ---------- | ------ | -------- |
| Hardened `can_access_room_messages` (active share + owner match) | SOURCE VERIFIED · MIGRATION REQUIRED | Migration SQL |
| `collaboration_access_version` on `dressing_rooms` | SOURCE VERIFIED · MIGRATION REQUIRED | Column + bump on revoke |
| Revoke preserves messages/reactions/participants | SOURCE VERIFIED | Explicit non-delete in `revoke_room_share` |
| `client_message_id` / `parent_message_id` | SOURCE VERIFIED · MIGRATION REQUIRED | Columns + unique index + FK |
| Flat-thread trigger (depth-1) | SOURCE VERIFIED · MIGRATION REQUIRED | `enforce_dressing_room_message_flat_thread` |
| Keyset index `(room_id, created_at, id)` | SOURCE VERIFIED · MIGRATION REQUIRED | Partial live rows |
| Idempotency ledger | SOURCE VERIFIED · MIGRATION REQUIRED | `dressing_room_collab_idempotency` |
| Access resolve RPC | SOURCE VERIFIED · MIGRATION REQUIRED | `resolve_dressing_room_collaboration_access` |
| Reaction desired-state RPC | SOURCE VERIFIED · MIGRATION REQUIRED | `set_dressing_room_item_reaction` |
| Message create RPC | SOURCE VERIFIED · MIGRATION REQUIRED | `create_dressing_room_message` |
| Message list keyset RPC | SOURCE VERIFIED · MIGRATION REQUIRED | `list_dressing_room_messages` |
| Client collab service | IMPLEMENTED · BEHAVIORAL TEST VERIFIED | `services/dressingRoomCollaboration.ts` |
| Flag-gated message/reaction wiring | IMPLEMENTED · NEXT-BUILD CLIENT GATE | Flags default OFF |
| Bounded refresh sync | IMPLEMENTED · NEXT-BUILD CLIENT GATE | Realtime remains OFF |
| Actor-generation account-switch guard | IMPLEMENTED · BEHAVIORAL TEST VERIFIED | Module generation token |
| Deletion pipeline includes idempotency table | SOURCE VERIFIED | `scripts/process-deletion-request.js` |
| Read-state | NOT IMPLEMENTED | `DRESSING_ROOM_READ_STATE_V1` reserved OFF |

## Flag inventory (all default OFF)

| Flag | Env | Gates |
| ---- | --- | ----- |
| `DRESSING_ROOM_COLLABORATION_V1` | `EXPO_PUBLIC_DRESSING_ROOM_COLLABORATION_V1` | Master client switch |
| `DRESSING_ROOM_REACTIONS_V1` | `EXPO_PUBLIC_DRESSING_ROOM_REACTIONS_V1` | Reaction RPC path |
| `DRESSING_ROOM_MESSAGES_V1` | `EXPO_PUBLIC_DRESSING_ROOM_MESSAGES_V1` | Cursor list/send RPC |
| `DRESSING_ROOM_THREADS_V1` | `EXPO_PUBLIC_DRESSING_ROOM_THREADS_V1` | Reply UI (requires messages) |
| `DRESSING_ROOM_REALTIME_SYNC_V1` | `EXPO_PUBLIC_DRESSING_ROOM_REALTIME_SYNC_V1` | Bounded refresh (not Supabase Realtime) |
| `DRESSING_ROOM_READ_STATE_V1` | `EXPO_PUBLIC_DRESSING_ROOM_READ_STATE_V1` | Reserved; no implementation |

Security is server-enforced regardless of flags. Flags only select next-build client paths; legacy direct-table paths remain when flags are OFF.
