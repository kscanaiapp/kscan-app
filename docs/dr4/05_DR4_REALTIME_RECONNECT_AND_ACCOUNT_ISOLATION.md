# 05 — DR-4 Realtime, Reconnect, and Account Isolation

## Realtime posture (NOT A DEFECT)

| Topic | Status |
| ----- | ------ |
| True websocket Realtime | OFF — stub remains unsafe without proven revoke channel |
| Sync path | Bounded refresh via `startCollaborationBoundedRefresh` |
| Flag name | `DRESSING_ROOM_REALTIME_SYNC_V1` (historical name; behavior = poll) |
| Interval | 12s base, backoff to 60s on non-access errors |

## P2 repairs in this seam

| Defect | Repair |
| ------ | ------ |
| Access errors on tick only backed off | `isCollaborationAccessError` → `onAccessLost()` + `stop()` |
| Catch-up never advanced newer cursor | `newestCursorRef` + `catchUpRoomMessages` / `catchUpCollaborationMessages` |
| Pending send after revoke/account switch | `sendGeneration` + `isCurrentCollabGeneration`; `ROOM_MESSAGES_STALE_ERROR` ≠ access error |

## Lifecycle matrix

| Event | Client behavior |
| ----- | --------------- |
| Access lost on resolve | Clear interactive state; set revoked; stop sync |
| Access error during `onTick` catch-up | Same teardown (DR-4) |
| Transient network error | Exponential backoff; continue |
| App foreground (`AppState` active) | Reload if not revoked |
| Actor/account change | `bumpCollabActorGeneration`; stale gens discarded |
| Room unmount / sync disable | `handle.stop()` |

## Account-switch isolation

| Mechanism | Path |
| --------- | ---- |
| Generation token | `bumpCollabActorGeneration` / `isCurrentCollabGeneration` / `getCollabActorGeneration` |
| Send path | Capture `sendGeneration` before await; discard apply on mismatch |
| Service path | `sendRoomMessage` / `catchUpRoomMessages` throw `ROOM_MESSAGES_STALE_ERROR` on stale gen |
| Auth listener | Panel bumps generation and clears on user change |

## Persisted-state isolation (NOT A DEFECT)

| Store | Room collab state |
| ----- | ----------------- |
| AsyncStorage | Not used for messages/reactions/sync cursors |
| MMKV | Not used |
| In-memory only | Panel refs + module generation counter |

Hide/report local sets remain device-local moderation helpers and are not authorization.

## Offline revocation reconnect

| Step | Behavior |
| ---- | -------- |
| Offline while revoked | No live channel to tear down (Realtime OFF) |
| Reconnect / foreground | `load()` + access resolve fail-closed |
| In-flight mutation settles after revoke | Access error or stale generation → no UI apply |

## Channel classes (where Realtime absent)

| Class | Handling |
| ----- | -------- |
| CHANNEL_ERROR / TIMED_OUT / CLOSED | N/A for production path — Realtime not enabled |
| Duplicate / out-of-order live events | Mitigated by id-merge + keyset catch-up when sync flag ON |

## Gates

| Gate | State |
| ---- | ----- |
| Source + behavioral tests | VERIFIED |
| Physical revoke mid-session | NEXT-BUILD GATE |
| True Realtime enablement | Not in DR-4 scope; remain OFF |
