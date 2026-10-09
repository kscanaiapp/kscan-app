# Android Native Configuration Report — Build 35

**Source candidate:** `f2f94e8bb9ca758d45f0d7db6e3206c3d0903bf4`  
**Authority model:** Android is `NATIVE_AUTHORITATIVE`.

## Authoritative native surfaces

- `android/app/build.gradle`
- `android/build.gradle`
- `android/gradle.properties`
- `android/app/src/main/AndroidManifest.xml`
- `android/app/src/release/AndroidManifest.xml`
- `android/app/src/certification/AndroidManifest.xml`
- `android/app/src/push/AndroidManifest.xml`
- `android/app/src/voicePush/AndroidManifest.xml`
- `config/native-config-authority.json`

`app.json` remains declarative/parity input and cannot override the committed native Android authority by itself.

## Exact Gradle configuration proof

A source-only GitHub Actions probe ran `:app:help` with an init script. It performed Gradle project evaluation only and produced no APK/AAB.

| Property | Resolved value |
| --- | --- |
| compileSdk | **36** |
| targetSdk | **36** |
| minSdk | **24** |
| namespace | `com.kscanai.app` |
| applicationId | `com.kscanai.app` |
| source versionCode | `23` |
| versionName | `1.0.1` |
| release minify | **true** |
| release resource shrink | **false** |
| release capability manifest | `src/release/AndroidManifest.xml` |
| production Voice capability | **false** |
| production push capability | **false** |
| Google Services required in ordinary production | **false** |

The future store versionCode remains EAS-remote authority, not the checked-in seed.

## Runtime/native engine configuration

Source/config review confirms:

- React Native 0.81.5
- Expo SDK 54
- Hermes enabled
- New Architecture enabled
- edge-to-edge enabled
- legacy native library packaging disabled
- ABI configuration includes `armeabi-v7a`, `arm64-v8a`, `x86`, `x86_64`
- release R8/minification enabled
- release resource shrinking disabled
- upload/store signing is credential-managed externally and must be artifact-verified later

## Production permission posture

The main/native release authority deliberately removes transitive/default capabilities that are not part of ordinary production.

Expected ordinary production source posture:

### Intended first-party permissions
- `CAMERA`
- `INTERNET`
- `VIBRATE`
- `ACCESS_COARSE_LOCATION`

### Removed / held permissions
- `POST_NOTIFICATIONS`
- `RECORD_AUDIO`
- `RECEIVE_BOOT_COMPLETED`
- `ACCESS_FINE_LOCATION`
- `ACCESS_BACKGROUND_LOCATION`
- `READ_EXTERNAL_STORAGE`
- `WRITE_EXTERNAL_STORAGE`
- broad `READ_MEDIA_*`
- `MANAGE_EXTERNAL_STORAGE`
- `FOREGROUND_SERVICE_MICROPHONE`
- `CAPTURE_AUDIO_OUTPUT`
- unused foreground-service/media-playback capability
- Advertising ID
- contacts / SMS / call-log / Bluetooth families

Final transitive permission proof remains an AAB merged-manifest task.

## Voice / push capability matrix

The native build logic keeps Voice and remote push independent:

| Push | Voice | Source-set manifest | Expected grant |
| --- | --- | --- | --- |
| OFF | OFF | `src/release` | neither microphone nor notifications |
| OFF | ON | `src/certification` | RECORD_AUDIO only |
| ON | OFF | `src/push` | POST_NOTIFICATIONS only |
| ON | ON | `src/voicePush` | both |

For Build 35 ordinary `production`, Push=OFF and Voice=OFF.

The matrix is protected by native parity and Android regression suites. Voice-capable manifests must not grant background microphone capture or foreground microphone service capability.

## Exported/native components

Source review confirms:

- `MainActivity` is the application entry and browser/deep-link entry.
- `com.canhub.cropper.CropImageActivity` is explicitly `exported=false`.
- the transitive Google ML Kit code-scanner delegate activity that K Scan does not use is removed.
- unused audio/location foreground services are removed from the merged-manifest source contract.
- HTTPS room App Links are declared for `kscan.app/rooms`.
- custom scheme `kscan://` is present for authentication/application routing.

Final merged component inventory remains post-build evidence.

## Activity lifecycle / back configuration

- `MainActivity.onCreate` uses `super.onCreate(null)`, preserving the established React/Expo restoration contract.
- root back behavior preserves Android version-specific task handling.
- predictive-back callback integration remains opted out at the manifest level. This was not proven defective in source; validate real Android 15/16 Back behavior after build rather than changing it speculatively.
- `windowSoftInputMode=adjustResize`.

## Firebase / notifications

Gradle behavior is fail-closed:

- with remote push held OFF, ordinary production does not need Google Services materialization.
- a genuinely push-capable build requires valid Google Services configuration and applies the plugin.
- a push-capable build missing required config is rejected instead of silently producing a half-configured app.
- boot restoration capability remains suppressed because K Scan does not schedule local notifications.

## Validation evidence

- Native config parity: PASS
- Focused Android/native suites: 412/412
- Held release surface suites: 225/225
- Exact-head dependency reachability: PASS
- Exact-head TypeScript: PASS
- Exact-head full governed CI: PASS
- Source manifests strict/well-formedness regression suite: PASS
- exported cropper containment: PASS

## Artifact-only items

Do not convert these to source PASS values:

- final merged manifest and transitive components
- final signing certificate
- final remote versionCode
- final R8 mapping/runtime behavior
- final native-library ABI/16 KB ELF alignment
- actual Firebase resource packaging
- App Links signing relationship
- installed Android 15/16 lifecycle/keyboard/back behavior

Those items are transferred to `ANDROID_POSTBUILD_TEST_HANDOFF.md`.
