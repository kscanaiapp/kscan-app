package com.kscan.glasses.safety

import com.kscan.glasses.analyze.AnalyzeClient
import com.kscan.glasses.analyze.AnalyzeRequest
import com.kscan.glasses.analyze.MockAnalyzeClient
import com.kscan.glasses.bridge.GlassesBridgeProvider
import com.kscan.glasses.bridge.GoogleBridgeProvider
import com.kscan.glasses.bridge.MockBridgeProvider
import com.kscan.glasses.privacy.MockPrivacyImageSanitizer
import com.kscan.glasses.privacy.PrivacyImageSanitizer
import com.kscan.glasses.privacy.StrictPrivacyImageSanitizer
import com.kscan.glasses.state.AnalyzeResponse
import com.kscan.glasses.state.NonFashionAnalyzeResult
import org.junit.Assert.assertTrue
import org.junit.Test

class ReleaseSafetyGuardTest {

    private val realBridge: GlassesBridgeProvider = GoogleBridgeProvider()
    private val strictSanitizer: PrivacyImageSanitizer = StrictPrivacyImageSanitizer()
    private val nonMockAnalyzeClient: AnalyzeClient = object : AnalyzeClient {
        override suspend fun analyze(request: AnalyzeRequest): AnalyzeResponse =
            NonFashionAnalyzeResult("not reachable in tests")
    }

    // ---------- Flag-level checks ----------

    @Test
    fun `debug mock profile is allowed`() {
        // Must not throw: debug builds may run fully mocked for local development.
        ReleaseSafetyGuard.verify(
            isDebugBuild = true,
            useMockApi = true,
            useMockSanitizer = true,
            useMockBridge = true,
        )
    }

    @Test
    fun `release with all strict flags passes`() {
        ReleaseSafetyGuard.verify(
            isDebugBuild = false,
            useMockApi = false,
            useMockSanitizer = false,
            useMockBridge = false,
        )
    }

    @Test(expected = IllegalStateException::class)
    fun `release mock API flag is rejected`() {
        ReleaseSafetyGuard.verify(
            isDebugBuild = false,
            useMockApi = true,
            useMockSanitizer = false,
            useMockBridge = false,
        )
    }

    @Test(expected = IllegalStateException::class)
    fun `release mock sanitizer flag is rejected`() {
        ReleaseSafetyGuard.verify(
            isDebugBuild = false,
            useMockApi = false,
            useMockSanitizer = true,
            useMockBridge = false,
        )
    }

    @Test(expected = IllegalStateException::class)
    fun `release mock bridge flag is rejected`() {
        ReleaseSafetyGuard.verify(
            isDebugBuild = false,
            useMockApi = false,
            useMockSanitizer = false,
            useMockBridge = true,
        )
    }

    // ---------- Instance-level checks ----------

    @Test
    fun `release with strict instances passes dependency verification`() {
        ReleaseSafetyGuard.verifyDependencies(
            bridge = realBridge,
            sanitizer = strictSanitizer,
            analyzeClient = nonMockAnalyzeClient,
            isDebugBuild = false,
            useMockApi = false,
            useMockSanitizer = false,
            useMockBridge = false,
        )
    }

    @Test(expected = IllegalStateException::class)
    fun `release cannot silently fall back to mock analyze client instance`() {
        ReleaseSafetyGuard.verifyDependencies(
            bridge = realBridge,
            sanitizer = strictSanitizer,
            analyzeClient = MockAnalyzeClient(),
            isDebugBuild = false,
            useMockApi = false,
            useMockSanitizer = false,
            useMockBridge = false,
        )
    }

    @Test(expected = IllegalStateException::class)
    fun `release cannot silently fall back to mock sanitizer instance`() {
        ReleaseSafetyGuard.verifyDependencies(
            bridge = realBridge,
            sanitizer = MockPrivacyImageSanitizer(),
            analyzeClient = nonMockAnalyzeClient,
            isDebugBuild = false,
            useMockApi = false,
            useMockSanitizer = false,
            useMockBridge = false,
        )
    }

    @Test(expected = IllegalStateException::class)
    fun `release cannot silently fall back to mock bridge instance`() {
        ReleaseSafetyGuard.verifyDependencies(
            bridge = MockBridgeProvider(),
            sanitizer = strictSanitizer,
            analyzeClient = nonMockAnalyzeClient,
            isDebugBuild = false,
            useMockApi = false,
            useMockSanitizer = false,
            useMockBridge = false,
        )
    }

    @Test(expected = IllegalStateException::class)
    fun `strict sanitizer flag with mock sanitizer instance fails fast`() {
        ReleaseSafetyGuard.verifyDependencies(
            bridge = MockBridgeProvider(),
            sanitizer = MockPrivacyImageSanitizer(),
            analyzeClient = MockAnalyzeClient(),
            isDebugBuild = true,
            useMockApi = true,
            useMockSanitizer = false, // flag claims strict; instance is mock
            useMockBridge = true,
        )
    }

    @Test(expected = IllegalStateException::class)
    fun `strict api flag with mock analyze client instance fails fast`() {
        ReleaseSafetyGuard.verifyDependencies(
            bridge = MockBridgeProvider(),
            sanitizer = MockPrivacyImageSanitizer(),
            analyzeClient = MockAnalyzeClient(),
            isDebugBuild = true,
            useMockApi = false, // flag claims strict; instance is mock
            useMockSanitizer = true,
            useMockBridge = true,
        )
    }

    @Test(expected = IllegalStateException::class)
    fun `strict bridge flag with mock bridge instance fails fast`() {
        ReleaseSafetyGuard.verifyDependencies(
            bridge = MockBridgeProvider(),
            sanitizer = MockPrivacyImageSanitizer(),
            analyzeClient = MockAnalyzeClient(),
            isDebugBuild = true,
            useMockApi = true,
            useMockSanitizer = true,
            useMockBridge = false, // flag claims strict; instance is mock
        )
    }

    @Test
    fun `debug mock profile with mock instances passes dependency verification`() {
        ReleaseSafetyGuard.verifyDependencies(
            bridge = MockBridgeProvider(),
            sanitizer = MockPrivacyImageSanitizer(),
            analyzeClient = MockAnalyzeClient(),
            isDebugBuild = true,
            useMockApi = true,
            useMockSanitizer = true,
            useMockBridge = true,
        )
    }

    @Test
    fun `debug strict-privacy profile with strict sanitizer instance passes`() {
        // Mock bridge/API are still permitted by their flags; only the sanitizer
        // is strict in this profile.
        ReleaseSafetyGuard.verifyDependencies(
            bridge = MockBridgeProvider(),
            sanitizer = strictSanitizer,
            analyzeClient = MockAnalyzeClient(),
            isDebugBuild = true,
            useMockApi = true,
            useMockSanitizer = false,
            useMockBridge = true,
        )
        assertTrue(true)
    }
}
