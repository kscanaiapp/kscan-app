# Native / declarative config authority (B34-DEF-002)

## What Expo Doctor was flagging

`npx expo-doctor` fails "Check for app config fields that may not be synced
in a non-CNG project" on both platform branches because `android/` is
committed alongside prebuild-style config in `app.json`. That warning cannot
tell you whether the coexistence is a real problem or the intended
architecture, so it was treated as an open question rather than resolved.

## What inspection found

The two platforms are **not symmetric**, and the asymmetry is the actual
architecture, not an accident:

| | Android | iOS |
|---|---|---|
| Native project committed? | Yes — `git ls-files android/` returns 38 tracked files | No — `git ls-files ios/` returns zero; `ios/` is absent from `.gitignore` because it is simply never generated into source control |
| What drives the shipped artifact | `android/app/build.gradle` + `android/app/src/main/AndroidManifest.xml` | `app.json`'s `ios` block, expanded fresh by Expo CNG at prebuild/build time |
| Where Build 32/33 hardening lives | Native Gradle files (R8/minification, AAB config) | Declarative `app.json` fields (`infoPlist`, `privacyManifests`, `associatedDomains`) — this is *why* it can be CNG: nothing needed a one-off native edit |

Verified currently in sync (2026-08-29): `build.gradle`'s `applicationId` /
`versionCode`, and `AndroidManifest.xml`'s permissions and intent-filter data
all match `app.json`'s `android` block exactly.

## Chosen authority model

Recorded in `config/native-config-authority.json`:

- **Android: `NATIVE_AUTHORITATIVE`.** The committed `android/` project is the
  source of truth. `app.json`'s `android` block is required to match it, not
  the other way around.
- **iOS: `CNG_AUTHORITATIVE`.** There is no native project to defer to;
  `app.json`'s `ios` block is the only source of truth.
- **Cross-platform invariants**, checked regardless of per-platform model:
  bundle/application ID must be identical, and the `autoVerify` HTTPS
  deep-link host in Android's `intentFilters` must equal the host in iOS's
  `applinks:` associated domain.

## What this pass did NOT do

- Did not run `expo prebuild` or otherwise regenerate `android/`.
- Did not create an `ios/` directory or otherwise change the CNG model for
  iOS.
- Did not touch Build 33's App Review hardening or Build 32's R8/AAB
  settings.

## The gate

`scripts/check-native-config-parity.js` enforces the table above every time
it runs: Android's declared config must match the native project it does not
control; iOS's declarative config must be internally complete (every
permission plugin has its required `infoPlist` usage-description string,
`bundleIdentifier` and `associatedDomains` are present); and the two
cross-platform invariants must hold. Four fixture negative controls (bundle
ID, a permission removed from `app.json` while still granted natively, a
deep-link path mismatch, and the Android application ID) are committed in
`__tests__/nativeConfigParityGate.test.js`.

## Expo Doctor's warning is expected to persist

`npx expo-doctor` will keep reporting 17/18 (the non-CNG warning) on both
branches. That is a correct reflection of the chosen architecture, not an
unresolved defect — the objective of this patch was an enforceable parity
gate with no ambiguous configuration, not a clean Expo Doctor score.
