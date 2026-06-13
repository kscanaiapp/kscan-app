package com.kscan.glasses.privacy

interface PrivacyImageSanitizer {
    suspend fun sanitize(base64: String, mimeType: String): SanitizeResult
}

sealed class SanitizeResult {
    data class Success(val sanitizedBase64: String, val mimeType: String) : SanitizeResult()
    data class Blocked(val reason: String) : SanitizeResult()
    data class Error(val message: String) : SanitizeResult()
}

/**
 * Production sanitizer — strict mode blocks upload on any failure.
 */
class StrictPrivacyImageSanitizer(
    private val faceMasker: FaceMasker = FaceMasker(),
    private val compressor: ImageCompressor = ImageCompressor(),
    private val allowRawFallback: Boolean = false,
) : PrivacyImageSanitizer {

    override suspend fun sanitize(base64: String, mimeType: String): SanitizeResult {
        if (base64.isBlank()) {
            return SanitizeResult.Blocked("Empty image payload")
        }

        return when (val masked = faceMasker.maskFaces(base64, mimeType)) {
            is MaskResult.Success -> {
                val compressed = compressor.compressJpeg(masked.base64)
                SanitizeResult.Success(compressed, masked.mimeType)
            }
            is MaskResult.NoFaces -> {
                val compressed = compressor.compressJpeg(masked.base64)
                SanitizeResult.Success(compressed, masked.mimeType)
            }
            is MaskResult.NotImplemented -> {
                if (allowRawFallback) {
                    SanitizeResult.Error("Raw fallback disabled in production builds")
                } else {
                    SanitizeResult.Blocked(masked.reason)
                }
            }
            is MaskResult.Error -> SanitizeResult.Blocked(masked.message)
        }
    }
}

/**
 * Mock sanitizer for local testing — simulates successful face-safe output.
 * NOT for production use.
 */
class MockPrivacyImageSanitizer(
    private val compressor: ImageCompressor = ImageCompressor(),
) : PrivacyImageSanitizer {

    override suspend fun sanitize(base64: String, mimeType: String): SanitizeResult {
        if (base64.isBlank()) {
            return SanitizeResult.Blocked("Empty image payload")
        }
        val compressed = compressor.compressJpeg(base64)
        return SanitizeResult.Success(compressed, mimeType)
    }
}
