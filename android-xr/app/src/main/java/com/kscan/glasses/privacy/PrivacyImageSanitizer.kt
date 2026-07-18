package com.kscan.glasses.privacy

import com.kscan.glasses.BuildConfig

interface PrivacyImageSanitizer {
    suspend fun sanitize(base64: String, mimeType: String): SanitizeResult
}

sealed class SanitizeResult {
    data class Success(val sanitizedBase64: String, val mimeType: String) : SanitizeResult()
    data class Blocked(val reason: String) : SanitizeResult()
    data class Error(val message: String) : SanitizeResult()
}

enum class SanitizerMode {
    MOCK,
    PRODUCTION,
}

/**
 * THE authoritative construction point for [PrivacyImageSanitizer].
 *
 * Selection rules:
 * - Debug mock profile ([SanitizerMode.MOCK]) -> [MockPrivacyImageSanitizer]
 * - Debug strict profile ([SanitizerMode.PRODUCTION]) -> [StrictPrivacyImageSanitizer]
 * - Release / real-upload profile -> [StrictPrivacyImageSanitizer] ONLY;
 *   requesting [SanitizerMode.MOCK] in a release build throws (fail fast,
 *   never a silent mock fallback).
 *
 * There is intentionally no default value for [mode]: no production path may
 * silently resolve to the mock sanitizer.
 */
object PrivacyImageSanitizerFactory {
    fun create(
        mode: SanitizerMode,
        isDebugBuild: Boolean = BuildConfig.DEBUG,
    ): PrivacyImageSanitizer = when (mode) {
        SanitizerMode.MOCK -> {
            if (!isDebugBuild) {
                throw IllegalStateException(
                    "CRITICAL: MockPrivacyImageSanitizer requested in a release build. " +
                    "Mock sanitizer does not provide production privacy. " +
                    "Release and real-upload profiles must use SanitizerMode.PRODUCTION."
                )
            }
            MockPrivacyImageSanitizer()
        }
        SanitizerMode.PRODUCTION -> StrictPrivacyImageSanitizer()
    }
}

/**
 * Production sanitizer — strict mode blocks upload on any failure.
 * No raw upload fallback exists. If face detection is unavailable, upload is blocked.
 */
class StrictPrivacyImageSanitizer(
    private val faceMasker: FaceMasker = FaceMasker(),
    private val compressor: ImageCompressor = ImageCompressor(),
) : PrivacyImageSanitizer {

    /**
     * True only when on-device face masking is implemented and usable.
     * False in this build: any sanitize() call fails closed with
     * [SanitizeResult.Blocked] before anything can be uploaded.
     */
    val isMaskingAvailable: Boolean
        get() = faceMasker.isMaskingAvailable

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
                // Fail closed: production sanitizer unavailable = block upload.
                SanitizeResult.Blocked(masked.reason)
            }
            is MaskResult.Error -> SanitizeResult.Blocked(masked.message)
        }
    }
}

/**
 * Mock sanitizer for local testing — simulates successful face-safe output.
 * NOT for production use. Does not perform real face detection or masking.
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
