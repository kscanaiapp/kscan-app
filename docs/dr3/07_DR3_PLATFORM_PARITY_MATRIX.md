# DR-3 Platform Parity Matrix

Architecture: single React Native/Expo TypeScript client. Native `android/` tree present; iOS via Expo-managed config (no required checked-in `ios/` fork for DR-3 contracts). No `.kt` / `.swift` collaboration forks.

Evidence classes in cells:

| Class | Meaning |
| ----- | ------- |
| SOURCE | Shared TS contract present and reviewed |
| STATIC | Config/static presence only |
| RUNTIME GATE | Needs next emulator/simulator build with flags ON |
| PHYSICAL GATE | Needs device + real share/revoke |
| PRODUCTION | Live project deploy/migration — **not done** |

## Capability matrix

| Capability | SOURCE | STATIC | RUNTIME GATE | PHYSICAL GATE | PRODUCTION |
| ---------- | ------ | ------ | ------------ | ------------- | ---------- |
| Hardened share access + owner match | SOURCE VERIFIED (migration + client parse) | — | RUNTIME GATE | PHYSICAL GATE | PRODUCTION: migration **not** applied (`wyyuqfdxucjksghsmhry` RO) |
| `collaboration_access_version` teardown | SOURCE VERIFIED | — | RUNTIME GATE | PHYSICAL GATE | PRODUCTION pending |
| Reaction desired-state + UUIDv4 idempotency | SOURCE VERIFIED | — | RUNTIME GATE (flags ON) | PHYSICAL GATE | PRODUCTION pending |
| Message create + client_message_id | SOURCE VERIFIED | — | RUNTIME GATE | PHYSICAL GATE | PRODUCTION pending |
| Keyset pagination (no OFFSET) | SOURCE VERIFIED · BEHAVIORAL merge tests | — | RUNTIME GATE | PHYSICAL GATE | PRODUCTION pending |
| Flat depth-1 threads | SOURCE VERIFIED (trigger + UI gate) | — | RUNTIME GATE | PHYSICAL GATE | PRODUCTION pending |
| Bounded refresh sync | SOURCE VERIFIED | — | RUNTIME GATE (`REALTIME_SYNC_V1`) | PHYSICAL GATE | PRODUCTION pending |
| Realtime websocket channel | NOT IMPLEMENTED (stub throws) | — | — | — | — |
| Read-state | NOT IMPLEMENTED | Flag reserved OFF | — | — | — |
| Account-switch generation isolation | SOURCE VERIFIED · BEHAVIORAL TEST VERIFIED | — | RUNTIME GATE | PHYSICAL GATE | — |
| Flags default OFF / legacy paths | SOURCE VERIFIED · BEHAVIORAL TEST VERIFIED | STATIC VERIFIED (`featureFlags.ts`) | RUNTIME GATE (confirm silent OFF) | PHYSICAL GATE | PRODUCTION flags unmodified |
| Android vs iOS collab contract | SOURCE equivalent (shared modules) | STATIC: Expo app config | RUNTIME GATE each OS | PHYSICAL GATE each OS | — |
| Deletion includes idempotency table | SOURCE VERIFIED | — | — | — | PRODUCTION script path only when ops run |

## What was not claimed

- No APK/AAB/IPA/TestFlight/Play artifact.
- No production migration or RPC deploy evidence.
- No MCP-confirmed live schema (MCP timed out); contract = migration + source.

Test file: `__tests__/dr3Collaboration.test.js` (platform source parity assertion included).
