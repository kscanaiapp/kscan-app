# kscan-pii-native

Inactive cross-platform native face-masking privacy engine for K Scan AI.

## Scope

This local Expo module provides an isolated, source-agnostic pipeline:

```text
Local file URI
→ metadata validation
→ orientation normalization
→ local face detection
→ canonical face boxes
→ identical padding and rounding
→ opaque solid redaction
→ local PNG encoding
→ persisted-output re-decode
→ persisted pixel verification
→ sanitized cache URI
```

## Platform implementations

- **Android**: bundled Google ML Kit Face Detection (`com.google.mlkit:face-detection`), Android Bitmap/Canvas, PNG output.
- **iOS**: Apple Vision `VNDetectFaceRectanglesRequest`, ImageIO orientation, Core Graphics redaction, PNG output.

## Public API

```ts
getPrivacyCapabilities(): Promise<NativePrivacyCapabilities>
detectAndMaskFaces(input: NativeFaceMaskInput): Promise<NativeFaceMaskResult>
cleanupSanitizedImage(uri: string): Promise<NativeCleanupResult>
```

License-plate screening, **Android implemented; iOS not yet**. The TypeScript
contract for both lives in `src/KScanPiiNative.types.ts`
(`NativePlateMaskResult`, `NativePlateCapabilities`):

```ts
getPlateCapabilities(): Promise<NativePlateCapabilities>
detectAndMaskPlates(input: NativePlateMaskInput): Promise<NativePlateMaskResult>
```

## Activation status

**Inactive.** This module is not imported by any current application screen,
camera flow, scanner, upload path, or backend client. The first active consumer
will be built in a later integration branch.

## Validation

- Android: `./gradlew.bat assembleDebug`, `./gradlew.bat testDebugUnitTest`, `./gradlew.bat connectedDebugAndroidTest`
- iOS: macOS/Xcode required; commands documented in the cross-platform parity report.
- Shared: `node --test __tests__/nativePiiParity.test.js`

## Non-goals

This phase does not implement OCR, facial recognition, identity matching,
embeddings, camera integration, upload integration, backend transmission,
release builds, or production activation.

License-plate **region screening** is now implemented on Android
(`AndroidPlateDetector`, bundled ML Kit text recognition). It is explicitly not
OCR: the recognizer is used as a region proposer, and the recognized characters
are never read, returned, logged or persisted. Selection is a geometry
heuristic — aspect ratio, relative width, absolute height, relative area — whose
thresholds live in `NativePrivacyConstants` and are UNTUNED against a measured
corpus. Motorcycle and square-format plates fall outside the aspect band by
design, and non-Latin scripts are not recognized at all.
