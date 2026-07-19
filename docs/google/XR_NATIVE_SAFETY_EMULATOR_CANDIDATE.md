# XR Native Safety Emulator Candidate — Build & Test Provenance

QA candidate record for the Google / Android XR glasses app on the
`build/google-xr-native-safety-emulator-candidate` branch. No machine secrets;
local SDK paths are intentionally genericized.

## Build provenance

| Field | Value |
|---|---|
| Workspace | `C:\Users\jsmit\kscan-google-glasses-canonical` |
| Branch | `build/google-xr-native-safety-emulator-candidate` |
| Commit (built from) | `715b5d7` (`test(glasses): expand safety privacy and contract coverage`) |
| Build type | debug (`:app:assembleDebug`) |
| Package (applicationId) | `com.kscan.glasses` |
| versionName | `0.1.0-alpha` |
| versionCode | `1` |
| minSdk (dexing) | 26 |
| Original Gradle APK | `android-xr/app/build/outputs/apk/debug/app-debug.apk` |
| QA copy | `artifacts/google-xr-native-safety-emulator/KScan-Google-XR-native-safety-emulator-qa.apk` |
| File size | 9,079,483 bytes (~8.66 MB) |
| SHA-256 (both files, verified identical) | `85499bd1b07787d4d2e1d81d7bbdce0da52298b040456fb042d8d6dfb5d5695c` |
| Build date | 2026-07-18 17:17:34 -0400 (APK output timestamp) |
| Java | OpenJDK 21.0.10 (Microsoft build 21.0.10+7-LTS) |
| Gradle | 8.7 (wrapper) |
| Signing | default Android debug signing (no release keystore; `*.keystore` gitignored) |

Metadata source: `android-xr/app/build/outputs/apk/debug/output-metadata.json`.
The APK is **not** committed; `artifacts/` is gitignored.

## Validation at build commit

| Suite | Command | Total | Passed | Failed | Skipped | Duration |
|---|---|---|---|---|---|---|
| Android unit | `./gradlew.bat :app:testDebugUnitTest` (JAVA_HOME = Microsoft JDK 21) | 254 | 254 | 0 | 0 | BUILD SUCCESSFUL in 31 s (`--rerun-tasks`) |
| Root contract | `npm.cmd test` (repo root) | 25 | 25 | 0 | 0 | ~246 ms |
| Phone bridge | `npm.cmd test` (`phone-bridge/`) | 5 | 5 | 0 | 0 | ~154 ms |
| Backend | `npm.cmd test` (`backend/`) | 20 | 20 | 0 | 0 | ~90 ms |

## Candidate scope (A–H workstreams)

- Release mock safety, explicit fail-closed sanitizer selection, legacy analyze
  bypass removal, bounded JPEG re-encode boundary, debug analyze JSON contract.
- Hardened logging (`SafeLog` only, no console/stack-trace fallback, throwable
  class-name only, expanded payload markers) and stable `ScanErrorCode` set.
- True-black HUD root, honest XR controls (Escape→Back, docs match
  `InputMapper`), full D-pad coverage on Scan/Results/Settings.
- Minimal permission surface: main manifest declares **zero permissions**;
  `INTERNET` exists only in the debug overlay (`docs/google/PERMISSION_MATRIX.md`).

## Dry-run gate semantics (important)

`AnalyzeDryRunGate` proves **configuration readiness only**: it constructs no
network transport, performs no request, exposes no token, and logs no payload.
`DryRunGateResult.Ready` means "all configuration gates passed" — it is **not**
end-to-end live readiness:

- The image privacy stage has **not** genuinely run: on-device face masking is
  not implemented in this build, and `StrictPrivacyImageSanitizer` fails closed
  (`MaskingUnavailable`) before anything can upload.
- A dry-run-ready result reached via the mock sanitizer is labeled
  "Dry-run gate ready (config only)" in the UI and MOCK-labeled by the runtime
  status header.

Gate coverage (all fail closed independently; see `AnalyzeDryRunGateTest`,
`ScanOrchestratorDryRunTest`, `KScanViewModelTest`): `release_build`,
`useMockApi`, `enableRealAnalyze`, `enableRealFaceMasking`, `enableDryRun`,
`backend_url_missing`, `debug_backend_config_missing` (blank URL **or**
explicitly disabled), `safety_guard`, sanitizer blocked, sanitizer error, plus
the positive all-gates-true case and a no-token/no-URL/no-payload label
invariant.

## Manual verification still owed

- Emulator visual pass at 600×600 (HUD clutter, focus highlight, true-black).
- Hardware key handling on device (D-pad, Escape, camera key).
- Camera phase must re-add `CAMERA` with a runtime permission flow.
