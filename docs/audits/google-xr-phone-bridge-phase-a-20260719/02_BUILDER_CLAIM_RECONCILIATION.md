# 02 — Builder Claim Reconciliation

Builder starting HEAD: `d293449` · Builder final HEAD: `9996d06` · Verified match at audit start.

| # | Builder claim | Source evidence | Test/runtime evidence | Verdict | Repair |
|---|---|---|---|---|---|
| 1 | 26 sealed message types | `PhoneBridgeMessage.kt` | `PhoneBridgeContractTest` asserts 26 | **Verified** | — |
| 2 | Seven families | Discriminators `pair/session/capture/scan/result/action/connection` | Contract family map | **Verified** | — |
| 3 | `classDiscriminator = "messageType"` | `PhoneBridgeCodec.kt` | Round-trip tests | **Verified** | — |
| 4 | Unknown JSON fields rejected | `ignoreUnknownKeys = false` | Decode → `INVALID_MESSAGE` | **Verified** | — |
| 5 | Session envelope fields required | No defaults on session-bearing types (except `PairRequest.sessionId=""`) | Validator tests | **Verified** | — |
| 6 | 65536-byte ceiling pre-parse + encode | Validator step 1; codec encode check | Oversized tests | **Verified** (String already allocated; transport doc repaired) | A-006 |
| 7 | 30s timestamp skew | `TIMESTAMP_TOLERANCE_MS=30_000` | Stale/future tests | **Verified** | — |
| 8 | Session expiry from pairing approval | `sessionExpiresAt` stored from `pair.approved` | Expiry tests | **Repaired** | A-002 clamp |
| 9 | Validation before ViewModel/UI | Mock provider validates before emit | Hud tests | **Verified** | — |
| 10 | Stable safe error codes | 13 `BridgeRejectCode` values | Validator mapping tests | **Verified** | — |
| 11 | No stack traces to HUD | `SafeLog` + `ui.errorCode` only | Log-safety npm test | **Verified** | — |
| 12 | Mock deterministic | Injected clock, sequential ids | Scenario tests | **Verified** | — |
| 13 | 16 scenarios exist | `MockCompanionScenarios` constants | Scenario test suite | **Verified** | — |
| 14 | Debug scenario seam debug-only | `src/debug` + debug manifest only | Source-set inspection | **Verified** | — |
| 15 | Double-gated | Manifest + `BuildConfig` + `is MockPhoneBridgeProvider` | Receiver source | **Verified** | — |
| 16 | Release cannot register receiver | Absent from main/release manifest | Manifest merge | **Verified** | — |
| 17 | Placeholder `mobilebridge` removed | Package deleted in `052ba26` | Grep: no Kotlin refs | **Verified** (docs repaired) | A-005 |
| 18 | No duplicate active phone bridge | Three providers only | Factory tests | **Verified** | — |
| 19 | Mock / future-real / disabled exist | Three classes | Provider tests | **Verified** | — |
| 20 | Mock defaults false | `debugPropertyBoolean` default false | BuildConfig false | **Verified** | — |
| 21 | Release → future-real/disabled safe | Factory `else → FutureReal` | Factory + guard tests | **Verified** | — |
| 22 | Release guard inspects instance | `is MockPhoneBridgeProvider` throw | `ReleaseSafetyGuardTest` | **Verified** | — |
| 23 | One authoritative state owner | `ConnectedRuntimeStateMachine` | Machine tests | **Verified** | — |
| 24 | 12 states | Enum in machine | Transition tests | **Verified** | — |
| 25 | Illegal transitions rejected | Silent no-op guards | Illegal-transition test | **Verified** | — |
| 26 | Stale completions cannot overwrite | `scanId` + state gates | Machine tests | **Verified** | — |
| 27 | Duplicate results cannot render twice | Validator + RESULTS refresh | Dedup tests | **Verified** (+ result.update) | A-003 |
| 28 | Revocation disconnects all session states | `SessionRevoked` → DISCONNECTED | Machine tests | **Verified** | — |
| 29 | Outbound actions complete envelopes | Provider builders + envelope test | `OutboundActionEnvelopeTest` | **Verified** | — |
| 30 | Action acks correlated | Pending action + resultId/revision | Hud + validator tests | **Repaired** | A-003 |
| 31 | Confirmation only after ack | Watchdog + pendingAction gate | Hud tests | **Repaired** | A-003 |
| 32 | 3s watchdog | `DEFAULT_ACK_TIMEOUT_MS` | Timeout test | **Verified** | — |
| 33 | D-pad / Select / Back / Escape / C | `InputMapper` + ViewModel | Phone emu key smoke | **Verified** | — |
| 34 | Closet/Settings overlays | Focus lists on DISCONNECTED/READY | Source + tests | **Verified** | — |
| 35 | Default non-provider flow compatible | `phoneBridge=null` legacy path | ViewModel tests with null | **Verified** (debug default injects Disabled HUD by design) | Doc clarify |
| 36 | Mock/hardware-pending labels truthful | Status → HUD copy | UI source | **Verified** | — |
| 37 | 390 debug + 390 release tests | — | **397 / 397** after repairs | **False → corrected** | Count updated |
| 38 | Root / phone-bridge / backend totals | — | 27 / 5 / 21 | **Verified** (exact) | — |
| 39 | Lint pass with reported warnings | lintDebug exit 0 | ExifInterface, OldTargetApi, GradleDependency, modifierParameter, ExportedReceiver | **Verified** (warnings P3/pre-existing) | — |
| 40 | Debug assembly succeeds | `assembleDebug` | APK produced | **Verified** | — |
| 41 | Artifacts match final HEAD | Rebuilt in audit | New SHA-256 recorded | **Verified** (rebuilt) | — |

## Commit range verification

```text
aceb107 test(xr-analyze): scope AnalyzeClientFactory tests to build variant
1bda0cf feat(xr-bridge): add versioned phone bridge protocol
2573d5c feat(xr-bridge): add message validation layer with safe error codes
ad6032b feat(xr-bridge): add mock phone companion transport
b17b840 test(xr-bridge): add protocol and state transition coverage
052ba26 feat(xr-bridge): wire versioned providers behind runtime factory
d053326 feat(xr-ui): add connected runtime state machine
07728f8 feat(xr-bridge): add outbound action path with acknowledgement
a3a243a feat(xr-ui): add connected runtime HUD
59d8c6e feat(xr-bridge): add debug-only autopilot and scenario seam
9996d06 fix(xr-bridge): export debug scenario receiver
```

All eleven commits present and matching messages. `aceb107` inspected: adds release fail-closed tests; does **not** hide release behavior.
