package com.kscan.glasses.scan

import com.kscan.glasses.analyze.AnalyzeClient
import com.kscan.glasses.analyze.AnalyzeClientConfig
import com.kscan.glasses.analyze.AnalyzeDryRunGate
import com.kscan.glasses.analyze.AnalyzeException
import com.kscan.glasses.analyze.AnalyzeRequest
import com.kscan.glasses.analyze.DebugAnalyzeConfig
import com.kscan.glasses.analyze.DryRunGateResult
import com.kscan.glasses.config.BetaConfig
import com.kscan.glasses.config.SafeLog
import com.kscan.glasses.phonebridge.PhoneBridgeProvider
import com.kscan.glasses.privacy.CompressFailure
import com.kscan.glasses.privacy.PrivacyImageSanitizer
import com.kscan.glasses.privacy.SanitizeResult
import com.kscan.glasses.state.FashionAnalyzeResult
import com.kscan.glasses.state.NonFashionAnalyzeResult
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * App-level scan orchestrator that wires the full pipeline:
 * input → resize/compress → sanitizer → data URL encoder → analyze client → HUD result → phone bridge actions.
 *
 * All heavy work runs on the injected IO dispatcher. No UI thread blocking.
 */
class ScanOrchestrator(
    private val sanitizer: PrivacyImageSanitizer,
    private val analyzeClient: AnalyzeClient,
    private val phoneBridge: PhoneBridgeProvider,
    private val config: BetaConfig,
    private val clientConfig: AnalyzeClientConfig = AnalyzeClientConfig.MOCK_ONLY,
    private val debugConfig: DebugAnalyzeConfig = DebugAnalyzeConfig.DEFAULT,
    private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
) {

    /**
     * Run the full scan pipeline with the given input.
     *
     * Returns a sealed result with either success (FashionAnalyzeResult) or failure (ScanOrchestratorError).
     */
    suspend fun run(input: ScanInput): ScanOrchestratorResult = withContext(ioDispatcher) {
        try {
            // 1. Pre-process (compress/resize if needed)
            val compressed = preProcess(input)

            // 2. Privacy sanitizer
            val sanitized = when (val result = sanitizer.sanitize(compressed.base64, compressed.mimeType)) {
                is SanitizeResult.Success -> result
                is SanitizeResult.MaskingUnavailable -> return@withContext ScanOrchestratorResult.Failure(
                    ScanOrchestratorError.PrivacyUnavailable(result.reason)
                )
                is SanitizeResult.Blocked -> return@withContext ScanOrchestratorResult.Failure(
                    ScanOrchestratorError.PrivacyBlocked(result.reason)
                )
                is SanitizeResult.Error -> return@withContext ScanOrchestratorResult.Failure(
                    // Deterministic classification only; the raw sanitizer message
                    // never reaches the HUD.
                    ScanOrchestratorError.ImageProcessingError(result.failure)
                )
            }

            // 3. Encode to data URL
            val dataUrl = encodeDataUrl(sanitized.sanitizedBase64, sanitized.mimeType)

            // 4. Validate data URL
            if (!AnalyzeRequest.isValidDataUrl(dataUrl)) {
                return@withContext ScanOrchestratorResult.Failure(
                    ScanOrchestratorError.EncodeFailure("Invalid data URL generated")
                )
            }

            // 5. Dry-run gate (Phase 3B): proves real analyze readiness without transport execution.
            if (config.enableDryRun) {
                val gateResult = AnalyzeDryRunGate.evaluate(
                    betaConfig = config,
                    clientConfig = clientConfig,
                    debugConfig = debugConfig,
                    sanitizerSuccess = true,
                )
                return@withContext when (gateResult) {
                    DryRunGateResult.Ready -> ScanOrchestratorResult.DryRunReady
                    is DryRunGateResult.ConfigBlocked -> ScanOrchestratorResult.ConfigBlocked(gateResult.gate)
                    is DryRunGateResult.Blocked -> ScanOrchestratorResult.DryRunBlocked(gateResult.gate)
                }
            }

            // 6. Analyze
            val request = AnalyzeRequest(dataUrl)
            val response = analyzeClient.analyze(request)

            // 7. Map response
            when (response) {
                is FashionAnalyzeResult -> ScanOrchestratorResult.Success(response)
                is NonFashionAnalyzeResult -> ScanOrchestratorResult.Failure(
                    ScanOrchestratorError.NonFashion(response.message)
                )
            }
        } catch (e: AnalyzeException.Disabled) {
            SafeLog.e("ScanOrchestrator", "Real analyze disabled", e)
            ScanOrchestratorResult.Failure(ScanOrchestratorError.BetaDisabled(e.message ?: "Real analyze disabled"))
        } catch (e: AnalyzeException.Timeout) {
            ScanOrchestratorResult.Failure(ScanOrchestratorError.Timeout(e.message ?: "Analysis timed out"))
        } catch (e: AnalyzeException.Network) {
            ScanOrchestratorResult.Failure(ScanOrchestratorError.Network(e.message ?: "Network error"))
        } catch (e: AnalyzeException.HttpError) {
            ScanOrchestratorResult.Failure(ScanOrchestratorError.HttpError(e.status, e.message ?: "Server error"))
        } catch (e: AnalyzeException.MalformedJson) {
            ScanOrchestratorResult.Failure(ScanOrchestratorError.MalformedResponse(e.message ?: "Malformed response"))
        } catch (e: Exception) {
            SafeLog.e("ScanOrchestrator", "Unexpected scan error", e)
            ScanOrchestratorResult.Failure(ScanOrchestratorError.Unknown("Unexpected error occurred"))
        }
    }

    private fun preProcess(input: ScanInput): CompressedPayload {
        // For mock input, just return as-is; production may add resize/compress here
        return CompressedPayload(input.base64, input.mimeType)
    }

    private fun encodeDataUrl(base64: String, mimeType: String): String {
        return "data:$mimeType;base64,$base64"
    }

    data class CompressedPayload(val base64: String, val mimeType: String)
}

sealed class ScanOrchestratorResult {
    data class Success(val result: FashionAnalyzeResult) : ScanOrchestratorResult()
    data class Failure(val error: ScanOrchestratorError) : ScanOrchestratorResult()
    object DryRunReady : ScanOrchestratorResult()
    data class DryRunBlocked(val gate: String) : ScanOrchestratorResult()
    data class ConfigBlocked(val gate: String) : ScanOrchestratorResult()
}

sealed class ScanOrchestratorError(val userMessage: String) {

    /** Stable machine-readable code; never payload-derived. */
    abstract val code: ScanErrorCode

    class PrivacyBlocked(reason: String) : ScanOrchestratorError("Privacy check blocked: $reason") {
        override val code: ScanErrorCode = ScanErrorCode.PRIVACY_BLOCKED
    }

    /**
     * Strict privacy mode was selected but on-device face masking is not
     * implemented in this build. The scan was NOT uploaded. The user message is
     * intentionally fixed and exact — never claim masking occurred and never
     * suggest the scan succeeded.
     */
    class PrivacyUnavailable(val reason: String) : ScanOrchestratorError(
        "Privacy protection is not available in this build. Scan was not uploaded."
    ) {
        override val code: ScanErrorCode = ScanErrorCode.PRIVACY_UNAVAILABLE
    }

    /**
     * The sanitizer's safe output boundary failed. Carries only the
     * deterministic [CompressFailure] classification — never payload text or
     * the raw sanitizer message. The user message is intentionally fixed.
     */
    class ImageProcessingError(val failure: CompressFailure?) :
        ScanOrchestratorError("Image processing failed") {
        override val code: ScanErrorCode = when (failure) {
            CompressFailure.DECODE_FAILED -> ScanErrorCode.IMAGE_DECODE_FAILED
            CompressFailure.ENCODE_FAILED,
            CompressFailure.RECONSTRUCT_FAILED,
            CompressFailure.INVALID_DIMENSIONS
            -> ScanErrorCode.IMAGE_ENCODE_FAILED
            CompressFailure.EMPTY_INPUT -> ScanErrorCode.PAYLOAD_INVALID
            null -> ScanErrorCode.UNKNOWN_SAFE_ERROR
        }
    }

    class EncodeFailure(reason: String) : ScanOrchestratorError("Image encoding failed: $reason") {
        override val code: ScanErrorCode = ScanErrorCode.PAYLOAD_INVALID
    }

    class Timeout(message: String) : ScanOrchestratorError(message) {
        override val code: ScanErrorCode = ScanErrorCode.BACKEND_TIMEOUT
    }

    class Network(message: String) : ScanOrchestratorError(message) {
        override val code: ScanErrorCode = ScanErrorCode.BACKEND_UNAVAILABLE
    }

    class HttpError(val status: Int, message: String) : ScanOrchestratorError(message) {
        override val code: ScanErrorCode = ScanErrorCode.BACKEND_UNAVAILABLE
    }

    class MalformedResponse(message: String) : ScanOrchestratorError(message) {
        override val code: ScanErrorCode = ScanErrorCode.BACKEND_UNAVAILABLE
    }

    class BetaDisabled(message: String) : ScanOrchestratorError(message) {
        override val code: ScanErrorCode = ScanErrorCode.CONFIGURATION_REQUIRED
    }

    class NonFashion(message: String) : ScanOrchestratorError(message) {
        override val code: ScanErrorCode = ScanErrorCode.NON_FASHION
    }

    class Unknown(message: String) : ScanOrchestratorError("Something went wrong: $message") {
        override val code: ScanErrorCode = ScanErrorCode.UNKNOWN_SAFE_ERROR
    }
}

data class ScanInput(
    val base64: String,
    val mimeType: String = "image/jpeg",
)
