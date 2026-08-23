package com.kscan.glasses.runtime

import com.kscan.glasses.analyze.AnalyzeClient
import com.kscan.glasses.analyze.AnalyzeRequest
import com.kscan.glasses.analyze.MockAnalyzeClient
import com.kscan.glasses.bridge.GlassesBridgeProvider
import com.kscan.glasses.bridge.GoogleBridgeProvider
import com.kscan.glasses.bridge.MockBridgeProvider
import com.kscan.glasses.privacy.MockPrivacyImageSanitizer
import com.kscan.glasses.privacy.StrictPrivacyImageSanitizer
import com.kscan.glasses.state.AnalyzeResponse
import com.kscan.glasses.state.NonFashionAnalyzeResult
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RuntimeStateResolverTest {

    private val nonMockBridge: GlassesBridgeProvider = GoogleBridgeProvider()
    private val strictSanitizer = StrictPrivacyImageSanitizer()
    private val nonMockAnalyzeClient: AnalyzeClient = object : AnalyzeClient {
        override suspend fun analyze(request: AnalyzeRequest): AnalyzeResponse =
            NonFashionAnalyzeResult("not reachable in tests")
    }

    // ---------- Instance-driven mapping ----------

    @Test
    fun `mock pipeline maps to MOCK_DEVELOPMENT in debug`() {
        val state = RuntimeStateResolver.resolve(
            bridge = MockBridgeProvider(),
            sanitizer = MockPrivacyImageSanitizer(),
            analyzeClient = MockAnalyzeClient(),
            isDebugBuild = true,
        )
        assertEquals(GlassesRuntimeState.MOCK_DEVELOPMENT, state)
    }

    @Test
    fun `any single mock component marks the runtime as mock`() {
        assertTrue(
            RuntimeStateResolver.isMockRuntime(
                MockBridgeProvider(), strictSanitizer, nonMockAnalyzeClient,
            ),
        )
        assertTrue(
            RuntimeStateResolver.isMockRuntime(
                nonMockBridge, MockPrivacyImageSanitizer(), nonMockAnalyzeClient,
            ),
        )
        assertTrue(
            RuntimeStateResolver.isMockRuntime(
                nonMockBridge, strictSanitizer, MockAnalyzeClient(),
            ),
        )
        assertFalse(
            RuntimeStateResolver.isMockRuntime(
                nonMockBridge, strictSanitizer, nonMockAnalyzeClient,
            ),
        )
    }

    @Test
    fun `strict pipeline with face masking available maps to CONFIGURATION_REQUIRED`() {
        // StrictPrivacyImageSanitizer.isMaskingAvailable is true now
        // (FaceMasker implemented with ML Kit) — uploads are possible,
        // but live analysis is not yet authorized.
        val state = RuntimeStateResolver.resolve(
            bridge = nonMockBridge,
            sanitizer = strictSanitizer,
            analyzeClient = nonMockAnalyzeClient,
            isDebugBuild = false,
        )
        assertEquals(GlassesRuntimeState.CONFIGURATION_REQUIRED, state)
    }

    @Test
    fun `debug strict-privacy profile still reports MOCK while bridge and API are mock`() {
        // The strict sanitizer is real, and the remaining mock components
        // keep the MOCK label on the HUD — both facts stay visible.
        val state = RuntimeStateResolver.resolve(
            bridge = MockBridgeProvider(),
            sanitizer = strictSanitizer,
            analyzeClient = MockAnalyzeClient(),
            isDebugBuild = true,
        )
        assertEquals(GlassesRuntimeState.MOCK_DEVELOPMENT, state)
    }

    // ---------- Capability-driven mapping ----------

    @Test
    fun `no mocks with masking unavailable maps to PRIVACY_BLOCKED`() {
        val state = RuntimeStateResolver.resolve(
            mock = false,
            maskingAvailable = false,
            isDebugBuild = true,
        )
        assertEquals(GlassesRuntimeState.PRIVACY_BLOCKED, state)
    }

    @Test
    fun `no mocks with masking available and no dry-run maps to CONFIGURATION_REQUIRED`() {
        val state = RuntimeStateResolver.resolve(
            mock = false,
            maskingAvailable = true,
            isDebugBuild = true,
            dryRunConfigured = false,
        )
        assertEquals(GlassesRuntimeState.CONFIGURATION_REQUIRED, state)
    }

    @Test
    fun `no mocks with masking available and dry-run configured maps to DRY_RUN_READY`() {
        val state = RuntimeStateResolver.resolve(
            mock = false,
            maskingAvailable = true,
            isDebugBuild = true,
            dryRunConfigured = true,
        )
        assertEquals(GlassesRuntimeState.DRY_RUN_READY, state)
    }

    @Test
    fun `mock in a non-debug build never reports MOCK_DEVELOPMENT`() {
        // Defensive path only: ReleaseSafetyGuard throws before this in real startup.
        val state = RuntimeStateResolver.resolve(
            mock = true,
            maskingAvailable = false,
            isDebugBuild = false,
        )
        assertEquals(GlassesRuntimeState.CONFIGURATION_REQUIRED, state)
    }

    @Test
    fun `LIVE_ANALYSIS_AUTHORIZED is unreachable for every input combination`() {
        for (mock in listOf(true, false)) {
            for (masking in listOf(true, false)) {
                for (isDebug in listOf(true, false)) {
                    for (dryRun in listOf(true, false)) {
                        val state = RuntimeStateResolver.resolve(
                            mock = mock,
                            maskingAvailable = masking,
                            isDebugBuild = isDebug,
                            dryRunConfigured = dryRun,
                        )
                        assertTrue(
                            "LIVE_ANALYSIS_AUTHORIZED must be unreachable in this build " +
                                "(mock=$mock masking=$masking debug=$isDebug dryRun=$dryRun)",
                            state != GlassesRuntimeState.LIVE_ANALYSIS_AUTHORIZED,
                        )
                    }
                }
            }
        }
    }
}
