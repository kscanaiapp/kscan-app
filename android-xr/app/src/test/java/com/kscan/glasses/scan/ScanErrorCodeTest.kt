package com.kscan.glasses.scan

import com.kscan.glasses.analyze.AnalyzeException
import com.kscan.glasses.privacy.CompressFailure
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

/**
 * Verifies the stable error-code contract: every orchestrator error carries a
 * deterministic, payload-free [ScanErrorCode], and HUD messages stay fixed
 * regardless of raw internal detail.
 */
class ScanErrorCodeTest {

    @Test
    fun `every error subclass maps to its stable code`() {
        assertEquals(ScanErrorCode.PRIVACY_BLOCKED, ScanOrchestratorError.PrivacyBlocked("r").code)
        assertEquals(ScanErrorCode.PRIVACY_UNAVAILABLE, ScanOrchestratorError.PrivacyUnavailable("r").code)
        assertEquals(ScanErrorCode.PAYLOAD_INVALID, ScanOrchestratorError.EncodeFailure("r").code)
        assertEquals(ScanErrorCode.BACKEND_TIMEOUT, ScanOrchestratorError.Timeout("m").code)
        assertEquals(ScanErrorCode.BACKEND_UNAVAILABLE, ScanOrchestratorError.Network("m").code)
        assertEquals(ScanErrorCode.BACKEND_UNAVAILABLE, ScanOrchestratorError.HttpError(500, "m").code)
        assertEquals(ScanErrorCode.BACKEND_UNAVAILABLE, ScanOrchestratorError.MalformedResponse("m").code)
        assertEquals(ScanErrorCode.CONFIGURATION_REQUIRED, ScanOrchestratorError.BetaDisabled("m").code)
        assertEquals(ScanErrorCode.NON_FASHION, ScanOrchestratorError.NonFashion("m").code)
        assertEquals(ScanErrorCode.UNKNOWN_SAFE_ERROR, ScanOrchestratorError.Unknown("m").code)
    }

    @Test
    fun `image processing error maps compress failure classification`() {
        assertEquals(
            ScanErrorCode.IMAGE_DECODE_FAILED,
            ScanOrchestratorError.ImageProcessingError(CompressFailure.DECODE_FAILED).code,
        )
        assertEquals(
            ScanErrorCode.IMAGE_ENCODE_FAILED,
            ScanOrchestratorError.ImageProcessingError(CompressFailure.ENCODE_FAILED).code,
        )
        assertEquals(
            ScanErrorCode.IMAGE_ENCODE_FAILED,
            ScanOrchestratorError.ImageProcessingError(CompressFailure.RECONSTRUCT_FAILED).code,
        )
        assertEquals(
            ScanErrorCode.IMAGE_ENCODE_FAILED,
            ScanOrchestratorError.ImageProcessingError(CompressFailure.INVALID_DIMENSIONS).code,
        )
        assertEquals(
            ScanErrorCode.PAYLOAD_INVALID,
            ScanOrchestratorError.ImageProcessingError(CompressFailure.EMPTY_INPUT).code,
        )
        assertEquals(
            ScanErrorCode.UNKNOWN_SAFE_ERROR,
            ScanOrchestratorError.ImageProcessingError(null).code,
        )
    }

    @Test
    fun `mapper produces fixed hud messages for processing and backend errors`() {
        assertEquals(
            "Image processing failed. Please retry.",
            ScanErrorMapper.toUserMessage(ScanOrchestratorError.ImageProcessingError(CompressFailure.DECODE_FAILED)),
        )
        assertEquals(
            "Connection issue. Check network and retry.",
            ScanErrorMapper.toUserMessage(ScanOrchestratorError.Network("raw host 10.0.2.2 refused")),
        )
        assertEquals(
            "Server error (500). Please retry.",
            ScanErrorMapper.toUserMessage(ScanOrchestratorError.HttpError(500, "raw")),
        )
    }

    @Test
    fun `mapper maps low-level exceptions to coded errors`() {
        val timeout = ScanErrorMapper.map(AnalyzeException.Timeout("t"))
        assertEquals(ScanErrorCode.BACKEND_TIMEOUT, timeout.code)

        val unknown = ScanErrorMapper.map(RuntimeException("raw internals"))
        assertEquals(ScanErrorCode.UNKNOWN_SAFE_ERROR, unknown.code)
    }

    @Test
    fun `processing error user message never carries raw sanitizer text`() {
        val error = ScanOrchestratorError.ImageProcessingError(CompressFailure.ENCODE_FAILED)
        assertEquals("Image processing failed", error.userMessage)
        assertFalse(error.userMessage.contains("ENCODE_FAILED"))
        assertFalse(ScanErrorMapper.toUserMessage(error).contains("ENCODE_FAILED"))
    }
}
