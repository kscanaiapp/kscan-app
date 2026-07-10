# services/privacy/onDeviceMasking

Isolated on-device PII masking proof of concept.

## Scope

- Dependency-free RGBA pixel redaction engine.
- Validated and deduplicated PII bounding boxes.
- Explicit face and license-plate detector interfaces.
- Honest unsupported detector providers.
- Synthetic detector providers for pipeline testing only.
- Conservative `safeForTransmission` decisions.

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
