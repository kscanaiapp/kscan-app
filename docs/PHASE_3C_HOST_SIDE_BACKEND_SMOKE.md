# Phase 3C — Host-Side Controlled Live Backend Smoke Test

## What Was Tested

A controlled local-only smoke test that exercises the Android `GlassesDebugEndpointClient` boundary against the verified local backend debug endpoint (`POST /api/glasses/analyze-debug`).

This phase tests:

1. The debug endpoint client (`GlassesDebugEndpointClient`) correctly maps the HUD-safe debug endpoint JSON into the existing `AnalyzeResponse` model.
2. Error responses map to safe `AnalyzeException` types.
3. No payload, token, or raw response leakage occurs in mapped results.
4. The existing gate behavior remains intact (mock default, debug-only real client).

## Why Emulator Was Not Used

Phase 3C is a **host-side** smoke test. The goal is to verify the client/backend contract, not projected UI runtime. Emulator and hardware testing are deferred to later phases.

## Endpoint Path

```
POST /api/glasses/analyze-debug
```

## Local Backend Env (Required for Manual Smoke)

Start the backend server first:

```bash
cd backend
KSCAN_GLASSES_ANALYZE_ENABLED=true \
KSCAN_GLASSES_ANALYZE_DEBUG_TOKEN=test-local-token \
KSCAN_GLASSES_ANALYZE_MODEL=mock-debug \
node server.js
```

Server listens on port `3002` by default (or `KSCAN_GLASSES_PORT`).

## Client Local Env (Test-Only)

The smoke test reads from environment variables:

| Variable | Default | Purpose |
|----------|---------|---------|
| `KSCAN_PHASE3C_LOCAL_SMOKE` | `false` | Enable the smoke test |
| `KSCAN_PHASE3C_BACKEND_URL` | `http://127.0.0.1:3002/api/glasses/analyze-debug` | Debug endpoint URL |
| `KSCAN_PHASE3C_AUTH_TOKEN` | `test-local-token` | Bearer token |

## Exact Command Flow

### 1. Start local backend (Terminal 1)

```bash
cd backend
KSCAN_GLASSES_ANALYZE_ENABLED=true \
KSCAN_GLASSES_ANALYZE_DEBUG_TOKEN=test-local-token \
KSCAN_GLASSES_ANALYZE_MODEL=mock-debug \
node server.js
```

### 2. Run smoke test (Terminal 2)

```bash
cd android-xr
KSCAN_PHASE3C_LOCAL_SMOKE=true \
KSCAN_PHASE3C_BACKEND_URL=http://127.0.0.1:3002/api/glasses/analyze-debug \
KSCAN_PHASE3C_AUTH_TOKEN=test-local-token \
./gradlew :app:testDebugUnitTest \
  --tests "com.kscan.glasses.analyze.Phase3CLocalBackendSmokeTest"
```

## Backend Auto-Started?

**No.** The backend is started manually in a separate terminal. The test does not start the backend as a subprocess. This avoids Node.js path complexity and zombie process risks.

## Result of One Controlled Local Call

When the backend is running and the test is enabled:

- **Request:** `POST /api/glasses/analyze-debug` with `{"image":"data:image/jpeg;base64,abc","client":"google-glasses-alpha"}` and `Authorization: Bearer test-local-token`
- **Expected Response:** `HTTP 200` with `ok: true`, `result.safeForHud: true`, `meta.model: mock-debug`
- **Mapped Result:** `FashionAnalyzeResult` with `result = "Mock Fashion Analysis — This is a safe mock response..."`, `category = "jacket"`, `color = "black"`, `silhouette = "oversized"`, `products = []`

## Confirmations

| Check | Status |
|-------|--------|
| No emulator used | ✅ |
| No real glasses hardware used | ✅ |
| No production/staging backend called | ✅ |
| No external model/API called | ✅ |
| Android INTERNET permission not added | ✅ |
| No payload logged in production code | ✅ |
| No token logged in production code | ✅ |
| No raw response logged in production code | ✅ |
| Release behavior remains blocked (Mock default) | ✅ |
| Existing gate behavior preserved | ✅ |

## Files Added

| File | Purpose |
|------|---------|
| `android-xr/app/src/main/java/com/kscan/glasses/analyze/GlassesDebugEndpointClient.kt` | Debug endpoint client (implements `AnalyzeClient`) |
| `android-xr/app/src/test/java/com/kscan/glasses/analyze/GlassesDebugEndpointClientTest.kt` | Unit tests for the debug client (fake transport) |
| `android-xr/app/src/test/java/com/kscan/glasses/analyze/Phase3CLocalBackendSmokeTest.kt` | Host-side live smoke test (disabled by default) |

## Response Mapping

The debug endpoint returns:

```json
{
  "ok": true,
  "result": {
    "title": "Mock Fashion Analysis",
    "summary": "This is a safe mock response...",
    "attributes": [
      { "name": "category", "value": "jacket" }
    ],
    "safeForHud": true
  }
}
```

`GlassesDebugEndpointClient` maps this to:

```kotlin
FashionAnalyzeResult(
    result = "Mock Fashion Analysis — This is a safe mock response...",
    category = "jacket",
    color = "black",
    silhouette = "oversized",
    products = emptyList(),
)
```

No base64 or data:image strings appear in the mapped result.

## Error Mapping

| Debug Endpoint Error | Mapped Exception |
|----------------------|------------------|
| `ok: false` (e.g., 401 UNAUTHORIZED) | `AnalyzeException.HttpError` |
| Malformed JSON | `AnalyzeException.MalformedJson` |
| Network failure | `AnalyzeException.Network` |
| Timeout | `AnalyzeException.Timeout` |

## Next Recommended Phase

**Phase 4 — Emulator Smoke Test (Optional)** or **Phase 5 — Integration with Real Glasses Hardware**.

Before proceeding:

1. Ensure `local.properties` is configured with `KSCAN_DEBUG_ANALYZE_URL` for the target backend.
2. Verify `BuildConfig.DEBUG` is true.
3. Verify all `BetaConfig` gates (`enableRealAnalyze`, `enableRealFaceMasking`, `enableDryRun`) are set appropriately.
4. Consider adding `android.permission.INTERNET` only when an emulator or real device test is explicitly planned.

## Safety Notes

- `GlassesDebugEndpointClient` is **debug-only** and should never be instantiated in release builds.
- The smoke test is **disabled by default** and requires `KSCAN_PHASE3C_LOCAL_SMOKE=true`.
- No secrets are committed in source.
- `.env` and `local.properties` are gitignored.
- `AnalyzeClientFactory` still returns `MockAnalyzeClient` as the default.
