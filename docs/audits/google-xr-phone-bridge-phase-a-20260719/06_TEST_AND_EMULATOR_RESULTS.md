# 06 — Test and Emulator Results

## Android unit tests (XML aggregates)

| Variant | Tests | Failures | Errors | Skipped | Files |
|---|---:|---:|---:|---:|---:|
| Debug | **397** | 0 | 0 | 0 | 39 |
| Release | **397** | 0 | 0 | 0 | 39 |

Builder claim of 390 is outdated after audit repairs (+7 tests).

No `@Ignore` / `@Disabled` / `assumeTrue` in Android or Node bridge suites.

### AnalyzeClientFactoryTest (`aceb107`)

Legitimate variant scoping + new release fail-closed assertions. Not a concealment.

## Node suites

| Command | Passed | Failed | Skipped |
|---|---:|---:|---:|
| `npm test` | 27 | 0 | 0 |
| `npm run test:phone-bridge` | 5 | 0 | 0 |
| `node --test backend/tests/*.test.js` | 21 | 0 | 0 |

Note: root/phone-bridge TS “bridge-contract” suites validate Phase-1 `shared/bridge.schema.json`, **not** Kotlin v1. Phase A proof is the Gradle suite.

## Lint / assemble

- `:app:lintDebug` — success; warnings: ExifInterface, OldTargetApi, GradleDependency×N, Compose modifierParameter, ExportedReceiver (debug scenario). Classified **pre-existing / P3**.
- `:app:assembleDebug` — success.

## Emulators

### Pixel_8_Pro — `emulator-5554`

| Field | Value |
|---|---|
| Product | `sdk_gphone16k_x86_64` |
| AVD | `Pixel_8_Pro` |
| API | 37 |
| `sys.boot_completed` | 1 |
| `service check package` | found |
| `service check activity` | found |
| Install | Success |
| Cold/warm launch | Success |
| Keys | D-pad / Back / Escape / C exercised |
| FATAL/ANR | None observed in sampled logcat |

### XR_Glasses — `emulator-5556`

| Field | Value |
|---|---|
| Product | `gms_sdk_xr64_x86_64` |
| Model | Android XR SDK built for x86_64 |
| API | 34 |
| ABI | x86_64 |
| Boot | Cold boot succeeded (~3 min) |
| `service check package/activity` | **found** (builder environmental-gate claim not standing) |
| Install | Success after uninstall+reinstall |
| Process | `pidof com.kscan.glasses` returned live PID |
| Cold start (earlier `-W`) | Status ok, TotalTime ~43s |
| Tooling note | Some `adb logcat -d` / `dumpsys` calls hang — environmental |

### Benchmarks

Builder multi-loop timing benchmarks were **not** re-executed as wall-clock claims. Deterministic unit/integration coverage of pair→scan→save→ack→confirm→Ready and failure paths was independently executed in JVM tests. Timing sub-second claims are **not** asserted here.

## Artifact (debug APK rebuilt during audit)

| Field | Value |
|---|---|
| Path | `android-xr/app/build/outputs/apk/debug/app-debug.apk` |
| Size | 9,234,889 bytes |
| SHA-256 | `E5A349B5E32219E95655C2376E3455E72FB25615F8A37CBFF5A5ECCB42CA1FD4` |
| Package | `com.kscan.glasses` |
| versionName | `0.1.0-alpha` |
| versionCode | 1 |
| minSdk | 26 |
| targetSdk | 34 |
| Permissions | `INTERNET` (debug overlay); dynamic receiver not-exported permission |
| Signing | Debug |
| `KSCAN_DEBUG_MOCK_PHONE_BRIDGE` | **false** (debug + release BuildConfig) |
| Scenario receiver | Debug source-set only |
