# On-Device PII Masking Feasibility Assessment

Assessment date: 2026-07-10
Branch: `feature/on-device-pii-masking-poc`
Baseline: `glasses-foundation-audited-2026-07-10` (`b530a87`)

## Installed capabilities

- **Expo SDK**: 54.0.35
- **React Native**: 0.81.5
- **expo-camera**: 17.0.10 (camera capture only; no detection or pixel masking)
- **expo-image-picker**: 17.0.11 (image selection only)
- **expo-image-manipulator**: 14.0.8 (crop/rotate/flip; no pixel-level redaction)
- **Node native test runner**: available via `node --test`
- **TypeScript**: 5.9.2 (dev dependency)

## Missing capabilities

- No on-device face detector installed.
- No on-device license-plate detector installed.
- No local JPEG/PNG decoder that exposes raw RGBA pixels.
- No local image encoder that writes sanitized RGBA back to JPEG/PNG.
- No pixel-composition library (e.g. Skia) installed.
- No native iOS project directory (`ios/` absent).
- Native Android project directory exists (`android/`), indicating a non-CNG, manually maintained Android project.

## Candidate face detectors

| Candidate | Expo SDK 54 | Native build | iOS changes | Android changes | On-device | Bundle impact | Maintenance |
|-----------|-------------|--------------|-------------|-----------------|-----------|---------------|-------------|
| `expo-face-detector` | Deprecated/removed in SDK 54 | Yes | Pod install | Gradle | Yes | Medium | Officially deprecated by Expo |
| Google ML Kit Face Detection | N/A | Yes | CocoaPods / Swift | Gradle | Yes | Large | Actively maintained; requires native module wiring |
| Apple Vision (VNDetectFaceRectanglesRequest) | N/A | Yes | Pod / native Swift | N/A | Yes | Small (Apple-only) | Native iOS only; no Android parity |
| TensorFlow Lite face detector | N/A | Yes | CocoaPods / C++ | Gradle / NDK | Yes | Large | Complex; requires model bundling |
| React Native Vision Camera frame processors | N/A | Yes | CocoaPods | Gradle | Yes | Large | Requires worklets-core; not Expo SDK guaranteed |

No candidate is currently installed or guaranteed to work without native changes.

## Candidate plate detectors

| Candidate | Expo SDK 54 | Native build | iOS changes | Android changes | On-device | Notes |
|-----------|-------------|--------------|-------------|-----------------|-----------|-------|
| Google ML Kit Text Recognition / Object Detection | N/A | Yes | CocoaPods | Gradle | Yes | No dedicated plate model; would need custom model or heuristic |
| Apple Vision text recognition | N/A | Yes | Native Swift | N/A | Yes | iOS only; plate filtering needed |
| TFLite custom object detector | N/A | Yes | CocoaPods / C++ | Gradle / NDK | Yes | Requires training/bundling a plate model |
| OpenALPR-style models | N/A | Yes | Native | Native | Yes | Commercial/license considerations |

No candidate is currently installed.

## Candidate image codecs

| Candidate | Expo SDK 54 | Native changes | Notes |
|-----------|-------------|----------------|-------|
| `expo-image-manipulator` | Installed | None | Cannot access raw RGBA; only high-level crop/rotate/flip |
| `react-native-skia` | Not installed | Yes (C++ native module) | Can decode/encode and draw; large native dependency |
| Platform-native `UIImage` / `Bitmap` | N/A | Yes | iOS native not present in repo; Android native present |
| Pure-JS `jpeg-js` / `pngjs` | Not installed | No native changes | Pure JS decoding/encoding; very slow and large memory on mobile; not currently installed |

For this POC, no installed dependency can safely decode/encode pixels locally.

## Native requirements

- iOS: no `ios/` directory exists. Adding any native iOS detector would require `expo prebuild` or manually creating an Xcode project.
- Android: `android/` directory exists with manual Gradle setup. Native Android detectors would require Gradle changes, potentially NDK/CMake, and dependency imports.
- Any real detector or codec requires a development build; Expo Go would not suffice.

## Expo compatibility

- The project is **non-CNG** for Android (manual `android/` directory present).
- iOS is not currently prebuilt.
- `expo prebuild` would be required to generate/maintain native iOS project files.
- Expo Doctor currently reports a pre-existing warning about app config fields not syncing because native directories are present.

## Permission impact

- Camera permission already exists for scan functionality.
- No new permissions are needed for the POC because the POC operates on supplied RGBA buffers and does not integrate with the camera.
- A future native detector phase may require no additional runtime permissions beyond camera, but it will require native build changes.

## POC implementation selected

- Implement a dependency-free RGBA redaction engine in TypeScript.
- Define detector interfaces with explicit unsupported real providers.
- Provide synthetic detectors for deterministic pipeline testing.
- Define an `UnsupportedLocalImageCodec` because no installed dependency can safely decode/encode images locally without native changes.
- Implement a conservative pipeline that refuses to mark encoded images as `safeForTransmission` when the codec or required detectors are unsupported.
- Use generated RGBA buffers (not photographs) for fixtures.

## Explicit blockers

- Real face detection: blocked (no installed detector; native dependency required).
- Real license-plate detection: blocked (no installed detector; native dependency required).
- Real JPEG/PNG decode/encode: blocked (no installed pure-JS or native codec that fits the no-native-change rule).
- iOS native integration: blocked (`ios/` directory absent).
- Android native integration: blocked by phase scope (would require Gradle/NDK changes).

## Recommended later native phase

A separate branch such as `feature/native-pii-detector-integration` should:

1. Choose either Google ML Kit (cross-platform) or Apple Vision + ML Kit (platform-specific) for face detection.
2. Evaluate a custom TFLite model or ML Kit text recognition for plate detection.
3. Evaluate `react-native-skia` or platform-native `UIImage`/`Bitmap` for RGBA decode/encode and composition.
4. Run `expo prebuild` to generate/maintain iOS and Android native projects.
5. Add the required native dependencies with config plugins and manual native wiring.
6. Build a development build and test on real devices.
