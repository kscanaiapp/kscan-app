# 02 — Runtime Connection Audit

## Active composition point

```
KScanApplication.onCreate
  → ReleaseSafetyGuard.verify()
  → DebugAnalyzeCredentialProvider.read(context)
  → DebugAnalyzeCredentialProvider.mergeInto(DebugAnalyzeConfig.fromBuildConfig())
  → AppRuntimeFactory.resolve(debugConfig=…)
       → bridge / sanitizer / analyzeClient / MockMobileAppBridge
       → ReleaseSafetyGuard.verifyDependencies()
       → RuntimeStatus
MainActivity
  → ScanOrchestratorFactory.create(…)
  → KScanViewModel(bridge, orchestrator, runtimeStatus)
```

## Scan flow matrix

| Stage | Active implementation | Status |
|-------|----------------------|--------|
| Key input | `MainActivity.onKeyDown` → `InputMapper` → `KScanViewModel.onInput` | CONNECTED |
| Escape / Back / Scan | ESCAPE/BACK/DEL→Back; C/CAMERA/R1→ScanShortcut | CONNECTED |
| Compose nav | `KScanGlassesApp` ↔ `AppScreen` | CONNECTED |
| Capture (debug default) | `MockBridgeProvider` synthetic base64 | CONNECTED (mock) |
| Capture (release) | `GoogleBridgeProvider` → `CaptureException` | FAIL-CLOSED STUB |
| Sanitizer mock | `MockPrivacyImageSanitizer` | CONNECTED (mock) |
| Sanitizer strict | `StrictPrivacyImageSanitizer` → `FaceMasker` NotImplemented | FAIL-CLOSED |
| ImageCompressor | Real decode/resize/JPEG re-encode | CONNECTED (unreachable under current FaceMasker) |
| Analyze mock | `MockAnalyzeClient` | CONNECTED (default debug) |
| Analyze debug HTTP | `GlassesDebugEndpointClient` when URL+enabled+**runtime token** | CONNECTED (opt-in) |
| Analyze release | `RealAnalyzeClient` always Disabled | FAIL-CLOSED |
| JSON body (debug) | `AnalyzeRequestJson.encodeGlassesDebugRequest` | CONNECTED |
| JSON body (upstream) | `AnalyzeRequestJson.encodeUpstreamAnalyzeRequest` (bare base64) | CONNECTED |
| Results UI | `ResultsScreen` from orchestrator success | CONNECTED |
| `mobileBridge` | Injected, unused | DISCONNECTED (roadmap stub) |
| Touch on Scan/Results cards | Focus+Select only | KEY-CONNECTED / touch DISCONNECTED (by design for XR) |
| `KScanApiClient` | Deleted | ABSENT (good) |

## Repair impact on wiring

1. **Auth token:** `fromBuildConfig()` still sets `authToken=""` (no BuildConfig secret). Runtime token is merged in `KScanApplication` from `/data/local/tmp/kscan_glasses_debug_token` or app-private file.
2. **Blank token gate:** `GlassesDebugEndpointClientFactory` returns `MockAnalyzeClient` if token blank — never sends empty Bearer.
3. **Cleartext:** debug-only `network_security_config.xml` permits `10.0.2.2` / `localhost` / `127.0.0.1`.
4. **Capture error code:** stub capture throws `CaptureException` so UI maps to `CAPTURE_UNAVAILABLE`.

## Intentional stubs (not defects)

- Face masking unavailable → strict path blocks upload
- Google hardware bridge
- Camera controllers, BLE/Wi-Fi, Supabase sync
- `LIVE_ANALYSIS_AUTHORIZED` unreachable by design
