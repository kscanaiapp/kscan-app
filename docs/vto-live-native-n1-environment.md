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

## Local machine setup required for a from-scratch local Gradle build

Two gaps found only by actually attempting `./gradlew :app:assembleDebug` end to end (neither is visible from a tool-presence precheck):

1. **`android/app/debug.keystore` missing.** Deliberately gitignored (`.gitignore:41`) and never committed (git history shows an explicit "Initial K Scan app import without secrets" policy) -- every machine generates its own. Zero security relevance: Android's debug-signing convention is a single, universally-standard keystore (alias `androiddebugkey`, password `android`) used identically across every Android developer machine, since a debug-signed artifact can never reach a store. Generated locally with:
   ```
   keytool -genkeypair -v -storetype PKCS12 -keystore android/app/debug.keystore \
     -alias androiddebugkey -keyalg RSA -keysize 2048 -validity 10000 \
     -storepass android -keypass android -dname "CN=Android Debug,O=Android,C=US"
   ```
2. See the defect ledger (N1-ENV-003) for the manifest-comment XML defect that blocked the build before this.

Both point the same direction: **this appears to be the first fully-local, from-scratch `./gradlew assembleDebug` run of this project on this toolchain** -- prior verification in the memory trail is consistently EAS-cloud-build-shaped, never a raw local Gradle build reaching final packaging.

## Local test-build configuration (not committed)

N1's own local verification builds use a gitignored `.env.local` (confirmed via `git check-ignore`) rather than any eas.json edit:

```
EXPO_PUBLIC_SUPABASE_URL=<staging>
EXPO_PUBLIC_SUPABASE_ANON_KEY=<staging anon key, already public in eas.json's staging block>
EXPO_PUBLIC_DEV_INITIAL_ROUTE=/dev-n1-diagnostic
```

Deliberately targets **staging**, never production, for any N1 local test build. `EXPO_PUBLIC_DEV_INITIAL_ROUTE` is the app's own pre-existing, `__DEV__`-gated, EAS-profile-absent QA harness (`constants/featureFlags.ts`) -- reused as-is, not a new mechanism.

## Device authority for N1-B / N1-C / N1-D (amendment D19)

| Class | Status |
|---|---|
| `PHYSICAL_DEVICE` | **NOT AVAILABLE.** `adb devices -l` empty throughout. |
| `EMULATOR` | USED. `Pixel_8_Pro` / `sdk_gphone16k_x86_64`, x86_64. |
| `CI` | Not used for N1 runtime evidence. |
| `EAS_BUILD` | Not used for N1-D. Local Gradle is the compile authority. |

Physical-device runtime authority remains PRIMARY and remains unsatisfied.
The mandatory N1-B physical-device screenshot (amendment D2) is
**OUTSTANDING** and is the single reason N1-B is not fully closed.

Two independent blockers on emulator visual capture, recorded so a later
session does not repeat the attempt:

1. **Auth routing guard.** The `__DEV__` diagnostic route is pushed only
   after the auth gate settles to `allow` (`app/_layout.tsx`), and the
   emulator has no authenticated session. Deep-linking `kscan://dev-n1-diagnostic`
   mounts the route long enough for its native views to load and compute
   (their logs are captured), then the guard redirects to onboarding. The
   guard is behaving correctly and was deliberately NOT weakened — it is a
   security surface, and defeating it to obtain evidence would be a worse
   outcome than the missing screenshot.
2. **Emulator storage.** `/data` sits at 88–90% full. The dual-ABI
   (x86_64 + arm64-v8a) APK fails to install with
   `INSTALL_FAILED_INSUFFICIENT_STORAGE`; an x86_64-only build installs.
   The dual-ABI artifact is the one that matters for a physical device.

**What was captured on device instead**, and it is not nothing: the app
computes the same geometry numbers off-device conformance measured
(`evidence/vto-live-native-n1/n1bd-device-runtime.json`), and the native
replay clock runs the full 121-frame source to EOF with
`produced=121, rendered=0, dropped=120, maxSlotDepth=1` — the renderer was
absent for the entire run and the producer neither stalled nor accumulated
a backlog.

## APK provenance (amendment D22)

| | |
|---|---|
| Source SHA | `171739e39d618b1d84e11b0ee462066f4d7a1437` |
| Contains | N1-A, N1-B, N1-C, N1-D |
| Build | `./gradlew :app:assembleDebug -PreactNativeArchitectures=x86_64,arm64-v8a` |
| Artifact | `android/app/build/outputs/apk/debug/app-debug.apk` |
| Size | 207,372,047 bytes |
| sha256 | `79d224a6e21b328dfaa71cf233b44999a3d6c31f4efe9d255b92b2b0ae2dde7c` |
| versionCode / version | 23 / 1.0.1 |
| Installed on physical device | **NO — no device attached** |
| Installed on emulator | YES (x86_64-only variant; see storage note above) |

The APK is not committed (binary, 200MB, gitignored build output). Rebuild
it from the SHA above with the exact command given.

## EAS continuity (amendment D21)

| | |
|---|---|
| EAS auth | Authenticated, orgs `ams2dad` + `k-scan` (both Owner) |
| Android `development` profile | present; `developmentClient: false`, `distribution: internal`, `buildType: apk` |
| N1-E checkpoint build available | YES — the profile exists and auth is live; no EAS build was run in this lane |

Two carried decisions, unchanged and still owed before N1-E leans on EAS:
`development` sets `developmentClient: false` (so it produces a debug-flavoured
internal APK, not an Expo Dev Client), and its Supabase target is
**production**, same as `preview`/`production` — only `staging` and
`staging-certification` point at staging. Neither was altered here.
