# 01 — Build Report Reconciliation

**Workspace:** `C:\Users\jsmit\kscan-google-glasses-canonical`  
**Audit branch:** `audit/google-xr-postbuild-integration-repair-20260719`  
**Starting HEAD (builder candidate):** `d636ad8503d98f06f5bab4b4268cb1528bc232e8`  
**Original baseline:** `497c583f9ca68ede1703c1199c16470a758afa74` (`feature/glasses-xr-native-standalone`)  
**Date:** 2026-07-19

## Preflight (Phase 0)

| Item | Value |
|------|-------|
| Workspace | Canonical confirmed |
| Deprecated sibling refs in *active* source | Absent (docs/qa historical mentions remain) |
| JDK | OpenJDK 21.0.10 (Microsoft), `JAVA_HOME` set |
| Gradle wrapper | 8.7 (JVM 21.0.10) — wrapper used, not system Gradle |
| Node / npm | v24.14.0 / 11.9.0 |
| Android SDK | `C:\Users\jsmit\AppData\Local\Android\Sdk` |
| adb | 1.0.41 (37.0.0-14910828) |
| Emulator AVDs | `XR_Glasses`, `Pixel_8_Pro` |
| Package ID | `com.kscan.glasses` |

Builder commits since baseline (12): `09787e8` … `d636ad8` on `build/google-xr-native-safety-emulator-candidate`.

## Reconciliation table

| Builder claim | Evidence inspected | Verified / Partially verified / False | Repair made | Remaining gate |
| ------------- | ------------------ | ------------------------------------- | ----------- | -------------- |
| Canonical workspace used | Path + git root | **Verified** | — | — |
| JDK 21 used by Gradle | `gradlew -version` → JVM 21.0.10 | **Verified** | — | — |
| Gradle wrapper 8.7 | `gradle-wrapper.properties` + `gradlew -version` | **Verified** | — | — |
| Implementation branch created | `build/google-xr-native-safety-emulator-candidate` @ `d636ad8` | **Verified** | Audit branch created from it | — |
| `npm ci` / lockfile-consistent node_modules | `node_modules` present; lockfiles clean in git status | **Partially verified** (modules present; `npm ci` not re-run this session) | — | Re-run `npm ci` in CI |
| Pre-change / final suites green | Independent reruns below | **Verified** for current tree | Added regressions | Emulator UI |
| Android unit tests ~254 | XML after repair: **264** passed / 0 failed / 0 skipped | **Partially verified** (count grew with builder + audit tests) | +credential/bridge/JSON tests | — |
| Root `npm test` green | **27** pass / 0 fail | **Verified** | +permission cleartext tests | — |
| Phone-bridge tests green | **5** pass / 0 fail | **Verified** | — | — |
| Backend tests green | **21** pass / 0 fail | **Verified** | +toBareBase64 / disabled service | — |
| Lint + assembleDebug | `lintDebug` + `assembleDebug` BUILD SUCCESSFUL | **Verified** | — | — |
| Runtime wiring connected | Source trace via AppRuntimeFactory | **Partially verified** — mock path connected; live debug path was auth-broken | Runtime credential provider + token gate + cleartext NSC | Face masking; HW capture |
| Face masking implemented | `FaceMasker` NotImplemented | **False** as “complete”; correctly fail-closed | None (intentional) | ML Kit / detector |
| Debug backend smoke ready | Docs claimed local.properties token | **False** — token never reached runtime | Credential provider + docs | Emulator install |
| Emulator candidate verified | XR AVD boots adb but `system_server`/package never ready | **False** for install/UI | Documented environmental gate | Fix/restart XR AVD image |
| No secrets in BuildConfig | `BuildConfigSecretPolicyTest` + aapt string scan | **Verified** | Kept fail-closed | — |
| Release mock safety | `ReleaseSafetyGuard` flag + instance checks + tests | **Verified** | — | Release signing |

## Independent validation counts (post-repair)

| Suite | Command | Passed | Failed | Skipped | Not run |
|-------|---------|--------|--------|---------|---------|
| Root contract | `npm test` | 27 | 0 | 0 | 0 |
| Phone bridge | `npm run test:phone-bridge` | 5 | 0 | 0 | 0 |
| Backend | `npm test --prefix backend` | 21 | 0 | 0 | 0 |
| Android unit | `./gradlew :app:testDebugUnitTest --rerun-tasks` | 264 | 0 | 0 | 0 |
| Lint | `./gradlew :app:lintDebug` | BUILD SUCCESSFUL | — | — | — |
| Assemble debug | `./gradlew :app:assembleDebug` | BUILD SUCCESSFUL | — | — | — |
| Instrumented / emulator UI | install + flows | — | — | — | **Blocked** (package service) |
| Controlled live upstream | HTTPS `/api/analyze` with real auth | — | — | — | **Not run** (external auth gate) |
