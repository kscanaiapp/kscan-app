# Privacy Pipeline — K Scan Google Glasses

## Intent

Protect user privacy before any image leaves the device for `/api/analyze`:

1. Detect faces in captured frames
2. Blur or mask detected face regions
3. Block upload if sanitization cannot be verified (strict mode)

## Face detection

- **Production target:** on-device ML Kit face detection (or equivalent Android on-device API)
- **Alpha status:** `FaceMasker` is a **TODO stub**; `MockPrivacyImageSanitizer` simulates success for local testing
- **Must complete real face detection before production release**

## Blur / mask behavior

- Apply Gaussian blur or solid mask over bounding boxes with padding
- Re-encode JPEG at reduced quality via `ImageCompressor` after masking
- Never upload the pre-sanitized buffer when strict mode is enabled

## Strict sanitizer failure behavior

`PrivacyImageSanitizer.sanitize()` returns:

```kotlin
sealed class SanitizeResult {
    data class Success(val sanitizedBase64: String, val mimeType: String) : SanitizeResult()
    data class Blocked(val reason: String) : SanitizeResult()
    data class Error(val message: String) : SanitizeResult()
}
```

- **Default strict mode:** `Blocked` or `Error` → **no upload**, user-facing error
- **No raw upload fallback in production** (`allowRawFallback = false` in release builds)

## No raw upload guarantee

Production build configuration:

- `BuildConfig.USE_MOCK_SANITIZER = false`
- Upload path checks `SanitizeResult.Success` exclusively
- Logging must not include image bytes, base64, or face coordinates

## No third-party face APIs

- Do not send images to external face recognition services
- On-device processing only
- No cloud face indexing

## No face metadata storage

- Do not persist bounding boxes, embeddings, or face counts
- Do not write face data to Supabase, logs, or analytics
- Discard intermediate bitmaps after sanitize step

## Testing

See `docs/TEST_PLAN.md` — privacy section. Use mock sanitizer for CI; manual verification required before production.
