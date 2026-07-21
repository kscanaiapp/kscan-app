# 09 — DR-4 Next Mobile Build Handoff

## Recommendation (mandatory)

| Statement | Status |
| --------- | ------ |
| No mobile build was created during DR-4 | Confirmed |
| No production deployment occurred | Confirmed (wyyuqfdxucjksghsmhry READ ONLY) |
| Next mobile build remains deferred ~1 week | Confirmed |
| Physical runtime verification must occur in that later build | Required |
| Tester results drive subsequent release action | Required |

**DR-4 is the final Dressing Rooms development phase in this cycle. Do not start DR-5.**

## Coordinates for the next-build operator

| Field | Value |
| ----- | ----- |
| Branch | feature/dr4-dressingrooms-production-hardening |
| Origin | https://github.com/kscanaiapp/kscan-app.git |
| Start SHA | 844f9580c528597baef720ea194485e2035edf97 |
| Ending SHA | 93c21c0b0174641a4e2220735d39ba7db18f1494 |
| Worktree | C:\src\KScan-dr4-dressingrooms-hardening-20260721 |

## What the next build should include

| Include | Detail |
| ------- | ------ |
| Source | DR-4 hardened client + migrations in repo |
| Flags (selective) | Enable only needed DRESSING_ROOM_*_V1 children after staging migration |
| Sync | Bounded refresh via DRESSING_ROOM_REALTIME_SYNC_V1 if testing sync; Realtime websocket stays OFF |
| Migrations | Apply DR-3 then DR-4 on non-prod **before** relying on RPC paths |

## What the next build must not assume

| Assumption | Reality |
| ---------- | ------- |
| Production migration already applied | False |
| Production flags already ON | False |
| Physical revoke already proven | False — this build’s job |
| True Realtime is ready | False — remain OFF |

## Physical / tester checklist

| # | Scenario |
| - | -------- |
| 1 | Owner + shared recipient message/react with flags ON |
| 2 | Revoke mid-session → UI teardown; no further private payloads |
| 3 | Offline revoke → foreground reload fail-closed |
| 4 | Account switch mid-send → no stale apply |
| 5 | Cross-room same client requestId does not collide |
| 6 | Newer messages appear under bounded refresh |
| 7 | Reply-to-reply rejected |
| 8 | Scanner → room commerce fields intact; Elise attachment boolean-only |
| 9 | Android and iOS both exercised |

## Release freeze reminder

Do not create APK/AAB/IPA/TestFlight/Play artifacts as part of DR-4 closeout. Defer store artifacts to the scheduled next-build window after physical gates.
