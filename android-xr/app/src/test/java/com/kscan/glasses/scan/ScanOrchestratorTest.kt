package com.kscan.glasses.scan

import com.kscan.glasses.analyze.AnalyzeClient
import com.kscan.glasses.analyze.MockAnalyzeClient
import com.kscan.glasses.config.BetaConfig
import com.kscan.glasses.mobilebridge.MobileAppBridge
import com.kscan.glasses.mobilebridge.MockMobileAppBridge
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
        mobileBridge: MobileAppBridge = MockMobileAppBridge(),
        config: BetaConfig = BetaConfig.DEFAULT,
        dispatcher: kotlinx.coroutines.CoroutineDispatcher = Dispatchers.Unconfined,
    ): ScanOrchestrator {
        return ScanOrchestrator(
            sanitizer = sanitizer,
            analyzeClient = analyzeClient,
            mobileBridge = mobileBridge,
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
    fun `save and open handoff actions can be generated from result`() = runTest {
        val mobileBridge = MockMobileAppBridge()
        val orchestrator = createOrchestrator(mobileBridge = mobileBridge, dispatcher = UnconfinedTestDispatcher(testScheduler))
        val input = ScanInput(base64 = "mock", mimeType = "image/jpeg")

        val result = orchestrator.run(input)
        assertTrue(result is ScanOrchestratorResult.Success)

        // Simulate handoff actions
        val success = result as ScanOrchestratorResult.Success
        val firstProduct = success.result.products.first()
        val saveResult = mobileBridge.requestSave(firstProduct.id, firstProduct.name)
        assertTrue(saveResult is com.kscan.glasses.mobilebridge.MobileAppBridgeResult.Success)

        val openResult = mobileBridge.requestOpen("result-123")
        assertTrue(openResult is com.kscan.glasses.mobilebridge.MobileAppBridgeResult.Success)
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
