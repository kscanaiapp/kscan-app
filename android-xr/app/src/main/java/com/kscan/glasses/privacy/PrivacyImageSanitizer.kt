package com.kscan.glasses.privacy

import com.kscan.glasses.BuildConfig

interface PrivacyImageSanitizer {
    suspend fun sanitize(base64: String, mimeType: String): SanitizeResult
}

sealed class SanitizeResult {
    data class Success(val sanitizedBase64: String, val mimeType: String) : SanitizeResult()
    data class Blocked(val reason: String) : SanitizeResult()

    /**
     * Strict sanitizer cannot run at all because on-device face masking is not
     * implemented in this build. Distinct from [Blocked]: the pipeline must surface
     * the dedicated "privacy protection unavailable" message, never retry copy.
     */
    data class MaskingUnavailable(val reason: String) : SanitizeResult()
    /**
     * Sanitizer crashed or the safe output boundary failed. [failure] carries
     * the deterministic [CompressFailure] classification when the failure came
     * from the re-encode boundary; null for any other sanitizer crash.
     * [message] is diagnostic-only and must never reach the HUD verbatim.
     */
    data class Error(val message: String, val failure: CompressFailure? = null) : SanitizeResult()
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
     * [SanitizeResult.MaskingUnavailable] before anything can be uploaded.
     */
    val isMaskingAvailable: Boolean
        get() = faceMasker.isMaskingAvailable

    override suspend fun sanitize(base64: String, mimeType: String): SanitizeResult {
        if (base64.isBlank()) {
            return SanitizeResult.Blocked("Empty image payload")
        }

        return when (val masked = faceMasker.maskFaces(base64, mimeType)) {
            is MaskResult.Success -> reencode(masked.base64)
            is MaskResult.NoFaces -> reencode(masked.base64)
            is MaskResult.NotImplemented -> {
                // Fail closed: production sanitizer unavailable = scan is NOT uploaded.
                // Never downgrade to raw upload; never substitute the mock sanitizer.
                SanitizeResult.MaskingUnavailable(masked.reason)
            }
            is MaskResult.Error -> SanitizeResult.Blocked(masked.message)
        }
    }

    /**
     * Runs the real JPEG re-encode boundary. Output is always newly encoded
     * bytes; any boundary failure stops the pipeline (Error), never passes
     * raw bytes through.
     */
    private fun reencode(maskedBase64: String): SanitizeResult {
        return when (val out = compressor.compressJpeg(maskedBase64)) {
            is CompressResult.Success -> SanitizeResult.Success(out.base64, out.mimeType)
            // Classification name only — never embed payload or input-derived data.
            is CompressResult.Failure -> SanitizeResult.Error(
                "Image re-encode failed (${out.failure.name})",
                failure = out.failure,
            )
        }
    }
}

/**
 * Mock sanitizer for local testing — simulates successful face-safe output.
 * NOT for production use. Does not perform real face detection, masking,
 * decoding, or re-encoding: the payload passes through untouched.
 * Pipelines using this sanitizer are labeled MOCK in the UI.
 */
class MockPrivacyImageSanitizer : PrivacyImageSanitizer {

    override suspend fun sanitize(base64: String, mimeType: String): SanitizeResult {
        if (base64.isBlank()) {
            return SanitizeResult.Blocked("Empty image payload")
        }
        // Mock pass-through by design; the real output boundary is ImageCompressor,
        // exercised only by StrictPrivacyImageSanitizer.
        return SanitizeResult.Success(base64, mimeType)
    }
}
