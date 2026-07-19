# 07 — Defects and Repairs

## Fixed findings

### A-001

```text
Finding ID: A-001
Severity: Blocker
Status: FIXED
Builder claim affected: 8, 9, 18/session replace semantics; silent session hijack risk
User-visible or system impact: Mid-session pair.approved could overwrite validator trust without UI revoke
Reproduction: After pairAndReady, register new pair.request and accept pair.approved from another deviceId
Root cause: isPairFamily skipped WRONG_DEVICE/session-state for all pair replies, including while session active
File(s): PhoneBridgeValidator.kt
Class/function: semanticRejection / onAccepted
Approximate line or code region: pair-family branch in semanticRejection
Repair: Reject pair.approved/denied/expired while currentSessionId != null && !sessionRevoked; allow re-pair only after revoke; clamp session TTL
Why this repair was selected: Smallest fail-closed fix preserving intentional re-pair-after-revoke
Tests added or changed: pair approved while session is active is rejected; re-pair after revoke accepts a new session
Focused verification: PhoneBridgeValidatorTest + ConnectedRuntimeStateMachineTest green
Full-regression result: 397/397 debug & release; npm/backend green
Commit: 218c9f8 fix(xr-bridge): harden session replace, TTL, and result ack rules
Remaining risk: None material for Phase A mock/stub transport
```

### A-002

```text
Finding ID: A-002
Severity: P1
Status: FIXED
Builder claim affected: 8 (session expiry derived safely)
User-visible or system impact: Unbounded or already-expired sessions could be granted
Reproduction: pair.approved with sessionExpiresAt == timestamp or > timestamp+24h
Root cause: sessionExpiresAt trusted verbatim
File(s): PhoneBridgeProtocol.kt, PhoneBridgeValidator.kt
Class/function: MAX_SESSION_DURATION_MS; semanticRejection PairApproved branch
Repair: Require timestamp < expiresAt <= timestamp + 24h
Why this repair was selected: Explicit bounded grant matching product safety intent
Tests added or changed: pair approved with unbounded or already-expired session lifetime is rejected
Focused verification: PhoneBridgeValidatorTest
Full-regression result: green matrix
Commit: 218c9f8
Remaining risk: 24h ceiling is policy; real companion may choose shorter TTLs
```

### A-003

```text
Finding ID: A-003
Severity: P1
Status: FIXED
Builder claim affected: 27, 30, 31
User-visible or system impact: Duplicate/unsolicited result.update could confirm actions optimistically
Reproduction: ResultUpdated in RESULTS without SaveTapped → previously ACTION_CONFIRMED; replayed same revision accepted
Root cause: No result.update dedup/known-result check; machine defaulted pendingAction to SAVE
File(s): PhoneBridgeValidator.kt, ConnectedRuntimeStateMachine.kt
Class/function: semanticRejection ResultUpdate; onBridgeEvent ResultUpdated
Repair: Track knownResultIds + acceptedResultUpdateKeys; confirm only when pendingAction != null
Why this repair was selected: Aligns confirmation with ack semantics without rewriting transport
Tests added or changed: duplicate result update revision; unknown result id; unsolicited result update refreshes without confirming; open-on-phone test shows result first
Focused verification: Validator + state machine + mock companion tests
Full-regression result: green matrix
Commit: 218c9f8
Remaining risk: Phone-initiated result pushes still refresh RESULTS (intentional)
```

### A-004

```text
Finding ID: A-004
Severity: P2
Status: FIXED
Builder claim affected: 20–22 (release mock flag hardening parity)
User-visible or system impact: Local assembleRelease could inherit mock flag from local.properties and fail-fast crash
Reproduction: Set KSCAN_DEBUG_MOCK_PHONE_BRIDGE=true in local.properties; assembleRelease
Root cause: Flag only in defaultConfig; not overridden in release {}
File(s): android-xr/app/build.gradle.kts
Repair: buildConfigField false in release block
Why this repair was selected: Matches USE_MOCK_* siblings
Tests: ReleaseSafetyGuard + BuildConfig inspection (false in release)
Full-regression result: green
Commit: 218c9f8
Remaining risk: None
```

### A-005

```text
Finding ID: A-005
Severity: P2
Status: FIXED
Builder claim affected: 17; documentation accuracy
User-visible or system impact: Contributors pointed at deleted mobilebridge/ or deprecated workspace
Reproduction: Read docs/MOBILE_APP_BRIDGE.md; scripts/verify-structure.ps1 default; BUILD_READINESS paths
Root cause: Doc/script drift after 052ba26 and workspace rename
File(s): docs/MOBILE_APP_BRIDGE.md, docs/BUILD_READINESS.md, scripts/verify-structure.ps1, AppRuntimeFactory KDoc, PHONE_BRIDGE_PROTOCOL.md
Repair: Point to phonebridge + canonical workspace; document session/result rules
Why this repair was selected: Correct integration handoff without code churn
Tests: n/a (docs)
Full-regression result: n/a
Commit: 633dbb9 (docs) + 218c9f8 (AppRuntimeFactory KDoc / transport note)
Remaining risk: Older historical audit docs still mention deprecated paths by design
```

### A-006

```text
Finding ID: A-006
Severity: P2
Status: FIXED
Builder claim affected: 6 (ceiling before parsing at transport boundary)
User-visible or system impact: Future real transport could allocate unbounded Strings before validator
Reproduction: Design review of PhoneBridgeTransport.incoming: Flow<String>
Root cause: Ceiling checked after String materialization
File(s): PhoneBridgeTransport.kt, docs/google/PHONE_BRIDGE_PROTOCOL.md
Repair: Document hard read-side abort requirement for implementers
Why this repair was selected: Interface change deferred; contract lock sufficient for Phase A
Tests: existing oversized String tests remain
Full-regression result: green
Commit: 218c9f8 + 633dbb9
Remaining risk: Must be enforced when FutureReal transport is implemented
```

## False positives / non-defects

| ID | Note |
|---|---|
| FP-1 | “Legacy scan dead in debug default” — intentional Connected HUD with Disabled provider (MainActivity comment). Null provider path still works for tests. Documented, not repaired as a bug. |
| FP-2 | Builder XR “system-service instability” as standing gate — XR AVD cold-booted healthy in this audit. |

## Remaining P3

| ID | Item | Follow-up |
|---|---|---|
| P3-1 | Debug `MockScenarioReceiver` exported without permission (lint ExportedReceiver) | Keep for adb; optional signature permission later |
| P3-2 | Illegal transitions silent (no SafeLog) | Optional debug breadcrumb |
| P3-3 | Lint OldTargetApi / GradleDependency / ExifInterface / unused params | Pre-existing hygiene |
| P3-4 | Legacy npm bridge-contract suites vs Kotlin v1 | Relabel or retire in a later cleanup |
| P3-5 | Release BuildConfig still inherits debug analyze URL fields from local.properties | Pre-existing; analyze path gated separately |
| P3-6 | Some XR `adb dumpsys/logcat -d` hangs | Emulator tooling; use non-blocking probes |

## Environmental limitations

XR emulator adb wait/dumpsys flakiness remains an external tooling issue. Application install + process liveness were proven after service health recovery.
