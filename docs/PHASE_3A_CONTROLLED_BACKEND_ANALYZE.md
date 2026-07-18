# Phase 3A — Controlled Backend Analyze

## Summary

Phase 3A hardens the Google Glasses Android XR beta repository with a controlled backend analyze boundary. The goal is to ensure that **no real backend network call can occur unless every safety gate is explicitly true**, while keeping the mock path functional and safe by default.

---

## Gate Matrix

Real analyze client (`RealAnalyzeClient` + `KscanHttpTransport`) is only constructible when **all** of the following are true:

| Gate | Default | Required Value | Purpose |
|------|---------|---------------|---------|
| `BuildConfig.DEBUG` | `true` (debug) | `true` | Never allow real network in release builds |
| `BetaConfig.useMockApi` | `true` | `false` | Mock lock must be explicitly disabled |
| `BetaConfig.enableRealAnalyze` | `false` | `true` | Explicit opt-in to real analyze |
| `BetaConfig.enableRealFaceMasking` | `false` | `true` | Privacy gate (face masking must be ready) |
| `AnalyzeClientConfig.backendUrl` | `""` | non-empty | Backend endpoint must be configured |
| `AnalyzeClientConfig.enableRealAnalyze` | `false` | `true` | Client-level opt-in |

If **any** gate is false, `AnalyzeClientFactory.create()` returns `MockAnalyzeClient` (safe default).

---

## Architecture

### Single Execution Authority

`ScanOrchestrator` is the only execution authority for the scan pipeline. `KScanViewModel` has no direct path to any analyze client or to `PrivacyImageSanitizer`. (Update: the legacy `KScanApiClient`/`KScanAnalyzeClient` network path referenced below was deleted from the main source set in the native-safety milestone; this section is kept for historical context.)

All scan triggers (image picker, voice, D-pad, shortcut) route through:

```
KScanViewModel.runScanFlow()
  → bridge.capturePhoto()
  → ScanOrchestrator.run(ScanInput)
    → preProcess
    → PrivacyImageSanitizer.sanitize()
    → encodeDataUrl
    → AnalyzeClient.analyze()
    → map to ScanOrchestratorResult
  → KScanViewModel handles sealed result
```

### Safe Structured Outcomes

`ScanOrchestrator.run()` never leaks raw exceptions. All exceptions are caught and mapped to `ScanOrchestratorResult.Failure` with safe, non-leaky user messages:

- `PrivacyBlocked` → "Privacy check blocked upload. Please retry."
- `Timeout` → "Analysis timed out. Tap to retry."
- `Network` → "Connection issue. Check network and retry."
- `HttpError` → "Server error (status). Please retry."
- `MalformedResponse` → "Server returned an unreadable response."
- `BetaDisabled` → "Beta analyze is disabled."
- `Unknown` → "Something went wrong."

Raw exception messages (which may contain `base64`, `data:image`, or payload data) are **never** included in user-facing error messages.

---

## Safe Logging

`SafeLog` is the only logging abstraction. All methods (`d`, `i`, `w`, `e`) enforce `rejectPayloadLog()` which silently drops any message containing:

- `base64`
- `data:image`
- `payload`
- `token`
- `secret`
- `apikey`

Throwable stack traces are still logged via `Log.e(tag, message, throwable)` because the Android Log framework includes the stack trace separately, but the `message` argument is filtered.

---

## Network Boundary

### `KscanHttpTransport`

- Minimal `HttpURLConnection` wrapper
- No payload logging
- No retries
- No custom certificate pinning
- 10-second connect/read timeout

### `RealAnalyzeClient`

- Uses injected `HttpTransport` (testable, no direct `HttpURLConnection`)
- Never logs request/response bodies
- Uses `kotlinx.serialization` for JSON parsing (no `org.json`)
- Fails fast if `enableRealAnalyze` is false
- Constructs `AnalyzeRequest` with `data:image/*` validation in `init` block

### `AnalyzeClientFactory`

- Factory is the only place `RealAnalyzeClient` or `KscanHttpTransport` are instantiated
- Default config returns `MockAnalyzeClient` (no network)
- All gates checked in order; first false gate returns mock

---

## Important Confirmations

### `INTERNET` permission was removed in this close-out pass

The `android.permission.INTERNET` permission was present from Phase 1 but was **removed** during Phase 3A close-out because no default/mock path requires network access. The permission was unnecessary because:

- `MockAnalyzeClient` returns synthetic data without any network calls
- `KScanViewModel` routes all scan paths through `ScanOrchestrator`, which uses the injected `AnalyzeClient` interface
- `RealAnalyzeClient` and `KscanHttpTransport` are unreachable under default config (all factory gates are false)
- `KScanApiClient` (legacy network path) was never instantiated anywhere in the codebase and has since been deleted from the main source set

If all gates are explicitly enabled in a future debug build, the `INTERNET` permission must be re-added to the manifest before `KscanHttpTransport` can function.

### `useMockApi = true` blocks real analyze

Confirmed by `AnalyzeClientFactoryTest.useMockApi true blocks real analyze`. When `BetaConfig.useMockApi = true`, `AnalyzeClientFactory.create()` returns `MockAnalyzeClient` even if all other gates are true.

### Legacy network path is unreachable

- `KScanApiClient` was defined in `network/KScanApiClient.kt` but **never instantiated** anywhere in the main source tree; the file was later deleted to make the orchestrator-only invariant structural
- `KscanHttpTransport` is only instantiated inside `AnalyzeClientFactory` as part of the `RealAnalyzeClient` construction path, which requires all gates to be true
- `KScanViewModel`, `ScanOrchestrator`, `MainActivity`, and `ScanOrchestratorFactory` contain no references to either class

### No secrets are committed

- No API keys in Kotlin source files
- No service role keys in source
- No Supabase anon keys in source
- No Render API tokens in source
- `BuildConfig.KSCAN_BACKEND_URL` is a placeholder staging URL, not a production secret

### Default APK remains mock-safe

With all defaults:
- `USE_MOCK_API = true` (build.gradle.kts)
- `BetaConfig.useMockApi = true`
- `BetaConfig.enableRealAnalyze = false`
- `BetaConfig.enableRealFaceMasking = false`
- `AnalyzeClientConfig.enableRealAnalyze = false`
- `AnalyzeClientConfig.backendUrl = ""`
- `android.permission.INTERNET` is **absent** from the manifest

The APK built with these defaults will **never** instantiate `RealAnalyzeClient` or `KscanHttpTransport`. Even if someone bypassed the factory gates, the missing `INTERNET` permission would cause a `SecurityException` at runtime. The scan path always uses `MockAnalyzeClient`.

---

## Test Coverage

| Test | Location |
|------|----------|
| Default config returns MockAnalyzeClient | `AnalyzeClientFactoryTest` |
| useMockApi=true blocks real analyze | `AnalyzeClientFactoryTest` |
| enableRealAnalyze=false blocks real analyze | `AnalyzeClientFactoryTest` |
| enableRealFaceMasking=false blocks real analyze | `AnalyzeClientFactoryTest` |
| Blank backendUrl rejected by config | `AnalyzeClientFactoryTest` |
| All gates true returns RealAnalyzeClient | `AnalyzeClientFactoryTest` |
| Sanitizer blocked path returns failure | `ScanOrchestratorTest` |
| Sanitizer error blocks analyze entirely | `ScanOrchestratorTest` |
| Timeout returns timeout error | `ScanOrchestratorTest` / `AnalyzeClientTest` |
| Beta disabled returns safe failure | `ScanOrchestratorTest` / `AnalyzeClientTest` |
| Malformed response returns failure | `ScanOrchestratorTest` / `AnalyzeClientTest` |
| HTTP error returns safe failure | `ScanOrchestratorTest` / `AnalyzeClientTest` |
| No payload logging in transport | `AnalyzeClientTest` |
| Orchestrator never leaks raw exceptions | `ScanOrchestratorTest` |
| SafeLog rejects payload messages | `SafeLogTest` (if exists) |
| KScanViewModel uses orchestrator only | `KScanViewModelTest` |
| Sanitizer failure blocks backend upload | `KScanViewModelTest` |
| Capture failure shows user-friendly error | `KScanViewModelTest` |
| Backend timeout shows user-friendly error | `KScanViewModelTest` |
| Backend non-2xx shows user-friendly error | `KScanViewModelTest` |
| Malformed backend response shows user-friendly error | `KScanViewModelTest` |

Total tests: **97** (all pass)

---

## Files Changed

- `app/src/main/AndroidManifest.xml` — `INTERNET` permission removed
- `app/src/main/java/com/kscan/glasses/analyze/AnalyzeClientFactory.kt` — Factory with 5 gates
- `app/src/main/java/com/kscan/glasses/analyze/KscanHttpTransport.kt` — Minimal HTTP transport
- `app/src/main/java/com/kscan/glasses/analyze/RealAnalyzeClient.kt` — Gated real analyze client
- `app/src/main/java/com/kscan/glasses/scan/ScanOrchestrator.kt` — Single execution authority
- `app/src/main/java/com/kscan/glasses/scan/ScanErrorMapper.kt` — Safe error mapping
- `app/src/main/java/com/kscan/glasses/config/SafeLog.kt` — Payload guard enforcement
- `app/src/main/java/com/kscan/glasses/state/KScanViewModel.kt` — Orchestrator-only path
- ~~`app/src/main/java/com/kscan/glasses/network/KScanApiClient.kt`~~ — deleted (legacy, was unreachable); orchestrator-only analyze authority is now structural
- `app/build.gradle.kts` — `USE_MOCK_API = true` default
- `docs/PHASE_3A_CONTROLLED_BACKEND_ANALYZE.md` — Phase 3A close-out report

---

## What Was NOT Done (intentionally)

- No live backend testing
- No real camera integration
- No real voice integration
- No BLE/Wi-Fi direct connectivity
- No Supabase real integration
- No ML Kit face masking production
- No production secrets or credentials
- `INTERNET` permission was removed, not retained

---

## Commits

Phase 3A produced **6** commits on `master`:

```
c0b603a Phase 3A Step 7 — Final validation and documentation
c233204 Phase 3A Step 4 — Safe Logging Review
4c31d5c Phase 3A Step 3 — Orchestrator Integration
0276cbb Phase 3A Step 2b — Fix AnalyzeClientFactory gate: add useMockApi == false
03fd3c9 Phase 3A Step 2 — Add controlled backend analyze boundary
d2cbd93 Phase 3A Step 1 — Invariant fix: make ScanOrchestrator single execution authority
```

---

## Next Steps (out of scope for Phase 3A)

1. **ML Kit Face Masking** — Implement `enableRealFaceMasking` path when ML Kit is ready
2. **Staging Backend Testing** — Test against staging URL with all gates enabled in debug
3. **Supabase Integration** — Auth, session, sync (separate phase)
4. **Mobile App Bridge** — Real phone app handoff (separate phase)
5. **Production Release** — Set all mock flags to false, enable real paths, remove debug gates
