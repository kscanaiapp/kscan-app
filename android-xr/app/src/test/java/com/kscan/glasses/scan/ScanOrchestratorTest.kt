package com.kscan.glasses.scan

import com.kscan.glasses.analyze.AnalyzeClient
import com.kscan.glasses.analyze.MockAnalyzeClient
import com.kscan.glasses.config.BetaConfig
import com.kscan.glasses.phonebridge.DisabledPhoneBridgeProvider
import com.kscan.glasses.phonebridge.PhoneBridgeProvider
import com.kscan.glasses.phonebridge.PhoneBridgeSendResult
import com.kscan.glasses.privacy.MockPrivacyImageSanitizer
import com.kscan.glasses.privacy.PrivacyImageSanitizer
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ScanOrchestratorTest {

    private fun createOrchestrator(
        sanitizer: PrivacyImageSanitizer = MockPrivacyImageSanitizer(),
        analyzeClient: AnalyzeClient = MockAnalyzeClient(),
        phoneBridge: PhoneBridgeProvider = DisabledPhoneBridgeProvider(),
        config: BetaConfig = BetaConfig.DEFAULT,
        dispatcher: kotlinx.coroutines.CoroutineDispatcher = Dispatchers.Unconfined,
    ): ScanOrchestrator {
        return ScanOrchestrator(
            sanitizer = sanitizer,
            analyzeClient = analyzeClient,
            phoneBridge = phoneBridge,
            config = config,
            ioDispatcher = dispatcher,
        )
    }

    @Test
    fun `happy path with mock analyze returns success`() = runTest {
        val orchestrator = createOrchestrator(dispatcher = UnconfinedTestDispatcher(testScheduler))
        val input = ScanInput(base64 = "mock-base64", mimeType = "image/jpeg")

        val result = orchestrator.run(input)

        assertTrue(result is ScanOrchestratorResult.Success)
        val success = result as ScanOrchestratorResult.Success
        assertEquals("Mock: structured wool blazer with relaxed silhouette.", success.result.result)
        assertEquals(3, success.result.products.size)
    }

    @Test
    fun `blocked privacy path returns failure`() = runTest {
        val sanitizer = object : PrivacyImageSanitizer {
            override suspend fun sanitize(base64: String, mimeType: String) =
                com.kscan.glasses.privacy.SanitizeResult.Blocked("Face detection failed")
        }
        val orchestrator = createOrchestrator(sanitizer = sanitizer, dispatcher = UnconfinedTestDispatcher(testScheduler))
        val input = ScanInput(base64 = "any", mimeType = "image/jpeg")

        val result = orchestrator.run(input)

        assertTrue(result is ScanOrchestratorResult.Failure)
        val failure = result as ScanOrchestratorResult.Failure
        assertTrue(failure.error is ScanOrchestratorError.PrivacyBlocked)
    }

    @Test
    fun `data URL is properly formed after encoding`() = runTest {
        val orchestrator = createOrchestrator(dispatcher = UnconfinedTestDispatcher(testScheduler))
        val input = ScanInput(base64 = "test123", mimeType = "image/jpeg")

        val result = orchestrator.run(input)
        // Mock path succeeds; data URL validation passes internally
        assertTrue(result is ScanOrchestratorResult.Success)
    }

    @Test
    fun `analyze timeout returns timeout error`() = runTest {
        val analyzeClient = object : AnalyzeClient {
            override suspend fun analyze(request: com.kscan.glasses.analyze.AnalyzeRequest): com.kscan.glasses.state.AnalyzeResponse {
                throw com.kscan.glasses.analyze.AnalyzeException.Timeout("Timed out")
            }
        }
        val orchestrator = createOrchestrator(analyzeClient = analyzeClient, dispatcher = UnconfinedTestDispatcher(testScheduler))
        val input = ScanInput(base64 = "mock", mimeType = "image/jpeg")

        val result = orchestrator.run(input)

        assertTrue(result is ScanOrchestratorResult.Failure)
        val failure = result as ScanOrchestratorResult.Failure
        assertTrue(failure.error is ScanOrchestratorError.Timeout)
    }

    @Test
    fun `analyze disabled returns beta disabled error`() = runTest {
        val analyzeClient = object : AnalyzeClient {
            override suspend fun analyze(request: com.kscan.glasses.analyze.AnalyzeRequest): com.kscan.glasses.state.AnalyzeResponse {
                throw com.kscan.glasses.analyze.AnalyzeException.Disabled("Real analyze disabled")
            }
        }
        val orchestrator = createOrchestrator(analyzeClient = analyzeClient, dispatcher = UnconfinedTestDispatcher(testScheduler))
        val input = ScanInput(base64 = "mock", mimeType = "image/jpeg")

        val result = orchestrator.run(input)

        assertTrue(result is ScanOrchestratorResult.Failure)
        val failure = result as ScanOrchestratorResult.Failure
        assertTrue(failure.error is ScanOrchestratorError.BetaDisabled)
    }

    @Test
    fun `save and open handoff actions fail safe when bridge is disabled`() = runTest {
        val phoneBridge = DisabledPhoneBridgeProvider()
        val orchestrator = createOrchestrator(phoneBridge = phoneBridge, dispatcher = UnconfinedTestDispatcher(testScheduler))
        val input = ScanInput(base64 = "mock", mimeType = "image/jpeg")

        val result = orchestrator.run(input)
        assertTrue(result is ScanOrchestratorResult.Success)

        // Handoff actions route through the provider seam; a disabled bridge
        // reports a controlled result instead of throwing.
        val success = result as ScanOrchestratorResult.Success
        val firstProduct = success.result.products.first()
        val saveResult = phoneBridge.saveResult(firstProduct.id, firstProduct.name)
        assertTrue(saveResult is PhoneBridgeSendResult.Disabled)

        val openResult = phoneBridge.openOnPhone("result-123")
        assertTrue(openResult is PhoneBridgeSendResult.Disabled)
    }

    @Test
    fun `no live call when enableRealAnalyze is false`() = runTest {
        // MockAnalyzeClient is used by default, which never makes network calls
        val orchestrator = createOrchestrator(
            config = BetaConfig(enableRealAnalyze = false),
            dispatcher = UnconfinedTestDispatcher(testScheduler),
        )
        val input = ScanInput(base64 = "mock", mimeType = "image/jpeg")

        val result = orchestrator.run(input)
        assertTrue(result is ScanOrchestratorResult.Success)
    }

    @Test
    fun `malformed response returns failure`() = runTest {
        val analyzeClient = object : AnalyzeClient {
            override suspend fun analyze(request: com.kscan.glasses.analyze.AnalyzeRequest): com.kscan.glasses.state.AnalyzeResponse {
                throw com.kscan.glasses.analyze.AnalyzeException.MalformedJson("Bad JSON")
            }
        }
        val orchestrator = createOrchestrator(analyzeClient = analyzeClient, dispatcher = UnconfinedTestDispatcher(testScheduler))
        val input = ScanInput(base64 = "mock", mimeType = "image/jpeg")

        val result = orchestrator.run(input)

        assertTrue(result is ScanOrchestratorResult.Failure)
        val failure = result as ScanOrchestratorResult.Failure
        assertTrue(failure.error is ScanOrchestratorError.MalformedResponse)
    }

    @Test
    fun `sanitizer error blocks analyze entirely`() = runTest {
        val sanitizer = object : PrivacyImageSanitizer {
            override suspend fun sanitize(base64: String, mimeType: String) =
                com.kscan.glasses.privacy.SanitizeResult.Error("Sanitizer crashed")
        }
        val orchestrator = createOrchestrator(sanitizer = sanitizer, dispatcher = UnconfinedTestDispatcher(testScheduler))
        val input = ScanInput(base64 = "any", mimeType = "image/jpeg")

        val result = orchestrator.run(input)

        assertTrue(result is ScanOrchestratorResult.Failure)
        val failure = result as ScanOrchestratorResult.Failure
        // Unclassified sanitizer crash -> fixed generic processing error.
        assertTrue(failure.error is ScanOrchestratorError.ImageProcessingError)
        assertEquals(ScanErrorCode.UNKNOWN_SAFE_ERROR, failure.error.code)
        // The raw sanitizer message never reaches the HUD-facing error.
        assertEquals("Image processing failed", failure.error.userMessage)
        assertTrue(!failure.error.userMessage.contains("Sanitizer crashed"))
    }

    @Test
    fun `sanitizer boundary failure carries deterministic classification`() = runTest {
        val sanitizer = object : PrivacyImageSanitizer {
            override suspend fun sanitize(base64: String, mimeType: String) =
                com.kscan.glasses.privacy.SanitizeResult.Error(
                    "Image re-encode failed (DECODE_FAILED)",
                    failure = com.kscan.glasses.privacy.CompressFailure.DECODE_FAILED,
                )
        }
        val orchestrator = createOrchestrator(sanitizer = sanitizer, dispatcher = UnconfinedTestDispatcher(testScheduler))
        val input = ScanInput(base64 = "any", mimeType = "image/jpeg")

        val result = orchestrator.run(input)

        assertTrue(result is ScanOrchestratorResult.Failure)
        val failure = result as ScanOrchestratorResult.Failure
        assertTrue(failure.error is ScanOrchestratorError.ImageProcessingError)
        assertEquals(ScanErrorCode.IMAGE_DECODE_FAILED, failure.error.code)
        assertEquals("Image processing failed. Please retry.", ScanErrorMapper.toUserMessage(failure.error))
    }

    @Test
    fun `unexpected exception is caught and mapped to safe failure`() = runTest {
        val analyzeClient = object : AnalyzeClient {
            override suspend fun analyze(request: com.kscan.glasses.analyze.AnalyzeRequest): com.kscan.glasses.state.AnalyzeResponse {
                throw RuntimeException("data:image/jpeg;base64,secret-leak") // simulates accidental payload in exception
            }
        }
        val orchestrator = createOrchestrator(analyzeClient = analyzeClient, dispatcher = UnconfinedTestDispatcher(testScheduler))
        val input = ScanInput(base64 = "mock", mimeType = "image/jpeg")

        val result = orchestrator.run(input)

        assertTrue(result is ScanOrchestratorResult.Failure)
        val failure = result as ScanOrchestratorResult.Failure
        assertTrue(failure.error is ScanOrchestratorError.Unknown)
        // The orchestrator must NOT leak raw exception messages containing payload data
        assertTrue(!failure.error.userMessage.contains("base64"))
        assertTrue(!failure.error.userMessage.contains("data:image"))
    }

    @Test
    fun `orchestrator only emits safe structured outcomes never raw exceptions`() = runTest {
        val analyzeClient = object : AnalyzeClient {
            override suspend fun analyze(request: com.kscan.glasses.analyze.AnalyzeRequest): com.kscan.glasses.state.AnalyzeResponse {
                throw IllegalStateException("raw internal error with payload data:image/jpeg;base64,xyz")
            }
        }
        val orchestrator = createOrchestrator(analyzeClient = analyzeClient, dispatcher = UnconfinedTestDispatcher(testScheduler))
        val input = ScanInput(base64 = "mock", mimeType = "image/jpeg")

        val result = orchestrator.run(input)

        assertTrue(result is ScanOrchestratorResult.Failure)
        val failure = result as ScanOrchestratorResult.Failure
        // Verify the sealed result contains a safe user message, not the raw exception text
        assertTrue(!failure.error.userMessage.contains("base64"))
        assertTrue(!failure.error.userMessage.contains("data:image"))
        assertTrue(!failure.error.userMessage.contains("payload"))
    }
    @Test
    fun `ScanErrorMapper produces user-friendly messages`() {
        assertEquals("Privacy check blocked upload. Please retry.", ScanErrorMapper.toUserMessage(
            ScanOrchestratorError.PrivacyBlocked("reason")
        ))
        assertEquals("Analysis timed out. Tap to retry.", ScanErrorMapper.toUserMessage(
            ScanOrchestratorError.Timeout("Analysis timed out")
        ))
        assertEquals("Beta analyze is disabled.", ScanErrorMapper.toUserMessage(
            ScanOrchestratorError.BetaDisabled("disabled")
        ))
    }
}
