# 01 — DR-4 System and Contract Inventory

## Coordinates

| Field | Value |
| ----- | ----- |
| Worktree | `C:\src\KScan-dr4-dressingrooms-hardening-20260721` |
| Branch | `feature/dr4-dressingrooms-production-hardening` |
| Start SHA | `844f9580c528597baef720ea194485e2035edf97` |
| Origin | `https://github.com/kscanaiapp/kscan-app.git` |
| Production | `wyyuqfdxucjksghsmhry` READ ONLY |
| Phase role | Final Dressing Rooms hardening for this cycle (no DR-5) |

## Inherited accepted bases

| Phase | Branch | Accepted HEAD |
| ----- | ------ | ------------- |
| DR-1 | `feature/dressingrooms-canonical-item-contract-v1` | `955c58be941eeeb1a507fc923523158bebf11f5d` |
| DR-2 | `integration/dr2-elise-dressingrooms` | `f9742622820831f2f89b93c21cbc62a3477f3969` |
| DR-3 | `feature/dr3-collaborative-interactive-layer` | `844f9580c528597baef720ea194485e2035edf97` |

## Product chain (preserved)

Scan → identify → discover → save → Dressing Room → collaborate → ask Elise → shop

## Server contracts

| Contract | Path / name | DR-4 note |
| -------- | ----------- | --------- |
| DR-3 collab migration | `supabase/migrations/20260721170559_dr3_collaborative_interactions.sql` | Unchanged baseline |
| DR-4 idempotency scope | `supabase/migrations/20260721183308_dr4_collab_idempotency_room_scope.sql` | Room-scoped unique key |
| DR-4 idempotency scope | `supabase/migrations/20260721183308_dr4_collab_idempotency_room_scope.sql` | Forward-only; **not** applied to prod |
| Access helper | `can_access_room_messages(uuid)` | Revocation-aware (NOT A DEFECT) |
| Access resolve | `resolve_dressing_room_collaboration_access(uuid)` | Returns jsonb + `accessVersion` |
| Revoke | `revoke_room_share(uuid)` | Bumps `collaboration_access_version`; keeps history |
| Reaction RPC | `set_dressing_room_item_reaction(...)` | Ledger lookup now includes `room_id` |
| Message create | `create_dressing_room_message(...)` | Ledger lookup now includes `room_id` |
| Message list | `list_dressing_room_messages(...)` | Keyset; no OFFSET |
| Idempotency ledger | `dressing_room_collab_idempotency` | Unique `(room_id, actor_id, operation, request_id)`; `room_id` NOT NULL |
| Flat thread | `dressing_room_messages_flat_thread` trigger | Depth-1 only |

## Client contracts

| Artifact | Path |
| -------- | ---- |
| Collab service | `services/dressingRoomCollaboration.ts` |
| Messages facade | `services/roomMessages.ts` |
| Commerce preservation | `services/dressingRoomCommerce.ts` |
| Item contract | `services/dressingRoomItemContract.ts` |
| Reactions / style objects | `services/styleObjects.ts` |
| Messages UI | `components/rooms/RoomMessagesPanel.tsx` |
| Owned room screen | `app/dressing-rooms/[id].tsx` |
| Shared room screen | `app/(public)/rooms/[token].tsx` |
| Feature flags | `constants/featureFlags.ts` |
| Elise attachment context | `supabase/functions/stylechat-generate/attachmentContext.ts` |
| Elise visual pipeline | `supabase/functions/stylechat-generate/eliseVisualContextPipeline.ts` |

## Feature flags (default OFF unless noted)

| Flag | Default | Role |
| ---- | ------- | ---- |
| `DRESSING_ROOM_COLLABORATION_V1` | OFF | Master collab client gate |
| `DRESSING_ROOM_REACTIONS_V1` | OFF | Reaction UX |
| `DRESSING_ROOM_MESSAGES_V1` | OFF | Collab message RPC path |
| `DRESSING_ROOM_THREADS_V1` | OFF | Depth-1 reply UX |
| `DRESSING_ROOM_REALTIME_SYNC_V1` | OFF | Bounded refresh (not websocket) |
| `DRESSING_ROOM_READ_STATE_V1` | OFF | Reserved; `canUpdateReadState` always false |
| `DRESSING_ROOM_CANONICAL_ITEM_V1` | env | DR-1 identity |
| `DRESSING_ROOM_COMMERCE_PRESERVATION_V1` | env | Commerce field survival |

## Frozen cursor contract

```
{ createdAt: string, id: string, direction: 'older' | 'newer' }
```

Page size default 30, max 50. No OFFSET.

## Frozen reaction enum

`like` | `love` | `favorite` | `looking` | `thumbs_down`

## Architecture notes

| Topic | Fact |
| ----- | ---- |
| Mobile stack | Single React Native / Expo TypeScript client |
| Native forks | No collaboration `.kt` / `.swift` forks |
| Realtime | Stub / OFF; sync = bounded refresh |
| Collab persistence | No AsyncStorage/MMKV for room collab state |
| Production actions this pass | No migration apply, no edge deploy, no mobile build |

## Tests

| Suite | Path |
| ----- | ---- |
| DR-4 hardening | `__tests__/dr4Hardening.test.js` |
| DR-3 collaboration | `__tests__/dr3Collaboration.test.js` |
