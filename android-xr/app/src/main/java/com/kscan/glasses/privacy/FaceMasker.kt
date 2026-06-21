package com.kscan.glasses.privacy

/**
 * On-device face region masking.
 *
 * Production boundary for ML Kit face detection. This class is intentionally
 * not implemented in Prompt 2 because ML Kit dependency versions must be
 * confirmed against the target Android XR / Jetpack Projected SDK level.
 *
 * Before production release:
 *   - Add ML Kit Face Detection dependency to build.gradle.kts
 *   - Implement maskFaces() using on-device face detector
 *   - Apply Gaussian blur or solid mask over bounding boxes with padding
 *   - Re-encode JPEG via ImageCompressor after masking
 *   - Return NoFaces when detector completes with zero faces
 *   - Return Error only on detector failure (not on zero faces)
 *   - Do not use third-party cloud face APIs
 *   - Do not persist bounding boxes, embeddings, or face counts
 */
class FaceMasker {
    fun maskFaces(base64: String, mimeType: String): MaskResult {
        // Production implementation required before release.
        // Until then, StrictPrivacyImageSanitizer will fail closed (Blocked).
        return MaskResult.NotImplemented(
            "ML Kit face masking not yet implemented. " +
            "Use SanitizerMode.MOCK for local testing only.",
        )
    }
}

sealed class MaskResult {
    data class Success(val base64: String, val mimeType: String) : MaskResult()
    data class NoFaces(val base64: String, val mimeType: String) : MaskResult()
    data class NotImplemented(val reason: String) : MaskResult()
    data class Error(val message: String) : MaskResult()
}
