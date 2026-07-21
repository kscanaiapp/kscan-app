# 06 — DR-4 Platform Parity Matrix

Architecture: single React Native / Expo TypeScript client. Native `android/` tree may exist for Expo prebuild; no required checked-in `ios/` collaboration fork. No `.kt` / `.swift` dressing-room collaboration forks.

## Evidence classes

| Class | Meaning |
| ----- | ------- |
| SOURCE VERIFIED | Shared TS/SQL reviewed |
| BEHAVIORAL TEST VERIFIED | Pure/unit contract tests passed |
| DATABASE CONTRACT VERIFIED | Migration/SQL contract present (not prod-applied) |
| NEXT-BUILD GATE | Needs next emulator/simulator build with flags ON |
| PHYSICAL RUNTIME VERIFIED | Device + real share/revoke — deferred |
| PRODUCTION VERIFIED | Live project — **not claimed** |
| EXTERNAL GATE | Ops/staging/migration apply outside this pass |
| NOT IMPLEMENTED | Explicitly absent |

## Capability matrix

| Capability | Android | iOS | Evidence |
| ---------- | ------- | --- | -------- |
| Hardened share access + owner match | Shared source | Shared source | SOURCE + DATABASE CONTRACT |
| Access-version teardown | Shared | Shared | SOURCE VERIFIED |
| Room-scoped idempotency | Shared | Shared | DATABASE CONTRACT (DR-4 migration) |
| Keyset pagination (no OFFSET) | Shared | Shared | SOURCE + BEHAVIORAL |
| Newer catch-up / `newestCursorRef` | Shared | Shared | SOURCE + BEHAVIORAL |
| Flat depth-1 threads | Shared | Shared | SOURCE VERIFIED |
| Bounded refresh sync | Shared | Shared | SOURCE VERIFIED |
| Access-error sync teardown | Shared | Shared | SOURCE + BEHAVIORAL |
| Send generation / stale guards | Shared | Shared | SOURCE + BEHAVIORAL |
| No AsyncStorage collab state | Shared | Shared | SOURCE + BEHAVIORAL |
| Realtime websocket | NOT IMPLEMENTED | NOT IMPLEMENTED | Stub / OFF |
| Read-state | NOT IMPLEMENTED | NOT IMPLEMENTED | Flag reserved OFF |
| Commerce + Elise separation | Shared | Shared | SOURCE + BEHAVIORAL |
| Flags default OFF | Shared | Shared | SOURCE + BEHAVIORAL |
| Store artifacts (APK/AAB/IPA) | None | None | No mobile build in DR-4 |

## Static config

| Surface | Status |
| ------- | ------ |
| Expo app config | Shared; no OS-specific collab contract fork |
| Feature flags | `constants/featureFlags.ts` env `=== 'true'` |

## What was not claimed

| Claim | Status |
| ----- | ------ |
| Emulator/simulator run this pass | NEXT-BUILD GATE |
| Physical Android + iOS revoke proof | PHYSICAL / EXTERNAL GATE (~1 week next build) |
| Production migration / flags | Not done (`wyyuqfdxucjksghsmhry` RO) |

Test evidence: `__tests__/dr4Hardening.test.js`, `__tests__/dr3Collaboration.test.js`.
