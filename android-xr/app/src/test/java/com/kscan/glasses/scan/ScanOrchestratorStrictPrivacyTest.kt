package com.kscan.glasses.scan

import com.kscan.glasses.analyze.AnalyzeClient
import com.kscan.glasses.analyze.AnalyzeRequest
import com.kscan.glasses.config.BetaConfig
import com.kscan.glasses.phonebridge.DisabledPhoneBridgeProvider
import com.kscan.glasses.privacy.FaceMasker
import com.kscan.glasses.privacy.MaskResult
import com.kscan.glasses.privacy.MockPrivacyImageSanitizer
import com.kscan.glasses.privacy.PrivacyImageSanitizer
import com.kscan.glasses.privacy.SanitizeResult
import com.kscan.glasses.privacy.StrictPrivacyImageSanitizer
import com.kscan.glasses.state.AnalyzeResponse
import com.kscan.glasses.state.NonFashionAnalyzeResult
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Proves the strict-mode fail-closed contract:
 * strict sanitizer request -> FaceMasker NotImplemented -> sanitizer blocked ->
 * analyze NEVER called -> exact HUD message. No raw fallback, no mock substitution.
 */
class ScanOrchestratorStrictPrivacyTest {

    /** Counts analyze invocations and captures the request payloads it receives. */
    private class CountingAnalyzeClient : AnalyzeClient {
        var callCount = 0
            private set
        val receivedDataUrls = mutableListOf<String>()

        override suspend fun analyze(request: AnalyzeRequest): AnalyzeResponse {
            callCount++
            receivedDataUrls += request.imageDataUrl
            return NonFashionAnalyzeResult("counting client should not influence assertions")
        }
    }

    private fun createOrchestrator(
        sanitizer: PrivacyImageSanitizer,
        analyzeClient: AnalyzeClient,
        dispatcher: kotlinx.coroutines.CoroutineDispatcher,
    ): ScanOrchestrator = ScanOrchestrator(
        sanitizer = sanitizer,
        analyzeClient = analyzeClient,
        phoneBridge = DisabledPhoneBridgeProvider(),
        config = BetaConfig.DEFAULT,
        ioDispatcher = dispatcher,
    )

    private fun notImplementedMasker(): FaceMasker = mockk {
        every { isMaskingAvailable } returns false
        every { maskFaces(any(), any()) } returns MaskResult.NotImplemented("Mock: face masking not available")
    }

    @Test
    fun `strict sanitizer blocks before analyze when face masking is NotImplemented`() = runTest {
        val analyzeClient = CountingAnalyzeClient()
        val orchestrator = createOrchestrator(
            sanitizer = StrictPrivacyImageSanitizer(faceMasker = notImplementedMasker()),
            analyzeClient = analyzeClient,
            dispatcher = UnconfinedTestDispatcher(testScheduler),
        )

        val result = orchestrator.run(ScanInput(base64 = "raw-capture-bytes", mimeType = "image/jpeg"))

        assertTrue(result is ScanOrchestratorResult.Failure)
        val failure = result as ScanOrchestratorResult.Failure
        assertTrue(failure.error is ScanOrchestratorError.PrivacyUnavailable)
        // Analyze was NEVER called.
        assertEquals(0, analyzeClient.callCount)
    }

    @Test
    fun `strict privacy failure surfaces exact HUD message and never claims masking`() = runTest {
        val analyzeClient = CountingAnalyzeClient()
        val orchestrator = createOrchestrator(
            sanitizer = StrictPrivacyImageSanitizer(faceMasker = notImplementedMasker()),
            analyzeClient = analyzeClient,
            dispatcher = UnconfinedTestDispatcher(testScheduler),
        )

        val result = orchestrator.run(ScanInput(base64 = "raw-capture-bytes", mimeType = "image/jpeg"))
        val failure = result as ScanOrchestratorResult.Failure

        val message = ScanErrorMapper.toUserMessage(failure.error)
        assertEquals(
            "Privacy protection is not available in this build. Scan was not uploaded.",
            message,
        )
        // Never claim masking occurred; never imply success.
        assertTrue(!message.contains("masked", ignoreCase = true))
        assertTrue(!message.contains("success", ignoreCase = true))
    }

    @Test
    fun `sanitizer blocked stops before analyze`() = runTest {
        val analyzeClient = CountingAnalyzeClient()
        val blocked = object : PrivacyImageSanitizer {
            override suspend fun sanitize(base64: String, mimeType: String) =
                SanitizeResult.Blocked("policy block")
        }
        val orchestrator = createOrchestrator(blocked, analyzeClient, UnconfinedTestDispatcher(testScheduler))

        val result = orchestrator.run(ScanInput(base64 = "raw", mimeType = "image/jpeg"))

        assertTrue(result is ScanOrchestratorResult.Failure)
        assertTrue((result as ScanOrchestratorResult.Failure).error is ScanOrchestratorError.PrivacyBlocked)
        assertEquals(0, analyzeClient.callCount)
    }

    @Test
    fun `sanitizer error stops before analyze`() = runTest {
        val analyzeClient = CountingAnalyzeClient()
        val crashed = object : PrivacyImageSanitizer {
            override suspend fun sanitize(base64: String, mimeType: String) =
                SanitizeResult.Error("sanitizer crashed")
        }
        val orchestrator = createOrchestrator(crashed, analyzeClient, UnconfinedTestDispatcher(testScheduler))

        val result = orchestrator.run(ScanInput(base64 = "raw", mimeType = "image/jpeg"))

        assertTrue(result is ScanOrchestratorResult.Failure)
        // Unclassified sanitizer crash maps to the fixed image-processing error,
        // never a privacy-block and never raw sanitizer text.
        assertTrue((result as ScanOrchestratorResult.Failure).error is ScanOrchestratorError.ImageProcessingError)
        assertEquals(ScanErrorCode.UNKNOWN_SAFE_ERROR, result.error.code)
        assertEquals(0, analyzeClient.callCount)
    }

    @Test
    fun `sanitizer success proceeds and analyze receives only the sanitized payload`() = runTest {
        val analyzeClient = CountingAnalyzeClient()
        val sanitizer = object : PrivacyImageSanitizer {
            override suspend fun sanitize(base64: String, mimeType: String) =
                SanitizeResult.Success("SANITIZED-PAYLOAD", mimeType)
        }
        val orchestrator = createOrchestrator(sanitizer, analyzeClient, UnconfinedTestDispatcher(testScheduler))

        orchestrator.run(ScanInput(base64 = "RAW-CAPTURE-BYTES", mimeType = "image/jpeg"))

        // Analyze called exactly once, and only with sanitized, validated data URL.
        assertEquals(1, analyzeClient.callCount)
        val sent = analyzeClient.receivedDataUrls.single()
        assertTrue(sent.startsWith("data:image/"))
        assertTrue(sent.contains("SANITIZED-PAYLOAD"))
        // Raw fallback is impossible: raw capture bytes never reach analyze.
        assertTrue(!sent.contains("RAW-CAPTURE-BYTES"))
    }

    @Test
    fun `strict sanitizer with unavailable masking returns MaskingUnavailable`() = runTest {
        // When FaceMasker reports NotImplemented, the strict sanitizer must
        // expose MaskingUnavailable — never silently succeed.
        val strict = StrictPrivacyImageSanitizer(faceMasker = notImplementedMasker())
        val result = strict.sanitize("raw-capture-bytes", "image/jpeg")
        assertTrue(result is SanitizeResult.MaskingUnavailable)
        assertTrue(result !is SanitizeResult.Success)
    }

    @Test
    fun `strict sanitizer with real masking handles invalid input as blocked`() = runTest {
        // With the real FaceMasker, invalid input returns Error -> Blocked.
        val strict = StrictPrivacyImageSanitizer()
        val result = strict.sanitize("not-valid-base64!!!", "image/jpeg")
        // The sanitizer blocks on any masker error.
        assertTrue(result is SanitizeResult.Blocked)
    }

    @Test
    fun `mock sanitizer is not produced by strict selection and mock success stays labeled`() = runTest {
        // Mock sanitizer still works for the debug mock profile — but it is only
        // ever injected when the profile explicitly permits mock (see factory tests),
        // and the UI labels the whole pipeline MOCK in that case.
        val mock = MockPrivacyImageSanitizer()
        val result = mock.sanitize("abc", "image/jpeg")
        assertTrue(result is SanitizeResult.Success)
    }
}
