# 05 — Repairs and Regression Results

Repairs are present on branch `audit/google-xr-postbuild-integration-repair-20260719` (working tree; pending commit at report time).

## Repair inventory

### R1 — Debug auth disconnected (Critical)

| | |
|--|--|
| **Defect** | `DebugAnalyzeConfig.fromBuildConfig()` always set `authToken=""`. Docs still told operators to put token in `local.properties`, but BuildConfig never emitted it. Live debug client would send empty Bearer or never authenticate. |
| **Root cause** | Security hardening removed BuildConfig token without shipping the promised runtime credential provider. Factory documented gate 5 but did not enforce blank token. |
| **Fix** | Added `DebugAnalyzeCredentialProvider`; merge in `KScanApplication`; factory returns `MockAnalyzeClient` when token blank. |
| **Files** | `DebugAnalyzeCredentialProvider.kt`, `KScanApplication.kt`, `GlassesDebugEndpointClientFactory.kt`, tests, `docs/BUILD_CONFIG_SECURITY.md`, PHASE_3D docs |
| **Tests** | `DebugAnalyzeCredentialProviderTest`, factory blank-token test |
| **Result** | Pass |

### R2 — Cleartext HTTP blocked for emulator host (High)

| | |
|--|--|
| **Defect** | Docs require `http://10.0.2.2:…`; targetSdk 34 blocks cleartext; no network security config. |
| **Root cause** | Debug INTERNET permission added without loopback cleartext policy. |
| **Fix** | Debug-only `network_security_config.xml` for `10.0.2.2` / `localhost` / `127.0.0.1`; referenced from debug manifest. |
| **Files** | `src/debug/res/xml/network_security_config.xml`, `src/debug/AndroidManifest.xml`, `tests/permission-surface.test.ts` |
| **Result** | Pass (static + build) |

### R3 — Upstream image contract mismatch (High)

| | |
|--|--|
| **Defect** | `RealGlassesAnalyzeService` forwarded full data URL; `shared/api-contract.md` requires bare base64. |
| **Fix** | `toBareBase64()` before upstream POST; Android `AnalyzeRequestJson.encodeUpstreamAnalyzeRequest`. |
| **Files** | `backend/services/glassesAnalyzeService.js`, `AnalyzeRequestJson.kt`, `RealAnalyzeClient.kt`, tests |
| **Result** | Pass |

### R4 — Disabled backend returned mock service (Medium)

| | |
|--|--|
| **Defect** | `createGlassesAnalyzeService()` when disabled returned `MockGlassesAnalyzeService` (docs claimed mock-on-disable for HTTP; HTTP already 503, but defensive path was wrong). |
| **Fix** | `DisabledGlassesAnalyzeService` throws `CONFIG_DISABLED`. |
| **Result** | Pass |

### R5 — Capture stub wrong exception type (Medium)

| | |
|--|--|
| **Defect** | `GoogleBridgeProvider.capturePhoto()` threw `UnsupportedOperationException`; ViewModel mapped to `UNKNOWN_SAFE_ERROR` instead of `CAPTURE_UNAVAILABLE`. |
| **Fix** | Throw `CaptureException`. |
| **Files** | `GoogleBridgeProvider.kt`, `GoogleBridgeProviderTest.kt` |
| **Result** | Pass |

### R6 — Fragile RealAnalyzeClient JSON (Medium)

| | |
|--|--|
| **Defect** | Hand-built `StringBuilder` JSON with no escaping; data URL not stripped for upstream. |
| **Fix** | Use `AnalyzeRequestJson.encodeUpstreamAnalyzeRequest`. |
| **Result** | Pass |

### R7 — Documentation drift (Medium)

| | |
|--|--|
| **Defect** | SETUP pointed at deprecated workspace; debug endpoint doc claimed disabled→mock HTTP; `.env.example` mixed Android token keys with Node env. |
| **Fix** | Updated SETUP, PHASE_3D, GLASSES_ANALYZE_DEBUG_ENDPOINT, BUILD_CONFIG_SECURITY, `.env.example`. |
| **Result** | Pass |

## Not repaired (intentional / external)

| Item | Reason |
|------|--------|
| Face masking NotImplemented | Roadmap; fail-closed correct |
| Hardware capture / camera | Roadmap stubs |
| `mobileBridge` unused | Roadmap |
| Touch click handlers on cards | XR key/focus design |
| Controlled live upstream auth | External credential / main-backend gate |
| Full emulator visual matrix | Screencap/UIAutomator unstable on XR |

## Validation after repairs

| Suite | Passed | Failed | Skipped |
|-------|--------|--------|---------|
| Root `npm test` | 27 | 0 | 0 |
| Phone bridge | 5 | 0 | 0 |
| Backend | 21 | 0 | 0 |
| Android unit (`--rerun-tasks`) | 264 | 0 | 0 |
| lintDebug | SUCCESS | — | — |
| assembleDebug | SUCCESS | — | — |
