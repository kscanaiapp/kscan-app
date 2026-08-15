# K Scan AI — Build 29 Android Final Repair

Repair date: 2026-08-15

Branch: `repair/build29-android-final`

Base shared authority: `17124d51ed301f84a7fe4061b079c90987931e0b` (tree `66178e9cc6942552b4c051e8d0457f2615221419`)

Behavioural reference only: `integration/android-build28-final-v1` @ `42829f54d21af5bd720f15c028c92e1bd9c1cf54`

## 1. Verdict

The Android-specific Build 29 native configuration is repaired at the authoritative config
layer, not in generated output. `expo prebuild --platform android` now regenerates
`AndroidManifest.xml` byte-identically from `app.json` plus two K Scan config plugins, so
the repairs survive the regeneration that caused the original loss.

Production was not contacted or mutated. Staging was not mutated. No EAS build was run.

## 2. Root cause

Build 29 regenerated `android/` from Expo prebuild. The regeneration itself was faithful;
what it lost was everything that had only ever existed as a hand edit in generated output,
plus two config plugins that did not survive the promotion. The certified Build 28 release
had encoded its Play-compliance decisions in both places, so the loss was silent.

The Android dependency graph is identical to the certified Build 28 graph apart from
`@sentry/react-native` and `expo-secure-store`. Every Build 28 removal was therefore still
required, and `expo-secure-store` added one new exposure of its own.

## 3. Evidence from the shipped artifact

The Build 29 release APK installed on the emulator (`versionCode=29`, `versionName=1.0.1`,
`targetSdk=36`, no `DEBUGGABLE` flag) was pulled and its merged manifest dumped. It ships:

```text
uses-permission: android.permission.FOREGROUND_SERVICE
uses-permission: android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK
uses-permission: android.permission.USE_BIOMETRIC
uses-permission: android.permission.USE_FINGERPRINT
service expo.modules.audio.service.AudioControlsService     foregroundServiceType=0x2   mediaPlayback
service expo.modules.audio.service.AudioRecordingService    foregroundServiceType=0x80  microphone
service expo.modules.location.services.LocationTaskService  foregroundServiceType=0x8   location
```

K Scan starts no foreground service and never reaches a biometric prompt. The three
services arrive from `expo-audio` and `expo-location` library manifests; the biometric
permissions arrive from `androidx.biometric:biometric:1.1.0`, declared `api` by
`expo-secure-store`.

`ACCESS_LOCAL_NETWORK` appears in `dumpsys package` but not in the artifact's own manifest:
the platform adds it implicitly on Android 16, so there is nothing to remove.
`ACCESS_NETWORK_STATE` and `MODIFY_AUDIO_SETTINGS` are normal permissions with real
consumers and are retained.

## 4. Repair ledger

| ID | Severity | Surface | Finding | Disposition |
| --- | --- | --- | --- | --- |
| AND-PERM-001 | P1 | Native manifest | 25 permission tombstones and 3 foreground-service removals lost; merged artifact declares FGS permissions and three typed foreground services | FIXED_AND_VERIFIED |
| AND-PERM-002 | P1 | Native manifest | `USE_BIOMETRIC` / `USE_FINGERPRINT` reach the artifact via `androidx.biometric`; unreachable because no SecureStore call passes `requireAuthentication` | FIXED_AND_VERIFIED |
| AND-ICON-001 | P2 | Launcher | Adaptive icon descriptors and layers deleted **and** `.gitignore`d; EAS builds the committed tree, so the artifact shipped no adaptive icon | FIXED_AND_VERIFIED |
| AND-ICON-002 | P2 | Launcher | `adaptiveIcon.monochromeImage` dropped from `app.json`; no themed icon on Android 13+ | FIXED_AND_VERIFIED |
| AND-ICON-003 | P2 | Launcher | `assets/adaptive-icon.png` overwritten with a byte-identical copy of `icon.png`: a full-bleed opaque square that a launcher mask crops by a third | FIXED_AND_VERIFIED |
| AND-BACKUP-001 | P2 | Privacy | `android:allowBackup="false"` was a hand edit `app.json` never expressed; Expo defaults it to true, so a prebuild re-enabled Auto Backup | FIXED_AND_VERIFIED |
| AND-EDGE-001 | P2 | Edge-to-edge | Prebuild re-adds `android:statusBarColor` and `expo.edgeToEdgeEnabled`, undoing B29-EDGE-001; no app-config value suppresses it | FIXED_AND_VERIFIED |
| AND-LINK-001 | P2 | App Links | Committed intent-filters lacked Expo's `data-generated` marker, so a prebuild appended duplicates and `/rooms/*` was declared twice | FIXED_AND_VERIFIED |
| AND-TEST-001 | P3 | Regression baseline | Orientation and room-link assertions required literal formatting a faithful prebuild breaks | FIXED_AND_VERIFIED |
| AND-UI-001 | P2 | Orientation | Plan asked to restore the portrait lock | NOT_A_DEFECT — see §5 |
| AND-GRADLE-001 | P4 | Release config | Prebuild prefers `sentry.gradle.kts`; committed `build.gradle` applies `sentry.gradle` | NOT_A_DEFECT — both ship in `@sentry/react-native` 8.22.0 and Sentry is disabled for Build 29 |
| AND-THEME-001 | P4 | Launch window | `AppTheme` sets no `windowBackground`, and `userInterfaceStyle: "dark"` is inert on Android without `expo-system-ui` | NOT_A_DEFECT — the luxury canvas is `#FAF8F5`, so the light launch window matches the shipped UI. Forcing a dark window would introduce a flash |
| AND-SIGN-001 | P4 | Release config | The release block's comment documents `KSCAN_STORE_FILE` / `KSCAN_STORE_PASSWORD` env vars that no Gradle code reads | NONBLOCKING_HARDENING — EAS injects credentials; only a local release build is affected |
| AND-LINK-002 | P4 | App Links | `parseRoomDeepLink` accepts `www.kscan.app` but only the apex host is domain-verified | NONBLOCKING_HARDENING — shares emit the apex host; matters only if the site adds a `www` redirect |
| AND-ASSET-001 | P4 | Generated assets | Expo's image encoder regenerates launcher/splash binaries far larger (xxxhdpi splash 66KB to 800KB) | NOT_A_DEFECT — committed optimized assets stay authoritative; text config converges, binaries deliberately do not |

## 5. Deviation: the portrait lock was not restored

The repair plan recorded that "the approved portrait behavior had been lost". The evidence
contradicts that framing. Portrait was removed deliberately as `B29-UI-001` (P2, Adaptive
UI, root cause "K Scan-owned orientation restriction"), fixed in `b8a8b44`, with regression
evidence "Phone landscape, tablet and foldable-size emulator checks"; section 9 of that
audit records a responsive smoke across phone landscape, 1600x2560 tablet and 840x2200
foldable geometry with no crash or ANR. `__tests__/androidReleaseQuality.test.js` then
locked the behaviour in.

Restoring portrait would undo an intentional, validated Build 29 feature, which is an
explicit stop condition. The owner confirmed adaptive orientation is retained and the
historical finding is classified NOT_A_DEFECT.

The regression test was changed from requiring the literal absence of
`android:screenOrientation` to asserting the invariant — the activity is not locked to one
orientation — because a faithful prebuild emits the behaviourally equivalent
`android:screenOrientation="unspecified"`.

## 6. Durability model

`plugins/androidNativeDeclarationContract.js` and `plugins/androidEdgeToEdgeContract.js`
hold the contract, dependency-free so it can be asserted without a native toolchain.
`app.json` carries everything Expo supports natively (`permissions`, `blockedPermissions`,
`allowBackup`, `adaptiveIcon.monochromeImage`, `intentFilters`). Two config plugins own the
end states Expo cannot express:

* `withRemoveUnusedForegroundServices` — Expo has no built-in for `<service>` merge
  tombstones.
* `withAndroidEdgeToEdgeSystemBars` — `withAndroidSplashScreen` copies
  `splash.backgroundColor` into `androidStatusBar.backgroundColor` before `withStatusBar`
  reads it, so no app-config value can suppress `android:statusBarColor`.

Build 28's `withAndroidPermissionBlocklist` was **not** forward-ported: it only wrapped
`AndroidConfig.Permissions.withBlockedPermissions`, which `app.json` now drives directly.

## 7. Classification

```text
SHARED SOURCE AUTHORITY             VERIFIED
ANDROID MANIFEST                    PASS
ANDROID PERMISSION SET              PASS
FOREGROUND SERVICE CONFIG           PASS
ANDROID PORTRAIT BEHAVIOR           NOT_A_DEFECT (adaptive orientation retained by owner decision)
ANDROID ADAPTIVE ICON               PASS
ANDROID MONOCHROME ICON             PASS
ANDROID APP LINK CONFIG             PASS
APP_LINK_ROUTE_RUNTIME              EMULATOR_VERIFIED
PLAY_AUTO_VERIFY                    OWNER / PLAY_SIGNING_CERT_CHECK REQUIRED
PLAY_INSTALLED_APP_LINK             DEVICE / ARTIFACT_TEST REQUIRED
BROWSER FALLBACK                    PASS
SHARED ROOM DURABILITY              PASS (shared repair)
OWNER LINK REVOCATION               PASS (shared repair)
REPORT / BLOCK / UGC                PASS
REACTIONS CLIENT ACCESS             PASS
ANDROID BACK/NAVIGATION             PASS
ANDROID INSETS/LAYOUT               PASS
WEAR / CPW                          NOT REACHABLE
PLAY RELEASE CONFIG                 PASS
R8 / MINIFICATION                   ENABLED (B29-R8-001), keep rules re-verified
SENTRY                              DISABLED
TESTSPRITE                          DEFERRED
```

## 8. Owner actions

1. **App Links certificate.** Compare the SHA-256 fingerprint published at
   `https://kscan.app/.well-known/assetlinks.json` with the **App signing key** certificate
   in Google Play Console. If Play App Signing is active, the published fingerprint must be
   the Play app-signing certificate, not the upload certificate. No code change unless they
   differ. The file is live and delegates `handle_all_urls` to `com.kscanai.app`.

## 9. Referred to shared triage

Both items are shared React Native code, not Android-native configuration, and were
classified rather than forked on this branch.

1. `app/style-chat/[sessionId].tsx:1120` — `behavior={Platform.OS === 'ios' ? 'padding' : 'padding'}`,
   a no-op ternary that applies `padding` on Android where the other twelve call sites use
   `undefined` or `'height'`. Combined with `adjustResize` this can over-lift the composer.
   Not exercised on the emulator: the StyleChat composer is behind authentication and no
   staging credentials were available. DEVICE_TEST_REQUIRED.
2. `app.json` `userInterfaceStyle: "dark"` — inert on Android without `expo-system-ui`, and
   inconsistent with the shipped light canvas (`#FAF8F5`). It is not inert on iOS.

## 10. Tests

```text
FOCUSED ANDROID SUITES              53/53 PASS
FULL CLOSURE SUITE                  6493 tests, 6434 pass, 0 fail, 59 skipped
PREBUILD CONVERGENCE                AndroidManifest.xml regenerates with zero drift
```

New Android regression suites: `androidNativeDeclarationContract`, `androidLauncherIcon`,
`androidEdgeToEdgeSystemBars`, `androidAppLinkContract`, `androidPlayReleaseConfig`,
`androidUgcReachability`.
