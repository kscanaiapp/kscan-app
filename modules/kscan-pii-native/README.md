# kscan-pii-native

Local Expo module for K Scan AI. Two capabilities that share a decoder, a cache
manager and an orientation contract, and share nothing else:

1. **Face masking** — inactive privacy engine (Phase 0B).
2. **Person / body-region detection** — Mirror Selfie extraction (Build 2.5 Step 3B).

## Platform scope on THIS branch

This is the **iOS line**. The module here declares `platforms: ["apple"]` and
carries the Swift implementation only.

The Android half — `android/build.gradle`, the Kotlin sources and the bundled
ML Kit artifacts — lives on `feature/android-build-2.5-mirror-extraction` and is
deliberately NOT copied here. Importing a Gradle file and an ML Kit dependency
onto the iOS line would pull an Android build surface into a branch that does
not build Android for release, for no iOS benefit.

Declaring `apple` only is what makes that safe rather than broken: Expo
autolinking skips the module entirely for Android instead of looking for a
Kotlin implementation that is not there. When the two lines converge, the
`android` entry and its sources rejoin the same `expo-module.config.json`.

## Face masking

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

- **iOS**: Apple Vision `VNDetectFaceRectanglesRequest`, ImageIO orientation,
  Core Graphics redaction, PNG output.

## Person / body-region detection

Read-only. Given an app-owned, upright, metadata-free JPEG it returns normalized
person geometry. It writes no derivative file and modifies no input, so unlike
face masking there is no cleanup counterpart and no sanitized URI to track.

- **iOS**: `VNDetectHumanRectanglesRequest` (people and the ambiguity signal),
  `VNDetectHumanBodyPoseRequest` (landmarks),
  `VNGeneratePersonSegmentationRequest` (optional, transient coverage figure).

**This is not garment segmentation.** Vision does not know what a jacket is. The
module returns a person box and body joints; the anatomical bands are derived in
shared TypeScript (`services/mirror/mirrorGarmentRegions.ts`), which is also
where the honesty contract governing how far those bands may be trusted lives.

### Segmentation-mask lifecycle

The person mask is **memory-only, request-bound and never leaves native code**.
It is sampled to a single coverage number inside an `autoreleasepool`, and the
buffer is released when the request scope ends. It is never written to disk,
never returned across the bridge, and never emitted to telemetry.

### Coordinates

Vision reports **bottom-left-origin** normalized coordinates. Every consumer —
the JS pipeline, the crop generator, expo-image-manipulator — uses **top-left**.
The flip happens **exactly once**, in `IOSPersonDetector.flipY` / `flipPoint`.
`modules/kscan-pii-native/test-vectors/vision-coordinate-parity.json` is the
shared vector set: the Node suite checks the reference conversion against it,
and `ios/Tests` checks the Swift against the same file.

### Orientation

The caller supplies an image whose EXIF orientation has already been baked into
the pixels by `services/mirror/mirrorSourcePreparation.ts`, so
`CGImagePropertyOrientation.up` is correct — not a default. Passing anything
else would rotate the coordinate space a second time.

## Public API

```ts
getPrivacyCapabilities(): Promise<NativePrivacyCapabilities>
detectAndMaskFaces(input: NativeFaceMaskInput): Promise<NativeFaceMaskResult>
cleanupSanitizedImage(uri: string): Promise<NativeCleanupResult>
getExtractionCapabilities(): Promise<NativeExtractionCapabilities>
detectPersonRegions(input: NativePersonDetectionInput): Promise<NativePersonDetectionResult>
```

## Requirements

- iOS 15.1 (the project minimum; also the floor for person segmentation).
- Apple Vision only. No bundled, downloaded or redistributed model asset.
- No new camera or photo-library permission: image access stays with the
  existing picker flow, and this module only ever opens a `file://` URI the app
  already owns.

## Activation status

**Inactive.** Neither capability is reachable while `MIRROR_SELFIE_V1_ACTIVE` is
false, which is its state in every profile on this branch.

## Validation

- iOS: macOS/Xcode required. Not run on this branch — see the Step 3B report.
- Shared: `node --test __tests__/mirrorExtraction*.test.js`,
  `node --test __tests__/nativePiiParity.test.js`
- Coordinate parity: `node --test __tests__/mirrorIosVisionParity.test.js`

## Non-goals

OCR, facial recognition, identity matching, embeddings, garment classification,
camera integration, upload integration, backend transmission, release builds,
production activation.

License-plate detection was a non-goal until Build 34 Track B B2A added it; the
line above previously said so and is corrected here rather than left false.

## License-plate screening (B2A)

`detectAndMaskPlates` screens for plate-LIKE regions and masks them. Stated
precisely, because the name promises more than the mechanism delivers:

- Detection is `VNDetectTextRectanglesRequest` — text REGION geometry. No
  character is ever produced, so OCR remains a genuine non-goal above.
- A plate-shaped aspect/size filter then selects which text regions to mask.
- `no_plates` therefore means "nothing plate-shaped was found", NOT "this image
  contains no plate". It is a screen, not a guarantee.
- The error direction is deliberately toward over-masking. A garment wordmark,
  a shop sign or a book spine within the accepted aspect band will be masked
  too — a real product consequence in a wardrobe app, and the reason this
  capability must be validated on physical devices before it gates uploads.
