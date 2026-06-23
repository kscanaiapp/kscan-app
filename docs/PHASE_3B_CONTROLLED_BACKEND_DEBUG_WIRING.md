# Phase 3B — Controlled Backend Debug Wiring (Dry-Run Only)

## Summary

Phase 3B prepares a **debug-only backend analyze dry-run path** that can later support one controlled real backend smoke test. This phase proves wiring and safety through tests and dry-run behavior only — **no live backend call was performed**, **no `INTERNET` permission was added**, and **no transport was constructed**.

Default behavior remains unchanged:

```
local/mock image input → privacy pipeline → sanitizer gate → encoded sanitized payload
  → MockAnalyzeClient → ScanOrchestrator result → HUD/session
```

Optional real-backend dry-run wiring is possible only behind explicit debug-only gates.

---

## What Was Added

1. **`BetaConfig.enableDryRun`** — defaults to `false`.
2. **`DebugAnalyzeConfig`** — reads `BuildConfig.KSCAN_DEBUG_ANALYZE_*` fields populated from gitignored `local.properties` (or project properties). Committed defaults are blank/disabled.
3. **`AnalyzeDryRunGate`** — evaluates all 9 real-analyze readiness gates without constructing or calling `KscanHttpTransport`.
4. **`DryRunGateResult`** / `ScanOrchestratorResult.DryRunReady` / `DryRunBlocked` / `ConfigBlocked` — safe sealed results that carry no payloads, URLs, tokens, or raw exceptions.
5. **ScanOrchestrator dry-run integration** — after sanitizer success and data URL validation, `enableDryRun=true` routes to the dry-run gate before any analyze client call.
6. **`BetaSafetyGuard.permitsRealAnalyzePreparation()`** — returns `true` only in debug builds with a safe config combination. It does not override sanitizer failure and does not permit live network execution.
7. **Transport hardening** — `KscanHttpTransport` now uses 10s connect / 15s read timeout, disables redirects, disables caching, and `RealAnalyzeClient` rejects non-HTTPS backend URLs.
8. **Test coverage** — 19 new tests for dry-run gates, orchestrator dry-run behavior, debug config defaults, and HTTPS enforcement.

---

## What Remains Disabled

All real paths remain off by default:

- `useMockBridge = true`
- `useMockApi = true`
- `useMockSupabase = true`
- `enableRealAnalyze = false`
- `enableRealConnectivity = false`
- `enableRealVoice = false`
- `enableRealCamera = false`
- `enableRealFaceMasking = false`
- `enableDryRun = false`

No ML Kit, no real camera, no BLE/Wi-Fi Direct, no SpeechRecognizer, no Supabase live client, no production face masking.

---

## Dry-Run Gate Matrix

`DryRunGateResult.Ready` is only returned when **all** of the following are true:

| # | Gate | Default | Required Value |
|---|------|---------|----------------|
| 1 | `BuildConfig.DEBUG` | `true` (debug) | `true` |
| 2 | `BetaConfig.useMockApi` | `true` | `false` |
| 3 | `BetaConfig.enableRealAnalyze` | `false` | `true` |
| 4 | `BetaConfig.enableRealFaceMasking` | `false` | `true` |
| 5 | `BetaConfig.enableDryRun` | `false` | `true` |
| 6 | `AnalyzeClientConfig.backendUrl` | `""` | non-empty |
| 7 | `DebugAnalyzeConfig.isPresent` | `false` | `true` (local URL supplied) |
| 8 | `BetaSafetyGuard.permitsRealAnalyzePreparation()` | — | `true` (debug + safe config) |
| 9 | Privacy sanitizer succeeded | — | `true` |

If any gate is false, the result is `ConfigBlocked(gate)` or `Blocked("sanitizer_failed")`. The mock path is still available when dry-run is disabled.

---

## `enableDryRun` Behavior

- `enableDryRun = false` (default): `ScanOrchestrator.run()` uses the injected `AnalyzeClient` (mock by default). No dry-run gate is evaluated.
- `enableDryRun = true` + all other gates true: `ScanOrchestrator.run()` returns `DryRunReady` after sanitizer success without calling the analyze client or constructing transport.
- `enableDryRun = true` + any other gate false: returns a safe `ConfigBlocked` or `DryRunBlocked` result. No network call is attempted.

`enableDryRun` alone does not enable anything; all BetaConfig gates and debug backend config must also be present.

---

## Debug-Only Config Model

Gradle reads optional properties from `local.properties` (gitignored) or project properties:

```properties
KSCAN_DEBUG_ANALYZE_URL=
KSCAN_DEBUG_ANALYZE_AUTH_TOKEN=
KSCAN_DEBUG_ANALYZE_DRY_RUN=false
```

Committed defaults in `app/build.gradle.kts` emit blank strings / `false` into `BuildConfig`:

```kotlin
val debugAnalyzeUrl = debugProperty("KSCAN_DEBUG_ANALYZE_URL")
val debugAnalyzeAuthToken = debugProperty("KSCAN_DEBUG_ANALYZE_AUTH_TOKEN")
val debugAnalyzeDryRun = debugPropertyBoolean("KSCAN_DEBUG_ANALYZE_DRY_RUN")
buildConfigField("String", "KSCAN_DEBUG_ANALYZE_URL", "\"$debugAnalyzeUrl\"")
buildConfigField("String", "KSCAN_DEBUG_ANALYZE_AUTH_TOKEN", "\"$debugAnalyzeAuthToken\"")
buildConfigField("boolean", "KSCAN_DEBUG_ANALYZE_DRY_RUN", "$debugAnalyzeDryRun")
```

Missing properties fall back safely to empty strings / `false`. `KSCAN_DEBUG_ANALYZE_AUTH_TOKEN` is never logged.

---

## INTERNET Permission Policy

Phase 3B performs zero network calls, so `android.permission.INTERNET` is unnecessary and is **not present** in:

- `android-xr/app/src/main/AndroidManifest.xml`
- any debug manifest overlay
- any release manifest overlay
- generated merged debug/release manifests

This permission will only be reconsidered in a future live backend smoke-test phase after an explicit security review.

---

## Dry-Run Behavior

- The dry-run gate is evaluated **after** sanitizer success.
- The dry-run gate **never** constructs `RealAnalyzeClient`.
- The dry-run gate **never** constructs `KscanHttpTransport`.
- The dry-run gate **never** sends payloads over network.
- The dry-run result contains **no payload hash, size, preview, or raw request body**.
- The dry-run result contains **no backend token**.
- Diagnostic gate names (e.g. `useMockApi`, `backend_url_missing`) are structural only and do not leak URLs or secrets.

---

## No Developer Hook Added

Phase 3B is validated through unit/integration tests only. No debug UI, debug menu, hidden HUD action, gesture trigger, D-pad shortcut, or projected developer panel was added. A manual live smoke-test trigger will be designed in a future phase with explicit UI/UX and safety review.

---

## Why No Live Backend Call Was Performed

Phase 3B is explicitly dry-run only. The goal is to prove gate evaluation, safe result mapping, and transport isolation. Live network execution is gated behind `enableDryRun=false`, `useMockApi=true`, `enableRealAnalyze=false`, `enableRealFaceMasking=false`, blank debug backend URL, and the missing `INTERNET` permission. A later phase will add the permission, enable one explicit smoke-test gate, and perform a single controlled backend call.

---

## Confirmations

### No secrets are committed

- No API keys, bearer tokens, Gemini keys, Supabase keys, or backend URLs are committed in Kotlin source.
- `KSCAN_DEBUG_ANALYZE_URL` and `KSCAN_DEBUG_ANALYZE_AUTH_TOKEN` default to blank in `BuildConfig`.
- `.env.example` contains only placeholder names.
- `local.properties` and `android-xr/debug-analyze.properties` are gitignored.

### Default debug APK remains mock-safe

- `USE_MOCK_API = true`
- `BetaConfig.useMockApi = true`
- `BetaConfig.enableRealAnalyze = false`
- `BetaConfig.enableRealFaceMasking = false`
- `BetaConfig.enableDryRun = false`
- `AnalyzeClientConfig.backendUrl = ""`
- `DebugAnalyzeConfig.isPresent = false`
- `android.permission.INTERNET` is absent

### Release builds cannot perform real analyze

- `BuildConfig.DEBUG` is the first dry-run gate.
- `AnalyzeClientFactory` also checks `BuildConfig.DEBUG` before constructing `RealAnalyzeClient`.
- `BetaSafetyGuard.permitsRealAnalyzePreparation()` returns `false` in release builds.

### `KscanHttpTransport` is not constructed under default config

Default config selects `MockAnalyzeClient`. `KscanHttpTransport` is only reachable inside the fully gated `AnalyzeClientFactory.create()` path, which requires explicit debug opt-in.

### Dry-run does not construct or call `KscanHttpTransport`

The dry-run gate is a pure function that returns `DryRunGateResult` without touching `AnalyzeClientFactory` or any transport implementation.

### Sibling repos untouched

- `C:\Users\jsmit\kscan-glasses-webapp` — not modified.
- `C:\Users\jsmit\KScan` (main mobile app) — not modified.
- Meta / MRBD Vercel demo repo — not modified.

---

## Test Coverage

Total tests: **116** (97 Phase 3A + 19 Phase 3B)

All tests pass in both debug and release unit-test variants.

| Test | Location |
|------|----------|
| Default BetaConfig has `enableDryRun=false` | `BetaConfigTest` |
| Real analyze preparation permitted only in debug | `BetaConfigTest` |
| Real analyze preparation denied for unsafe config | `BetaConfigTest` |
| All gates true returns `DryRunGateResult.Ready` | `AnalyzeDryRunGateTest` |
| Release build blocks dry-run | `AnalyzeDryRunGateTest` |
| `useMockApi=true` blocks dry-run | `AnalyzeDryRunGateTest` |
| `enableRealAnalyze=false` blocks dry-run | `AnalyzeDryRunGateTest` |
| `enableRealFaceMasking=false` blocks dry-run | `AnalyzeDryRunGateTest` |
| `enableDryRun=false` blocks dry-run | `AnalyzeDryRunGateTest` |
| Blank `backendUrl` blocks dry-run | `AnalyzeDryRunGateTest` |
| Missing debug backend config blocks dry-run | `AnalyzeDryRunGateTest` |
| Sanitizer failure blocks dry-run | `AnalyzeDryRunGateTest` |
| Default BetaConfig is not dry-run ready | `AnalyzeDryRunGateTest` |
| Dry-run ready does not call analyze client | `ScanOrchestratorDryRunTest` |
| Dry-run blocked when `useMockApi=true` | `ScanOrchestratorDryRunTest` |
| Dry-run blocked when `backendUrl` blank | `ScanOrchestratorDryRunTest` |
| Sanitizer failure prevents dry-run selection | `ScanOrchestratorDryRunTest` |
| Default config keeps mock path and ignores dry-run | `ScanOrchestratorDryRunTest` |
| Real analyze rejects non-HTTPS backend URL | `AnalyzeClientTest` |

---

## Files Changed

- `android-xr/app/build.gradle.kts` — debug-only `KSCAN_DEBUG_ANALYZE_*` BuildConfig fields; removed hardcoded `KSCAN_BACKEND_URL`
- `android-xr/app/src/main/java/com/kscan/glasses/config/BetaConfig.kt` — added `enableDryRun`
- `android-xr/app/src/main/java/com/kscan/glasses/config/BetaSafetyGuard.kt` — added `permitsRealAnalyzePreparation()`
- `android-xr/app/src/main/java/com/kscan/glasses/analyze/DebugAnalyzeConfig.kt` — new
- `android-xr/app/src/main/java/com/kscan/glasses/analyze/AnalyzeDryRunGate.kt` — new
- `android-xr/app/src/main/java/com/kscan/glasses/analyze/DryRunGateResult.kt` — new
- `android-xr/app/src/main/java/com/kscan/glasses/scan/ScanOrchestrator.kt` — dry-run integration and new result subtypes
- `android-xr/app/src/main/java/com/kscan/glasses/scan/ScanOrchestratorFactory.kt` — pass through `clientConfig` / `debugConfig`
- `android-xr/app/src/main/java/com/kscan/glasses/state/KScanViewModel.kt` — handle new dry-run result subtypes
- `android-xr/app/src/main/java/com/kscan/glasses/analyze/KscanHttpTransport.kt` — timeout/redirect/cache hardening
- `android-xr/app/src/main/java/com/kscan/glasses/analyze/RealAnalyzeClient.kt` — reject non-HTTPS URLs
- `.env.example` — replaced live URL with debug-only placeholders
- `.gitignore` — added `android-xr/debug-analyze.properties`
- `README.md` — updated env docs
- `docs/google/SETUP.md` — updated env docs
- `android-xr/app/src/test/java/com/kscan/glasses/analyze/AnalyzeDryRunGateTest.kt` — new
- `android-xr/app/src/test/java/com/kscan/glasses/scan/ScanOrchestratorDryRunTest.kt` — new
- `android-xr/app/src/test/java/com/kscan/glasses/config/BetaConfigTest.kt` — dry-run / prep gate tests
- `android-xr/app/src/test/java/com/kscan/glasses/analyze/AnalyzeClientTest.kt` — HTTPS enforcement test
- `docs/PHASE_3B_CONTROLLED_BACKEND_DEBUG_WIRING.md` — this report

---

## Build Results

- `./gradlew.bat :app:test` — **BUILD SUCCESSFUL**
- `./gradlew.bat :app:assembleDebug` — **BUILD SUCCESSFUL**
- `./gradlew.bat :app:assembleRelease` — **BUILD SUCCESSFUL**

---

## Next Recommended Phase

**Phase 3C — Controlled Live Backend Smoke Test (single call)**

Scope for a future phase:

1. Add `android.permission.INTERNET` to a **debug-only** manifest overlay or explicitly gated staging variant.
2. Supply one real staging backend URL + token locally (gitignored).
3. Enable all gates in a single controlled test run.
4. Verify one successful `RealAnalyzeClient.analyze()` call through `KscanHttpTransport`.
5. Confirm response parsing, error mapping, and HUD/session integration.
6. Validate no payload/token/response leakage.

Until then, Phase 3B remains the boundary: dry-run only, no network traffic, no `INTERNET` permission.
