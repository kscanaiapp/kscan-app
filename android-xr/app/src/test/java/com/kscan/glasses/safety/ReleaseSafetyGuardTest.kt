package com.kscan.glasses.safety

import com.kscan.glasses.analyze.AnalyzeClient
import com.kscan.glasses.analyze.AnalyzeRequest
import com.kscan.glasses.analyze.MockAnalyzeClient
import com.kscan.glasses.bridge.GlassesBridgeProvider
import com.kscan.glasses.bridge.GoogleBridgeProvider
import com.kscan.glasses.bridge.MockBridgeProvider
import com.kscan.glasses.phonebridge.DisabledPhoneBridgeProvider
import com.kscan.glasses.phonebridge.FutureRealPhoneBridgeProvider
import com.kscan.glasses.phonebridge.mock.MockPhoneBridgeProvider
import com.kscan.glasses.privacy.MockPrivacyImageSanitizer
import com.kscan.glasses.privacy.PrivacyImageSanitizer
import com.kscan.glasses.privacy.StrictPrivacyImageSanitizer
import com.kscan.glasses.state.AnalyzeResponse
import com.kscan.glasses.state.NonFashionAnalyzeResult
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.test.UnconfinedTestDispatcher
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
            useMockPhoneBridge = true,
        )
    }

    @Test
    fun `release with all strict flags passes`() {
        ReleaseSafetyGuard.verify(
            isDebugBuild = false,
            useMockApi = false,
            useMockSanitizer = false,
            useMockBridge = false,
            useMockPhoneBridge = false,
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

    @Test(expected = IllegalStateException::class)
    fun `release mock phone bridge flag is rejected`() {
        ReleaseSafetyGuard.verify(
            isDebugBuild = false,
            useMockApi = false,
            useMockSanitizer = false,
            useMockBridge = false,
            useMockPhoneBridge = true,
        )
    }

    // ---------- Instance-level checks ----------

    @Test
    fun `release with strict instances passes dependency verification`() {
        ReleaseSafetyGuard.verifyDependencies(
            bridge = realBridge,
            sanitizer = strictSanitizer,
            analyzeClient = nonMockAnalyzeClient,
            phoneBridge = FutureRealPhoneBridgeProvider(),
            isDebugBuild = false,
            useMockApi = false,
            useMockSanitizer = false,
            useMockBridge = false,
            useMockPhoneBridge = false,
        )
    }

    @Test(expected = IllegalStateException::class)
    fun `release cannot silently fall back to mock analyze client instance`() {
        ReleaseSafetyGuard.verifyDependencies(
            bridge = realBridge,
            sanitizer = strictSanitizer,
            analyzeClient = MockAnalyzeClient(),
            phoneBridge = FutureRealPhoneBridgeProvider(),
            isDebugBuild = false,
            useMockApi = false,
            useMockSanitizer = false,
            useMockBridge = false,
            useMockPhoneBridge = false,
        )
    }

    @Test(expected = IllegalStateException::class)
    fun `release cannot silently fall back to mock sanitizer instance`() {
        ReleaseSafetyGuard.verifyDependencies(
            bridge = realBridge,
            sanitizer = MockPrivacyImageSanitizer(),
            analyzeClient = nonMockAnalyzeClient,
            phoneBridge = FutureRealPhoneBridgeProvider(),
            isDebugBuild = false,
            useMockApi = false,
            useMockSanitizer = false,
            useMockBridge = false,
            useMockPhoneBridge = false,
        )
    }

    @Test(expected = IllegalStateException::class)
    fun `release cannot silently fall back to mock bridge instance`() {
        ReleaseSafetyGuard.verifyDependencies(
            bridge = MockBridgeProvider(),
            sanitizer = strictSanitizer,
            analyzeClient = nonMockAnalyzeClient,
            phoneBridge = FutureRealPhoneBridgeProvider(),
            isDebugBuild = false,
            useMockApi = false,
            useMockSanitizer = false,
            useMockBridge = false,
            useMockPhoneBridge = false,
        )
    }

    @Test(expected = IllegalStateException::class)
    fun `release cannot silently fall back to mock phone bridge instance`() {
        val phoneBridge = MockPhoneBridgeProvider.create(parentScope = testScope())
        try {
            ReleaseSafetyGuard.verifyDependencies(
                bridge = realBridge,
                sanitizer = strictSanitizer,
                analyzeClient = nonMockAnalyzeClient,
                phoneBridge = phoneBridge,
                isDebugBuild = false,
                useMockApi = false,
                useMockSanitizer = false,
                useMockBridge = false,
                useMockPhoneBridge = false,
            )
        } finally {
            phoneBridge.close()
        }
    }

    @Test(expected = IllegalStateException::class)
    fun `strict sanitizer flag with mock sanitizer instance fails fast`() {
        ReleaseSafetyGuard.verifyDependencies(
            bridge = MockBridgeProvider(),
            sanitizer = MockPrivacyImageSanitizer(),
            analyzeClient = MockAnalyzeClient(),
            phoneBridge = DisabledPhoneBridgeProvider(),
            isDebugBuild = true,
            useMockApi = true,
            useMockSanitizer = false, // flag claims strict; instance is mock
            useMockBridge = true,
            useMockPhoneBridge = false,
        )
    }

    @Test(expected = IllegalStateException::class)
    fun `strict api flag with mock analyze client instance fails fast`() {
        ReleaseSafetyGuard.verifyDependencies(
            bridge = MockBridgeProvider(),
            sanitizer = MockPrivacyImageSanitizer(),
            analyzeClient = MockAnalyzeClient(),
            phoneBridge = DisabledPhoneBridgeProvider(),
            isDebugBuild = true,
            useMockApi = false, // flag claims strict; instance is mock
            useMockSanitizer = true,
            useMockBridge = true,
            useMockPhoneBridge = false,
        )
    }

    @Test(expected = IllegalStateException::class)
    fun `strict bridge flag with mock bridge instance fails fast`() {
        ReleaseSafetyGuard.verifyDependencies(
            bridge = MockBridgeProvider(),
            sanitizer = MockPrivacyImageSanitizer(),
            analyzeClient = MockAnalyzeClient(),
            phoneBridge = DisabledPhoneBridgeProvider(),
            isDebugBuild = true,
            useMockApi = true,
            useMockSanitizer = true,
            useMockBridge = false, // flag claims strict; instance is mock
            useMockPhoneBridge = false,
        )
    }

    @Test(expected = IllegalStateException::class)
    fun `strict phone bridge flag with mock phone bridge instance fails fast`() {
        val phoneBridge = MockPhoneBridgeProvider.create(parentScope = testScope())
        try {
            ReleaseSafetyGuard.verifyDependencies(
                bridge = MockBridgeProvider(),
                sanitizer = MockPrivacyImageSanitizer(),
                analyzeClient = MockAnalyzeClient(),
                phoneBridge = phoneBridge,
                isDebugBuild = true,
                useMockApi = true,
                useMockSanitizer = true,
                useMockBridge = true,
                useMockPhoneBridge = false, // flag claims strict; instance is mock
            )
        } finally {
            phoneBridge.close()
        }
    }

    @Test
    fun `debug mock profile with mock instances passes dependency verification`() {
        val phoneBridge = MockPhoneBridgeProvider.create(parentScope = testScope())
        try {
            ReleaseSafetyGuard.verifyDependencies(
                bridge = MockBridgeProvider(),
                sanitizer = MockPrivacyImageSanitizer(),
                analyzeClient = MockAnalyzeClient(),
                phoneBridge = phoneBridge,
                isDebugBuild = true,
                useMockApi = true,
                useMockSanitizer = true,
                useMockBridge = true,
                useMockPhoneBridge = true,
            )
        } finally {
            phoneBridge.close()
        }
    }

    @Test
    fun `debug strict-privacy profile with strict sanitizer instance passes`() {
        // Mock bridge/API are still permitted by their flags; only the sanitizer
        // is strict in this profile.
        ReleaseSafetyGuard.verifyDependencies(
            bridge = MockBridgeProvider(),
            sanitizer = strictSanitizer,
            analyzeClient = MockAnalyzeClient(),
            phoneBridge = DisabledPhoneBridgeProvider(),
            isDebugBuild = true,
            useMockApi = true,
            useMockSanitizer = false,
            useMockBridge = true,
            useMockPhoneBridge = false,
        )
        assertTrue(true)
    }

    private fun testScope(): CoroutineScope =
        CoroutineScope(SupervisorJob() + UnconfinedTestDispatcher())
}
