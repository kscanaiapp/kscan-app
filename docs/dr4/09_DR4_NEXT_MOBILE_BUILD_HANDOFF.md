# 09 — DR-4 Next Mobile Build Handoff

## Recommendation

- No mobile build was created during DR-4.
- No production deployment occurred.
- The next mobile build remains deferred (~1 week).
- Physical runtime verification must occur in that later build.
- Tester results determine subsequent release action.

## Activate only after non-prod migration apply

1. Apply DR-3 + DR-4 migrations to disposable/staging (not production).
2. Enable client flags only for internal next-build QA:
   - `EXPO_PUBLIC_DRESSING_ROOM_COLLABORATION_V1=true`
   - plus messages/reactions/threads/realtime-sync as needed
3. Validate Flows A–I from DR-3 + offline-revoke reconnect + account switch.
4. Keep commerce/Elise flags independent (`DRESSING_ROOM_COMMERCE_PRESERVATION_V1`, Elise attachment flags).

## Do not

- Enable production flags
- Apply production migration without controlled release process
- Feed room messages into Elise
