# On-Device PII Native Integration Checkpoint

This document records the native-integration feasibility for real face and license-plate detection and recommends the next isolated branch. No native work was performed in the POC phase.

## Recommended face technology

**Google ML Kit Face Detection**

- Cross-platform Android/iOS support.
- Runs fully on-device.
- Well maintained by Google.
- No face embeddings or identity recognition; returns bounding boxes only.
- Requires native module wiring.

**Alternative (iOS-only)**: Apple Vision `VNDetectFaceRectanglesRequest` if Android parity is not required.

## Recommended plate technology

**No dedicated off-the-shelf plate detector exists** that is both cross-platform and Expo-compatible without native work.

Options:

1. **Google ML Kit Text Recognition** + heuristic plate-shaped filtering.
   - Cross-platform.
   - Requires writing post-processing heuristics.
   - May produce false positives.
2. **Custom TensorFlow Lite object-detection model** trained for license plates.
   - Cross-platform.
   - Requires model training, conversion, and bundling.
   - Larger bundle impact.
3. **Platform-native text recognition** (Apple Vision / ML Kit) + shape filtering.

Recommended first step: evaluate ML Kit Text Recognition with conservative plate-shaped region filtering.

## Recommended masking/rendering implementation

**React Native Skia (`@shopify/react-native-skia`)**

- Can decode JPEG/PNG to pixels.
- Can draw redaction rectangles.
- Can encode back to JPEG/PNG.
- Cross-platform.
- Requires native module installation.
- Bundle impact: several MB.

**Alternative**: platform-native `UIImage` (iOS) / `Bitmap` (Android) composition if Skia is too heavy.

## Recommended image codec

React Native Skia can act as both decoder/encoder and compositor, reducing the number of native dependencies.

If Skia is not selected:

- iOS: `UIImageJPEGRepresentation` / `UIImagePNGRepresentation` via native module.
- Android: `Bitmap.compress` via native module.

## Required package additions

- `@shopify/react-native-skia` (decoder/encoder/compositor)
- OR a custom native module for decode/encode/redaction.
- Face detector: Google ML Kit via `react-native-mlkit` or a custom Expo config plugin + native module.
- Plate detector: ML Kit Text Recognition or custom TFLite model.

## Required iOS changes

- `ios/` directory does not currently exist.
- Run `expo prebuild` to generate the iOS project.
- Add Skia / ML Kit pods to `Podfile` (or via config plugin).
- Add `NSCameraUsageDescription` already exists; no new camera permission needed.
- Add privacy manifest entries if ML Kit collects any API usage.

## Required Android changes

- Native Android project already exists (`android/`).
- Add Skia / ML Kit dependencies to `android/app/build.gradle`.
- Ensure `minSdkVersion` supports ML Kit (typically 21+).
- No new runtime permissions needed for detection (camera permission already exists).
- Add ProGuard rules if shrinking.

## Pod install required

Yes, if using any native module including Skia or ML Kit.

## Gradle changes required

Yes, for ML Kit and/or Skia dependency declarations.

## NDK/CMake required

- Skia: may require native build tooling depending on version.
- ML Kit: no NDK/CMake required for the bundled SDK.
- Custom TFLite model: may require NDK/CMake if using C++ interpreter.

## New permissions

None expected beyond the existing camera permission.

## Development build required

Yes. Any native dependency requires a development build; Expo Go will not suffice.

## Production build required

Yes, after native integration and device testing.

## Expected bundle impact

- Skia: ~3–8 MB depending on ABI split.
- ML Kit Face Detection: ~3–5 MB.
- ML Kit Text Recognition: ~5–10 MB.
- Custom TFLite model: model-size dependent (5–20 MB typical).

## Rollback method

- Revert the `feature/native-pii-detector-integration` branch.
- Keep the POC foundation (`feature/on-device-pii-masking-poc`) untouched.
- The current mobile scan flow must remain unchanged.

## Recommended isolated branch name

```text
feature/native-pii-detector-integration
```

This branch should start from `feature/on-device-pii-masking-poc` and contain only native detector/codec integration work.
