# Phase 3D — Android Debug Network Enablement

## What Phase 3D Enabled

Phase 3D added the infrastructure required for future Android debug emulator/device smoke testing against the local backend debug endpoint, while keeping release builds completely isolated from the network.

### Changes Made

1. **Debug-only `INTERNET` permission** (`android-xr/app/src/debug/AndroidManifest.xml`)
   - Added only to the debug source set
   - Release and main builds remain without `INTERNET`

2. **Debug analyze enabled flag** (`android-xr/app/build.gradle.kts`)
   - Added `KSCAN_DEBUG_ANALYZE_ENABLED` BuildConfig field
   - Defaults to `false`
   - Read from gitignored `local.properties`

3. **Debug analyze config update** (`DebugAnalyzeConfig.kt`)
   - Added `enabled` field that checks both the BuildConfig flag and URL presence
   - `isPresent` now requires `enabled == true && backendUrl.isNotBlank()`

4. **Debug endpoint client factory** (`GlassesDebugEndpointClientFactory.kt`)
   - Centralized gate logic for creating `GlassesDebugEndpointClient`
   - Returns `MockAnalyzeClient` if any gate fails
   - Gates: `enableRealAnalyze`, `enableRealFaceMasking`, `debugConfig.enabled`, `backendUrl` non-empty

5. **Tests** (no emulator or real network required)
   - `DebugAnalyzeConfigTest.kt` — config default, enabled, URL blank, token safety
   - `GlassesDebugEndpointClientFactoryTest.kt` — all gate combinations
   - `GlassesDebugEndpointClientTest.kt` — success, error, malformed, network, timeout, 503, call count, payload leakage

## Why `INTERNET` Is Debug-Only

- Production release builds must never have `android.permission.INTERNET` in the main manifest.
- Debug builds need `INTERNET` only for local emulator/device testing against the debug backend endpoint.
- The debug manifest overlay is merged **only** into debug APKs by the Android Gradle Plugin.
- Release builds are unaffected.

## Why Release Still Has No Internet Permission

- `android-xr/app/src/main/AndroidManifest.xml` does **not** contain `INTERNET`.
- `android-xr/app/src/debug/AndroidManifest.xml` is the **only** source of the permission.
- Release builds use `src/main/` only, so the permission is absent.

## Required `local.properties` Keys

Add to `android-xr/local.properties` (gitignored):

```properties
# Debug analyze — disabled by default. Enable only for local smoke testing.
# URL/flags only. Do NOT put auth tokens in local.properties / BuildConfig.
KSCAN_DEBUG_ANALYZE_ENABLED=false
KSCAN_DEBUG_ANALYZE_URL=
KSCAN_DEBUG_ANALYZE_DRY_RUN=false
```

For local emulator testing later:

```properties
KSCAN_DEBUG_ANALYZE_ENABLED=true
KSCAN_DEBUG_ANALYZE_URL=http://10.0.2.2:3002/api/glasses/analyze-debug
KSCAN_DEBUG_ANALYZE_DRY_RUN=false
```

Supply the debug Bearer token at **runtime** (never BuildConfig):

```bash
adb shell "echo -n 'test-local-token' > /data/local/tmp/kscan_glasses_debug_token"
```

**Never commit actual token values.**

Debug builds include a loopback-only cleartext network-security config so
`http://10.0.2.2` and `http://127.0.0.1` work for local smoke. Release builds
do not permit cleartext.
## Emulator URL Guidance

From an Android emulator, the host machine is reachable at:

```
http://10.0.2.2:<port>/api/glasses/analyze-debug
```

Default backend port is `3002` (or `KSCAN_GLASSES_PORT`).

## Physical Device URL Guidance

- Use the LAN IP of the host machine running the backend server.
- Example: `http://192.168.1.42:3002/api/glasses/analyze-debug`
- The host firewall may need to allow inbound connections on the backend port.

## Local Backend Command Placeholder

Start the backend server (from repo root):

```bash
cd backend
KSCAN_GLASSES_ANALYZE_ENABLED=true \
KSCAN_GLASSES_ANALYZE_DEBUG_TOKEN=test-local-token \
KSCAN_GLASSES_ANALYZE_MODEL=mock-debug \
node server.js
```

## Android Smoke Command Placeholder

Build debug APK:

```bash
cd android-xr
./gradlew.bat :app:assembleDebug
```

Install on emulator/device:

```bash
adb install app/build/outputs/apk/debug/app-debug.apk
```

Run the disabled-by-default smoke test (JVM-side, no emulator needed):

```bash
./gradlew.bat :app:testDebugUnitTest \
  --tests "com.kscan.glasses.analyze.Phase3CLocalBackendSmokeTest"
```

## Safety Checklist Before Enabling

- [ ] Debug build only (`BuildConfig.DEBUG == true`)
- [ ] Local backend only (`10.0.2.2` or LAN IP)
- [ ] No production/staging endpoint in `KSCAN_DEBUG_ANALYZE_URL`
- [ ] Fake JPEG data URL only unless explicitly approved
- [ ] Token is local only, never committed
- [ ] `BetaConfig.enableRealAnalyze == true`
- [ ] `BetaConfig.enableRealFaceMasking == true`
- [ ] `KSCAN_DEBUG_ANALYZE_ENABLED == true`
- [ ] `KSCAN_DEBUG_ANALYZE_URL` is non-empty

## How to Run the Disabled-by-Default Test

The JVM-side smoke test is controlled by environment variables:

```bash
KSCAN_PHASE3C_LOCAL_SMOKE=true \
KSCAN_PHASE3C_BACKEND_URL=http://127.0.0.1:3002/api/glasses/analyze-debug \
KSCAN_PHASE3C_AUTH_TOKEN=test-local-token \
./gradlew.bat :app:testDebugUnitTest \
  --tests "com.kscan.glasses.analyze.Phase3CLocalBackendSmokeTest"
```

If the backend is not running, the test fails with a clear message.

## What Success Looks Like

- `GlassesDebugEndpointClientFactory.create(betaConfig, debugConfig)` returns `GlassesDebugEndpointClient` when all gates pass.
- `client.analyze(...)` returns `FashionAnalyzeResult` with `result`, `category`, `color`, `silhouette` populated.
- Response contains no `base64` or `data:image` strings.
- No payload, token, or raw response is logged.

## What Failure Looks Like

- Any gate failure returns `MockAnalyzeClient` instead of `GlassesDebugEndpointClient`.
- Missing backend returns `AnalyzeException.Network` with a safe message.
- Bad token returns `AnalyzeException.HttpError(401, "UNAUTHORIZED: ...")`.
- Backend disabled returns `AnalyzeException.HttpError(503, "CONFIG_DISABLED: ...")`.

## How to Roll Back

1. Set `KSCAN_DEBUG_ANALYZE_ENABLED=false` in `local.properties`.
2. Remove `KSCAN_DEBUG_ANALYZE_URL` and `KSCAN_DEBUG_ANALYZE_AUTH_TOKEN` from `local.properties`.
3. Rebuild debug APK.
4. Release builds are unaffected at all times.

## Confirmations

| Check | Status |
|-------|--------|
| No emulator used in Phase 3D | ✅ |
| No real glasses hardware used | ✅ |
| No production/staging backend called | ✅ |
| No external model/API called | ✅ |
| Android `INTERNET` permission added only to debug | ✅ |
| Release/main manifest has no `INTERNET` | ✅ |
| `MockAnalyzeClient` remains default | ✅ |
| Debug analyze remains disabled by default | ✅ |
| No payload/token/raw response logging in production code | ✅ |
| No secrets committed | ✅ |
| `local.properties` is gitignored | ✅ |

## Next Recommended Phase

**Phase 4 — Emulator Debug Network Smoke** (when emulator environment is ready)

Or **Phase 5 — Real Glasses Hardware Integration** (when hardware is available).

Before Phase 4:
1. Ensure Android Studio / emulator environment is ready.
2. Start local backend server.
3. Set `KSCAN_DEBUG_ANALYZE_ENABLED=true` and `KSCAN_DEBUG_ANALYZE_URL=http://10.0.2.2:3002/api/glasses/analyze-debug` in `local.properties`.
4. Build and install debug APK on emulator.
5. Trigger a scan and verify the HUD-safe response.
