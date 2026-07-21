# DR-3 Realtime, Revocation, and History

## Design choice: bounded refresh, not Realtime

`subscribeToRoomMessages` remains a hard throw (`Live message updates are not available yet.`). Enabling a naive public Realtime channel without proven private revocation signaling would leave zombie listeners after share revoke.

Shipped sync path: `startCollaborationBoundedRefresh` when:

```
DRESSING_ROOM_COLLABORATION_V1 && DRESSING_ROOM_REALTIME_SYNC_V1
```

| Parameter | Value |
| --------- | ----- |
| Base interval | `DR3_COLLAB_REFRESH_MS = 12_000` |
| Error backoff max | `DR3_COLLAB_REFRESH_MAX_MS = 60_000` (exponential) |
| Tick | `resolveCollaborationAccess` then `onTick(accessVersion)` (panel re-lists page) |
| Access lost | `onAccessLost` → clear UI, set revoked error, stop timer |
| Actor generation mismatch | Stop immediately (account switch) |

Foreground resume: `AppState` `active` reloads messages when sync enabled and not revoked.

## Revocation model

| Layer | Behavior |
| ----- | -------- |
| Share rows | `is_active=false`, `revoked_at` set |
| Access version | Monotonic bump on owner revoke |
| RLS / RPCs | Fail closed via hardened `can_access_room_messages` / resolve access |
| History | Messages, reactions, participants **retained** for owner audit and future DR-4 read-state |
| Client | Clears messages/composer on access error; no retry chrome when revoked |

Owner can still access history after revoke. Revoked recipients cannot list/send/react via RPC or RLS.

## Account-switch / stale application

Module-level actor generation in `dressingRoomCollaboration.ts`:

| API | Role |
| ---- | ---- |
| `bumpCollabActorGeneration(actorId)` | Increment only when actor id changes |
| `isCurrentCollabGeneration(g)` | Gate applying list/send/reaction/sync results |

Wired from:

- `roomMessages.getCurrentSessionUserId`
- `styleObjects.setItemReaction`
- `RoomMessagesPanel` `onAuthStateChange` (clear state + reload or stop sync)

## History invariants

1. Soft-delete column `deleted_at` still filters list RPC.
2. Revoke ≠ delete.
3. Idempotency ledger is per-actor; deleted with user cascade.
4. Public link preview still never selects message bodies.

## Explicitly deferred

| Item | Status |
| ---- | ------ |
| Supabase Realtime private channel + revoke push | NOT IMPLEMENTED |
| Read receipts / last-read cursor | NOT IMPLEMENTED (`canUpdateReadState: false`, flag reserved) |
| Presence | NOT IMPLEMENTED |
