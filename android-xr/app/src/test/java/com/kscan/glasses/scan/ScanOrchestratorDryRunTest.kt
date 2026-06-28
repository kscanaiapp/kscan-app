package com.kscan.glasses.scan

import com.kscan.glasses.BuildConfig
import com.kscan.glasses.analyze.AnalyzeClient
import com.kscan.glasses.analyze.AnalyzeClientConfig
import com.kscan.glasses.analyze.AnalyzeRequest
import com.kscan.glasses.analyze.DebugAnalyzeConfig
import com.kscan.glasses.config.BetaConfig
import com.kscan.glasses.mobilebridge.MockMobileAppBridge
import com.kscan.glasses.privacy.MockPrivacyImageSanitizer
import com.kscan.glasses.privacy.PrivacyImageSanitizer
import com.kscan.glasses.privacy.SanitizeResult
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ScanOrchestratorDryRunTest {

    private val dryRunBetaConfig = BetaConfig(
        useMockApi = false,
        enableRealAnalyze = true,
        enableRealFaceMasking = true,
        enableDryRun = true,
    )

    private val dryRunClientConfig = AnalyzeClientConfig(
        backendUrl = "https://example.com",
        enableRealAnalyze = false,
    )

    private val dryRunDebugConfig = DebugAnalyzeConfig(
        enabled = true,
        backendUrl = "https://example.com",
        authToken = "",
        dryRunBuildFlag = true,
    )

    private fun createOrchestrator(
        betaConfig: BetaConfig = dryRunBetaConfig,
        clientConfig: AnalyzeClientConfig = dryRunClientConfig,
        debugConfig: DebugAnalyzeConfig = dryRunDebugConfig,
        sanitizer: PrivacyImageSanitizer = MockPrivacyImageSanitizer(),
        analyzeClient: AnalyzeClient = ThrowingAnalyzeClient(),
    ): ScanOrchestrator {
        return ScanOrchestrator(
            sanitizer = sanitizer,
            analyzeClient = analyzeClient,
            mobileBridge = MockMobileAppBridge(),
            config = betaConfig,
            clientConfig = clientConfig,
            debugConfig = debugConfig,
            ioDispatcher = Dispatchers.Unconfined,
        )
    }

    @Test
    fun `dry-run ready does not call analyze client`() = runTest {
        val orchestrator = createOrchestrator()
        val input = ScanInput(base64 = "mock", mimeType = "image/jpeg")

        val result = orchestrator.run(input)

        if (BuildConfig.DEBUG) {
            assertTrue(result is ScanOrchestratorResult.DryRunReady)
        } else {
            // Release builds always block dry-run wiring at the build gate.
            assertTrue(result is ScanOrchestratorResult.ConfigBlocked)
            assertEquals("release_build", (result as ScanOrchestratorResult.ConfigBlocked).gate)
        }
    }

    @Test
    fun `dry-run blocked when useMockApi is true`() = runTest {
        val orchestrator = createOrchestrator(
            betaConfig = dryRunBetaConfig.copy(useMockApi = true),
        )
        val input = ScanInput(base64 = "mock", mimeType = "image/jpeg")

        val result = orchestrator.run(input)

        assertTrue(result is ScanOrchestratorResult.ConfigBlocked)
        val gate = (result as ScanOrchestratorResult.ConfigBlocked).gate
        assertEquals(if (BuildConfig.DEBUG) "useMockApi" else "release_build", gate)
    }

    @Test
    fun `dry-run blocked when backendUrl is blank`() = runTest {
        val orchestrator = createOrchestrator(
            clientConfig = dryRunClientConfig.copy(backendUrl = ""),
            debugConfig = DebugAnalyzeConfig(backendUrl = ""),
        )
        val input = ScanInput(base64 = "mock", mimeType = "image/jpeg")

        val result = orchestrator.run(input)

        assertTrue(result is ScanOrchestratorResult.ConfigBlocked)
        val gate = (result as ScanOrchestratorResult.ConfigBlocked).gate
        assertEquals(if (BuildConfig.DEBUG) "backend_url_missing" else "release_build", gate)
    }

    @Test
    fun `sanitizer failure prevents dry-run selection`() = runTest {
        val sanitizer = object : PrivacyImageSanitizer {
            override suspend fun sanitize(base64: String, mimeType: String) =
                SanitizeResult.Blocked("face detection failed")
        }
        val orchestrator = createOrchestrator(sanitizer = sanitizer)
        val input = ScanInput(base64 = "mock", mimeType = "image/jpeg")

        val result = orchestrator.run(input)

        // Sanitizer failure is evaluated before the dry-run gate, so it blocks the pipeline
        // regardless of build type.
        assertTrue(result is ScanOrchestratorResult.Failure)
        assertTrue((result as ScanOrchestratorResult.Failure).error is ScanOrchestratorError.PrivacyBlocked)
    }

    @Test
    fun `default config keeps mock path and ignores dry-run`() = runTest {
        val orchestrator = ScanOrchestrator(
            sanitizer = MockPrivacyImageSanitizer(),
            analyzeClient = com.kscan.glasses.analyze.MockAnalyzeClient(),
            mobileBridge = MockMobileAppBridge(),
            config = BetaConfig.DEFAULT,
            ioDispatcher = UnconfinedTestDispatcher(testScheduler),
        )
        val input = ScanInput(base64 = "mock", mimeType = "image/jpeg")

        val result = orchestrator.run(input)

        assertTrue(result is ScanOrchestratorResult.Success)
    }

    /**
     * Stand-in client that would throw if invoked. Dry-run must return before calling it,
     * proving no transport construction or network call can happen.
     */
    private class ThrowingAnalyzeClient : AnalyzeClient {
        override suspend fun analyze(request: AnalyzeRequest): com.kscan.glasses.state.AnalyzeResponse {
            throw AssertionError("AnalyzeClient must not be invoked during dry-run")
        }
    }
}
