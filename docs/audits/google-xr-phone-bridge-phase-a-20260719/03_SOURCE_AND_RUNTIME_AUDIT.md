# 03 — Source and Runtime Audit

## Active composition path

```text
KScanApplication
  → AppRuntimeFactory.resolve()
      → ReleaseSafetyGuard.verify (flags)
      → PhoneBridgeProvider selection
      → ReleaseSafetyGuard.verifyDependencies (instances)
  → MainActivity
      → ScanOrchestratorFactory (phoneBridge)
      → KScanViewModel(phoneBridge)
          → startConnectedMode when non-null
          → ConnectedRuntimeStateMachine ← provider.events
          → ConnectedHudScreen
```

## Configuration matrix

| Build | `useMockPhoneBridge` | Provider | UI mode |
|---|---|---|---|
| Debug default | false | `DisabledPhoneBridgeProvider` | Connected HUD — “Phone bridge disabled” |
| Debug + `KSCAN_DEBUG_MOCK_PHONE_BRIDGE=true` | true | `MockPhoneBridgeProvider` | Full mock connected flow |
| Release | forced false | `FutureRealPhoneBridgeProvider` | Connected HUD — unavailable stub |

Legacy scan (`phoneBridge == null`) remains for tests; production MainActivity always injects a provider.

## Runtime path integrity

- Placeholder `mobilebridge/` package: **removed**.
- Capture-side `bridge/` (`MockBridgeProvider` / `GoogleBridgeProvider`) is a separate local capture abstraction — not a duplicate phone bridge.
- Validator sits between raw transport and events on the mock path.
- `FutureRealPhoneBridgeProvider` remains a fail-safe stub (Phase A intentional).

## Concurrency / lifecycle

- No `GlobalScope` in phonebridge / connected runtime.
- Mock provider uses child `SupervisorJob`; `close()` cancels provider job only.
- Ack watchdog cancelled when leaving `RESULTS`.
- Broad catches avoided in bridge path; rejections map to `BridgeRejectCode`.

## HUD / input

- Twelve states render metadata-driven titles/actions (≤3 actions).
- Closet / Settings on DISCONNECTED and READY.
- Confirmation only with pending action + `result.update` (post-repair).
- KEYCODE_C / D-pad / Back / Escape wired via `InputMapper` → ViewModel.

## Deprecated workspace references

- No Gradle/Kotlin source path depends on `C:\Users\jsmit\kscan-google-glasses`.
- Historical docs still mention the name; active scripts/defaults repaired to `kscan-google-glasses-canonical`.
- npm package name `kscan-google-glasses` is a package identifier, not a filesystem path.
