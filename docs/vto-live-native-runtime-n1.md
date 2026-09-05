# Live VTO Native Runtime N1

Android execution authority for a real, executable, installable native Live VTO runtime. iOS is deferred to N2 (mission section 54).

## Authority

- Precondition (mission section 1 / amendment B0): PR #303 (`feature/vto-phase4-2-catalog-addressability`) merged 2026-09-05T22:25:17Z per explicit owner directive, merge commit `909df8646a690b55c5af6b7b8c80193df64a2ec8`. Phase 4.2's own quota-blocked corpus-measurement closeout remains deferred on the program ledger (owner directive: do not reopen it here, do not wait on provider quota).
- Base / verified integration SHA: `909df8646a690b55c5af6b7b8c80193df64a2ec8` (`integration/backend-kplus-complimentary-staging-v1`), re-fetched and confirmed as an ancestor after the merge -- not assumed from a pre-merge value.
- Branch: `feature/live-vto-native-runtime-n1`, worktree `C:\src\KScan-live-vto-native-n1-20260905`.
- PR: opened draft against `integration/backend-kplus-complimentary-staging-v1` once the first commit landed (GitHub refuses a PR with zero diff).

## What already existed on integration before N1 (do not recreate)

The mission's amendment B3 describes a "P3-C application contract" as already merged. Verified true, not aspirational:

- Feature flag: `constants/featureFlags.ts` -- `EXPO_PUBLIC_LIVE_VTO_ENABLED` -> `LIVE_VTO_ENABLED`, default OFF, absent from every EAS profile (tested).
- Native module name constant: `LIVE_VTO_NATIVE_MODULE_NAME = 'KScanLiveVto'`.
- Command/event contract: `types/vtoLive.ts` -- `LIVE_VTO_COMMANDS`, `LIVE_VTO_EVENTS`, `FORBIDDEN_LIVE_EVENT_PAYLOAD_KEYS`, session states, runtime error states, the clean-frame rule (`assertCleanPersonFrame`), Photoreal intent state machine.
- Native module TS interface: `services/vto/liveVtoNativeModule.ts` -- `LiveVtoNativeModule` (the exact surface a real native module must expose), `describeLiveVtoNativeCapability` (safe, synchronous, total capability check), `getLiveVtoNativeModule` (lazy `requireOptionalNativeModule` lookup).
- Session/capability layers: `services/vto/vtoLiveSession.ts`, `services/vto/vtoLiveCapability.ts`, `hooks/useVtoLiveCapability.ts`, `hooks/useVtoLiveSession.ts`.
- Dev-only simulated harness (`services/vto/vtoLiveHarness.ts`, `EXPO_PUBLIC_LIVE_VTO_HARNESS`): exercises UI states with no frame concept at all. Not touched by N1 -- N1 builds the real path, a different code path gated by the same top-level flag.
- Test suite already governing all of the above: `__tests__/vtoLive*.test.js` (7 files) plus `vtoLiveIntegrationScope.test.js`.
- Existing local Expo Android module precedent: `modules/kscan-voice-native/android` (Kotlin, `expo.modules.kscanvoicenative`) -- used as N1-A's structural template. `modules/kscan-pii-native` is iOS-only, not a template for Android.

Divergences between the mission text and this merged reality are in the defect ledger (N1-ENV-001, N1-ENV-002), not silently resolved.

## Gate status

### N1-A -- module scaffold + registration

New local Expo module `modules/kscan-live-vto-native` (Android only; iOS deferred to N2), registered under `expo.modules.kscanlivevtonative.KScanLiveVtoNativeModule`, linked via `"kscan-live-vto-native": "file:./modules/kscan-live-vto-native"` in root `package.json` -- same pattern as `kscan-voice-native`.

`definition()` exposes exactly one member so far: `Function("getCapability")` (synchronous -- the merged JS adapter calls it without `await`; an `AsyncFunction` here would hand back a Promise and silently break every capability check), returning `{capable: false, runtimeReady: false, runtimeVersion: "n1-a"}`. No `Events()`, no commands yet -- those land gate by gate as their real implementations exist, not speculatively.

**Compile evidence:** `./gradlew projects` -- BUILD SUCCESSFUL, `:kscan-live-vto-native` present in the project graph alongside `:kscan-voice-native`, autolinked with zero manual `settings.gradle` edits. `./gradlew :app:assembleDebug` run for full-app compile + runtime evidence (see environment doc for toolchain versions).

**Runtime evidence:** temporary diagnostic route `app/dev-n1-diagnostic.tsx`, reached via the app's own existing `EXPO_PUBLIC_DEV_INITIAL_ROUTE` dev harness (no product code touched), calls the real `describeLiveVtoNativeCapability()` adapter path and logs/renders the result. Local test build points at **staging** Supabase, never production. Full runtime capture (device boot -> module registers -> JS calls `getCapability()` -> Kotlin responds -> `capable:false, runtimeReady:false` observed) is the specific remaining item for this gate -- tracked as in-progress, not claimed complete until the log line is actually captured.

### N1-B through N1-G

Not started. Each gate's own hard requirements (mission sections 8-48) apply unchanged; this document will be extended gate by gate rather than restating the mission text.

## Evidence index

Screenshots/logs/build IDs go under `evidence/vto-live-native-n1/` as each gate closes (mission section 63 -- no committed raw user frames, no committed person imagery).
