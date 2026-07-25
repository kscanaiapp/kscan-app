# services/privacy/onDeviceMasking

Isolated on-device PII masking proof of concept.

## Scope

- Dependency-free RGBA pixel redaction engine.
- Validated and deduplicated PII bounding boxes, rounded outward to whole
  pixels (floor start, ceil end) so a fractional detector box can never
  leave part of a region unmasked.
- Bounded input dimensions (max 8192x8192 / 256 MiB) to avoid unbounded
  allocation or iteration cost from a malformed or hostile buffer.
- Explicit face and license-plate detector interfaces.
- Honest unsupported detector providers.
- Synthetic detector providers for pipeline testing only. Synthetic and
  unsupported detectors can never satisfy the `allowCleanNoDetection`
  policy — only a detector reporting `supported: true` can approve a
  "nothing found" result as safe, since a non-inspecting detector reporting
  zero regions is not evidence the image is actually clean.
- Conservative `safeForTransmission` decisions.
- Non-cryptographic, dependency-free checksums (`inputHash`/`outputHash`)
  for POC-level change detection only — no Node-only APIs (`node:crypto`
  is not available in the React Native runtime), and no cryptographic
  integrity claim.

## Non-goals

- No current mobile scan integration.
- No real camera capture integration.
- No live glasses integration.
- No native dependency installation.
- No cloud detection.
- No OCR, identity recognition, face embeddings, or biometric templates.
- No production feature flags or routes.

## Current state

- **Real RGBA redaction**: implemented in `rgbaMasking.ts`.
- **Real face detector**: blocked (`unsupportedFaceDetector`).
- **Real plate detector**: blocked (`unsupportedLicensePlateDetector`).
- **Synthetic detectors**: implemented for tests.
- **Real image codec**: blocked (`unsupportedLocalImageCodec`).
- **Encoded-image pipeline**: returns `safeForTransmission: false` because codec is unsupported.

## Key exports

- `maskRgbaRegions(input, regions, options)` — real pixel-level redaction.
- `runDecodedRgbaPrivacyPipeline(input)` — decoded-buffer pipeline.
- `runEncodedImagePrivacyPipeline(input)` — encoded-image boundary.
- `toPrivacySanitizerResult(result)` — adapter to foundation privacy result.

## Test usage

Tests transpile these TypeScript modules with the project's `typescript` dev dependency.
