# 02 — DR-4 Access and Revocation Review

## Verdict on access seam

| Classification | Finding |
| -------------- | ------- |
| NOT A DEFECT | Revocation-aware `can_access_room_messages` + `collaboration_access_version` bump on revoke |
| P2 REPAIRED | Bounded-refresh `onTick` access errors previously only backed off; now tear down via `onAccessLost` + `stop` |
| P2 REPAIRED | Pending send could settle after revoke/account switch; generation + `ROOM_MESSAGES_STALE_ERROR` guards |

## Authoritative access model

| Rule | Enforcement |
| ---- | ----------- |
| Server authoritative | RPCs call `resolve_dressing_room_collaboration_access`; RLS uses hardened helpers |
| Owner | Full collab access to own room |
| Shared recipient | Requires participant **and** active, non-revoked, non-expired share with `rs.owner_id = dr.user_id` |
| Fail closed | Unauthenticated / unauthorized / not_found / unavailable → no mutate/list |
| Public share preview ≠ collab | Token preview paths are not authenticated collaboration access |
| Read-state | `canUpdateReadState` always `false` |
| Elise shared evidence | `eliseSharedRoomAccess.ts` (DR-2; unchanged this pass) |

## Revocation behavior

| Behavior | Status |
| -------- | ------ |
| Revoke bumps `collaboration_access_version` | SOURCE VERIFIED (DR-3 migration) |
| History retained (messages, reactions, participants) | SOURCE VERIFIED — intentional |
| Revoked actor cannot list/send/react | DATABASE CONTRACT (post-migration) |
| Client clears interactive UI on access loss | SOURCE VERIFIED (`RoomMessagesPanel` + collab sync) |
| Access errors during tick stop sync | SOURCE VERIFIED (DR-4 repair) |

## Hostile scenarios reviewed

| Scenario | Result |
| -------- | ------ |
| Revoke while room open | Access resolve fails → `onAccessLost` + stop |
| Revoke while message in flight | Access error → clear UI; stale generation → no apply |
| Revoke while offline → reconnect | AppState active reload + access resolve fail-closed |
| Revoke between page requests | List/create RPCs re-check access |
| Stale deep link after revoke | Access resolve fail-closed |
| Old Realtime event after revoke | N/A — Realtime OFF; bounded refresh only |

## Client classifiers

| Symbol | Role |
| ------ | ---- |
| `COLLAB_ACCESS_ERROR` | Canonical access-lost message |
| `isCollaborationAccessError` | Matches access/unavailable/unauthorized/42501 classes |
| `ROOM_MESSAGES_ACCESS_ERROR` | Panel revoke UX |
| `ROOM_MESSAGES_STALE_ERROR` | Generation mismatch / stale session (distinct from access) |

## Production status

| Gate | State |
| ---- | ----- |
| Migration applied on `wyyuqfdxucjksghsmhry` | **No** (READ ONLY) |
| Physical revoke mid-session | EXTERNAL / NEXT-BUILD GATE |
| Emulator revoke proof | NEXT-BUILD GATE |
