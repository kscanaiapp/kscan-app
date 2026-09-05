# Live VTO Native Runtime N1 — Environment

Precheck run 2026-09-05, Windows 11, this machine. Re-verify before trusting on a different machine.

## Toolchain

| Tool | Result |
|---|---|
| Java | JDK 21.0.10.7 (Microsoft build), `JAVA_HOME` set |
| Gradle CLI | Not on PATH -- not required; `android/gradlew` (wrapper) is committed and works |
| Node / npm | Present |
| Android SDK | Present at `C:\Users\jsmit\AppData\Local\Android\Sdk` -- `emulator`, `platforms` (3), `build-tools` (5), `platform-tools` (15) all present |
| `ANDROID_HOME` / `ANDROID_SDK_ROOT` | Unset in the shell env. Worked around via `android/local.properties` (`sdk.dir=...`), which is the standard machine-local, gitignored mechanism -- no env var needed for Gradle. |
| AVDs | 4 present, incl. `Pixel_8_Pro` (used for N1) and `XR_Glasses` (unrelated project) |
| adb | Present, functional |
| Google Maven / dl.google.com | Reachable (301/302) |
| EAS CLI | `eas-cli@23.2.0` (update available, not yet taken) |
| EAS auth | Authenticated as justin.landes@gmail.com, orgs `ams2dad` + `k-scan` (both Owner) |
| gh CLI | Present, authenticated |

**Local Gradle compile authority: CONFIRMED WORKING**, not just "available." `./gradlew projects` and `./gradlew :app:assembleDebug` both run against the real local Android SDK (no EAS needed for N1-A). EAS remains available as the milestone-checkpoint compile authority per amendment B5 (batched, not per-commit) and as the eventual installable-APK producer for N1-G.

## Compile authority evidence (N1-A)

`./gradlew projects` -- BUILD SUCCESSFUL in 2m24s (first run, cold Gradle daemon). Project graph includes the new module:

```
Root project 'K Scan'
+--- Project ':app'
+--- Project ':expo'
+--- Project ':kscan-live-vto-native'   <-- new, autolinked, no manual settings.gradle edit
+--- Project ':kscan-voice-native'
...
```

Resolved build config: compileSdk 36, minSdk 24, targetSdk 36, buildTools 36.0.0, NDK 27.1.12297006, Kotlin 2.1.20, KSP 2.1.20-2.0.1, New Architecture **enabled** (`android/gradle.properties` `newArchEnabled=true`).

## Device operational model (amendment B7)

**LOCAL SESSION WITH DEVICE ATTACHED** for the emulator: this session runs `adb`/`emulator` directly against the local SDK. `Pixel_8_Pro` AVD booted locally (`adb wait-for-device` + `sys.boot_completed` confirmed) and is used for N1-A/B/C/D evidence.

**Physical device: PENDING OWNER CONNECTION.** No physical Android device was attached at any point in this session (`adb devices -l` empty before the emulator was started). Per B7, the device should be requested at N1-E start (perception is the first gate the emulator cannot honestly evidence), not deferred to N1-F.

## Per-profile Live flag matrix (amendment B1)

| Profile | `EXPO_PUBLIC_LIVE_VTO_ENABLED` | Supabase target |
|---|---|---|
| development | **absent** (see below -- not added) | production (`wyyuqfdxucjksghsmhry`) |
| preview | absent | production |
| staging | absent | staging (`yzqjvdfgefveprobvvyw`) |
| staging-certification | absent | staging |
| production | absent | production |

**B1's dev-profile carve-out was NOT applied to `eas.json`.** `__tests__/vtoLiveFeatureGate.test.js` ("flag: no EAS profile sets it -- production and staging included") already asserts, for every profile in `eas.json` with no exception, that `EXPO_PUBLIC_LIVE_VTO_ENABLED` and `EXPO_PUBLIC_LIVE_VTO_HARNESS` are absent. That test is real, currently green, and part of the already-merged, hostile-audited P3-C contract. Per amendment B3 ("if scaffold and merged contract diverge, the merged contract governs, record the divergence"), the merged test governs over B1's instruction. Full reasoning and the local workaround used instead: see the defect ledger, N1-ENV-001.

Also worth a decision before N1-G regardless of the above: `development`'s `developmentClient` is currently `false` (builds a debug-flavored internal APK, not an actual Expo Dev Client) and its Supabase target is **production**, same as `preview`/`production` -- only `staging`/`staging-certification` point at staging.

## Local test-build configuration (not committed)

N1's own local verification builds use a gitignored `.env.local` (confirmed via `git check-ignore`) rather than any eas.json edit:

```
EXPO_PUBLIC_SUPABASE_URL=<staging>
EXPO_PUBLIC_SUPABASE_ANON_KEY=<staging anon key, already public in eas.json's staging block>
EXPO_PUBLIC_DEV_INITIAL_ROUTE=/dev-n1-diagnostic
```

Deliberately targets **staging**, never production, for any N1 local test build. `EXPO_PUBLIC_DEV_INITIAL_ROUTE` is the app's own pre-existing, `__DEV__`-gated, EAS-profile-absent QA harness (`constants/featureFlags.ts`) -- reused as-is, not a new mechanism.
