# K Scan AI Privacy Lens — Phase 1B Dependency Decision Table

## Date: Current Session
## Branch: feature/privacy-lens-post-capture-dependency-prototype
## Environment: No package manager available (npm/yarn/pnpm unavailable)

---

## Face Detection Options

| Package / Approach | Still-Image Detection | Android | iOS | Expo SDK 54 | Dev Build | Native Config | Maintenance Risk | Prototype Suitability | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| `expo-camera` v17.0.10 built-in | ❌ Removed — `FaceDetector` module absent from v17.0.10 | N/A | N/A | N/A | N/A | N/A | High | ❌ Not available | **REJECT** |
| `expo-face-detector` (standalone) | ❌ Deprecated/removed from Expo SDK 49+ | N/A | N/A | ❌ Incompatible | N/A | N/A | High | ❌ Not available | **REJECT** |
| `react-native-vision-camera` + MLKit | ✅ Yes | ✅ Yes | ✅ Yes | ⚠️ Conflicts with `expo-camera` | ✅ Yes | ✅ Yes | Medium | ❌ Requires camera migration (violates hard rule) | **REJECT** |
| `@react-native-mlkit/face-detection` | ✅ Yes | ✅ Yes | ✅ Yes | ⚠️ Needs native config | ✅ Yes | ✅ Yes | Medium | ⚠️ Requires dev build + native config | **DEFER** |
| Custom native module (MLKit / VisionKit) | ✅ Yes | ✅ Yes | ✅ Yes | ⚠️ Needs native config | ✅ Yes | ✅ Yes | High | ⚠️ High complexity, high risk | **DEFER** |
| Server-side detection (backend API) | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Yes | ❌ No | ❌ No | Low | ⚠️ Requires backend changes (violates hard rule) | **REJECT** |
| Pure JS (TensorFlow.js face-landmarks-detection) | ⚠️ Extremely slow, high battery drain | ✅ Yes | ✅ Yes | ✅ Yes | ❌ No | ❌ No | Medium | ⚠️ Performance unacceptable for mobile | **DEFER** |
| **Mock detector (placeholder)** | ✅ Configurable | ✅ N/A | ✅ N/A | ✅ N/A | ❌ No | ❌ No | None | ✅ Zero risk, full pipeline testable | **ACCEPT** |

---

## Image Redaction / Pixelation Options

| Package / Approach | Selective Blur/Pixelate | Android | iOS | Expo SDK 54 | Dev Build | Native Config | Maintenance Risk | Prototype Suitability | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| `expo-image-manipulator` v14.0.8 | ❌ No — supports only resize, crop, rotate, flip, extent (web-only) | ✅ Yes | ✅ Yes | ✅ Yes | ❌ No | ❌ No | Low | ✅ Available, but no selective ops | **PARTIAL** |
| `expo-image-manipulator` creative approach | ⚠️ Can crop face region + resize to tiny, but **cannot composite back** onto original | ✅ Yes | ✅ Yes | ✅ Yes | ❌ No | ❌ No | Low | ⚠️ Cannot composite back — no overlay support | **PARTIAL** |
| `@shopify/react-native-skia` | ✅ Yes — full 2D drawing API | ✅ Yes | ✅ Yes | ⚠️ Needs native config | ✅ Yes | ✅ Yes | Medium | ⚠️ Requires dev build + native config | **DEFER** |
| `react-native-canvas` (WebView-based) | ✅ Yes | ✅ Yes | ✅ Yes | ⚠️ Complex | ⚠️ Maybe | ⚠️ Maybe | Medium | ⚠️ High complexity, performance concerns | **DEFER** |
| Pure JS image manipulation (jpeg-js, jimp) | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Yes | ❌ No | ❌ No | Low | ⚠️ Extremely slow on mobile (decode → manipulate → encode) | **DEFER** |
| **Placeholder (pass-through)** | ❌ No | ✅ N/A | ✅ N/A | ✅ N/A | ❌ No | ❌ No | None | ✅ Zero risk, pipeline demonstrable | **ACCEPT** |

---

## Chosen Prototype Path

### Verdict: **Mock Detector + Placeholder Redaction + `expo-image-manipulator` Pipeline Demonstration**

**Rationale:**
1. No package manager available in the environment — cannot install new dependencies.
2. `expo-camera` v17.0.10 has no `FaceDetector` for still images.
3. `expo-image-manipulator` v14.0.8 has no selective blur/pixelate/overlay operations.
4. Real face detection and redaction require native module installation (Skia, MLKit, or VisionCamera), which requires:
   - Package manager access
   - Expo development build
   - Native Android/iOS configuration
   - EAS build or local native build environment
5. The current environment has **no Java, no Android toolchain, no Xcode, no EAS access**.

### Prototype Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Privacy Lens Prototype (Phase 1B)                                        │
│  Feature Flag: PRIVACY_LENS_POST_CAPTURE_ENABLED = false                    │
└─────────────────────────────────────────────────────────────────────────────┘

1. Mock Detector
   - Returns empty array by default (no faces detected)
   - Can be configured to return mock face regions for testing
   - No real detection performed
   - No coordinate logging
   - No biometric metadata

2. Redaction Adapter (Placeholder)
   - Currently returns original image unchanged
   - Demonstrates the pipeline structure
   - Uses expo-image-manipulator for pass-through (no-op) to prove integration
   - Real implementation requires Skia or native module

3. Feature-Flagged Integration
   - Modifies services/privacyImageSanitizer.js
   - When flag is false: returns input unchanged (legacy behavior preserved)
   - When flag is true: runs prototype pipeline
   - Fail-closed: any error throws to prevent upload

4. Future Real Implementation Path
   - Detector: Install @react-native-mlkit/face-detection or react-native-vision-camera + MLKit
   - Redaction: Install @shopify/react-native-skia for 2D drawing / pixelation
   - Requires: expo-dev-client, EAS build, native config changes
```

### Files to Modify
- `services/privacyImageSanitizer.js` — add feature flag check
- `services/privacyLensPrototype.js` — rewrite with mock detector, placeholder redaction, pipeline integration

### Files NOT Changed
- `package.json` — no new dependencies (cannot install)
- `android/` — no native changes
- `ios/` — no native changes
- `hooks/useKScan.js` — no caller changes (legacy path preserved)
- `services/api.js` — no backend changes
- `services/scanIdentification.ts` — no backend changes

---

## Remaining Blockers for Real Implementation

1. **Package manager access** — need npm/yarn to install Skia or MLKit packages
2. **Development build** — need `expo-dev-client` and EAS/local native build
3. **Java / Android toolchain** — need JDK + Android SDK for Android build
4. **Xcode / macOS** — need for iOS build
5. **Selective image manipulation** — need Skia or equivalent for pixelation/redaction
6. **Still-image face detection** — need MLKit or VisionKit face detection module
