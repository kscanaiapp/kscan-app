package com.kscan.glasses.privacy

/**
 * On-device face region masking.
 *
 * TODO: Implement with ML Kit Face Detection before production.
 * Do not use third-party cloud face APIs.
 * Do not persist face bounding boxes or embeddings.
 */
class FaceMasker {
    fun maskFaces(base64: String, mimeType: String): MaskResult {
        // Production implementation required before release
        return MaskResult.NotImplemented(
            "ML Kit face masking not yet implemented. Use MockPrivacyImageSanitizer for local testing.",
        )
    }
}

sealed class MaskResult {
    data class Success(val base64: String, val mimeType: String) : MaskResult()
    data class NoFaces(val base64: String, val mimeType: String) : MaskResult()
    data class NotImplemented(val reason: String) : MaskResult()
    data class Error(val message: String) : MaskResult()
}
