# DR-3 Access and Mutation Contract

## Server authority

All collaboration decisions are server-authoritative. Clients may cache `accessVersion` and capability bits for UX teardown only; they must not grant access locally.

Migration: `supabase/migrations/20260721170559_dr3_collaborative_interactions.sql`.

## Access predicates

### `can_access_room_messages(p_room_id uuid) → boolean`

| Actor | Rule |
| ----- | ---- |
| Owner | `dressing_rooms.user_id = auth.uid()` |
| Participant | Participant row **and** `joined_via_share_id` → `room_shares` with `is_active`, `revoked_at is null`, non-expired, `rs.owner_id = dr.user_id`, and actor ≠ owner |

Membership alone is insufficient. Used by existing message RLS policies.

### `resolve_dressing_room_collaboration_access(p_room_id uuid) → jsonb`

| Field (ok=true) | Meaning |
| --------------- | ------- |
| `authenticatedActorId` | `auth.uid()` |
| `currentOwnerId` | Live room owner |
| `relationship` | `owner` \| `shared_recipient` |
| `canView` / `canReact` / `canMessage` / `canReply` / `canSubscribe` | `true` when ok |
| `canUpdateReadState` | Always `false` (DR-4) |
| `accessVersion` | `dressing_rooms.collaboration_access_version` |

| Failure `reason` | When |
| ---------------- | ---- |
| `unauthenticated` | No JWT |
| `not_found` | Room missing |
| `unauthorized` | Not owner and share inactive/revoked/expired/owner-stale |

## Access version and revoke

| Event | Behavior |
| ----- | -------- |
| `revoke_room_share(p_room_id)` | Sets active shares inactive + `revoked_at`; **always** increments `collaboration_access_version` for owner’s room |
| History | **Does not** delete `dressing_room_messages`, reactions, or participant rows |
| Client teardown | Observe `ok:false` or version change via bounded refresh / RPC responses |

## Mutation RPCs (authenticated only)

| RPC | Purpose | Idempotency key |
| --- | ------- | --------------- |
| `set_dressing_room_item_reaction(room, item, type, active, request_id)` | Desired-state reaction upsert/delete | `(actor, 'reaction', request_id)` |
| `create_dressing_room_message(room, body, client_message_id, parent?)` | Insert message / flat reply | `(actor, 'message', client_message_id)` |
| `list_dressing_room_messages(room, limit, cursor_created_at, cursor_id, direction)` | Keyset page | N/A (read) |

Shared guards on mutations:

1. Auth required (`28000`).
2. Access resolve must be `ok`.
3. Reaction types: `like`, `love`, `favorite`, `looking`, `thumbs_down`.
4. Message body: strip C0 controls (keep tab/newline), trim, non-empty, ≤1000 chars.
5. Request / client IDs must be UUID v4 (`dr3_is_uuid_v4`).

## Client contract

| Module | Responsibility |
| ------ | -------------- |
| `services/dressingRoomCollaboration.ts` | Parse access, RPC wrappers, UUIDv4 ids, merge/cursors, bounded refresh, actor generation |
| `services/roomMessages.ts` | Flag-gated collab vs legacy table paths; generation checks on list/send |
| `services/styleObjects.ts` | `setItemReaction(..., { roomId, active, requestId })` → RPC when collab+reactions flags + roomId |
| `components/rooms/RoomMessagesPanel.tsx` | Cursor UI, replies, revoke teardown, sync when flag ON |
| Screens | `app/dressing-rooms/[id].tsx`, `app/(public)/rooms/[token].tsx` pass `roomId` + `active` into `setItemReaction` |

Flags default OFF → legacy direct table/RLS paths remain. After migration, hardened `can_access_room_messages` still applies to legacy RLS even when flags are OFF.
