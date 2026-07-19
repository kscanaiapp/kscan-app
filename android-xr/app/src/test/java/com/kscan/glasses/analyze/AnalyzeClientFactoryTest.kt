package com.kscan.glasses.analyze

import com.kscan.glasses.config.BetaConfig
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertTrue
import org.junit.Test

class AnalyzeClientFactoryTest {

    @Test
    fun `default config returns MockAnalyzeClient`() = runTest {
        val client = AnalyzeClientFactory.create(
            betaConfig = BetaConfig.DEFAULT,
            clientConfig = AnalyzeClientConfig.MOCK_ONLY,
        )
        assertTrue(client is MockAnalyzeClient)
    }

    @Test
    fun `useMockApi true blocks real analyze`() = runTest {
        val client = AnalyzeClientFactory.create(
            betaConfig = BetaConfig(
                useMockApi = true,
                enableRealAnalyze = true,
                enableRealFaceMasking = true,
            ),
            clientConfig = AnalyzeClientConfig(
                backendUrl = "https://example.com",
                enableRealAnalyze = true,
            ),
        )
        assertTrue(client is MockAnalyzeClient)
    }

    @Test
    fun `enableRealAnalyze false blocks real analyze`() = runTest {
        val client = AnalyzeClientFactory.create(
            betaConfig = BetaConfig(
                useMockApi = false,
                enableRealAnalyze = false,
                enableRealFaceMasking = true,
            ),
            clientConfig = AnalyzeClientConfig(
                backendUrl = "https://example.com",
                enableRealAnalyze = true,
            ),
        )
        assertTrue(client is MockAnalyzeClient)
    }

    @Test
    fun `enableRealFaceMasking false blocks real analyze`() = runTest {
        val client = AnalyzeClientFactory.create(
            betaConfig = BetaConfig(
                useMockApi = false,
                enableRealAnalyze = true,
                enableRealFaceMasking = false,
            ),
            clientConfig = AnalyzeClientConfig(
                backendUrl = "https://example.com",
                enableRealAnalyze = true,
            ),
        )
        assertTrue(client is MockAnalyzeClient)
    }

    @Test
    fun `blank backendUrl blocks real analyze`() = runTest {
        val client = try {
            AnalyzeClientFactory.create(
                betaConfig = BetaConfig(
                    useMockApi = false,
                    enableRealAnalyze = true,
                    enableRealFaceMasking = true,
                ),
                clientConfig = AnalyzeClientConfig(
                    backendUrl = "",
                    enableRealAnalyze = true,
                ),
            )
        } catch (e: IllegalArgumentException) {
            // AnalyzeClientConfig itself rejects blank backendUrl when enableRealAnalyze=true
            // This is acceptable — the config object is a boundary guard
            return@runTest
        }
        // If we reach here, factory should still return MockAnalyzeClient
        assertTrue(client is MockAnalyzeClient)
    }

    @Test
    fun `all gates true returns RealAnalyzeClient in debug only`() = runTest {
        val client = AnalyzeClientFactory.create(
            betaConfig = BetaConfig(
                useMockApi = false,
                enableRealAnalyze = true,
                enableRealFaceMasking = true,
            ),
            clientConfig = AnalyzeClientConfig(
                backendUrl = "https://example.com",
                enableRealAnalyze = true,
            ),
        )
        if (com.kscan.glasses.BuildConfig.DEBUG) {
            assertTrue(client is RealAnalyzeClient)
        } else {
            // Release builds never return a mock; live analysis is not authorized,
            // so the client must be fail-closed instead.
            assertTrue(client !is MockAnalyzeClient)
        }
    }

    @Test(expected = IllegalStateException::class)
    fun `release mock API is rejected with fail fast`() {
        AnalyzeClientFactory.create(
            betaConfig = BetaConfig(useMockApi = true),
            clientConfig = AnalyzeClientConfig.MOCK_ONLY,
            isDebugBuild = false,
        )
    }

    @Test
    fun `release never returns a mock client and fails closed`() = runTest {
        val client = AnalyzeClientFactory.create(
            betaConfig = BetaConfig(
                useMockApi = false,
                enableRealAnalyze = true,
                enableRealFaceMasking = true,
            ),
            clientConfig = AnalyzeClientConfig(
                backendUrl = "https://example.com",
                enableRealAnalyze = true,
            ),
            isDebugBuild = false,
        )

        // No silent fallback to mock, even with every real gate requested.
        assertTrue(client !is MockAnalyzeClient)

        // Live analysis is not authorized in this build: any call throws Disabled
        // instead of producing a synthetic or mock result.
        try {
            client.analyze(AnalyzeRequest("data:image/jpeg;base64,abc"))
            assertTrue("Expected AnalyzeException.Disabled", false)
        } catch (e: AnalyzeException.Disabled) {
            assertTrue(true)
        }
    }

    @Test
    fun `debug mock mode remains allowed`() = runTest {
        val client = AnalyzeClientFactory.create(
            betaConfig = BetaConfig(useMockApi = true),
            clientConfig = AnalyzeClientConfig.MOCK_ONLY,
            isDebugBuild = true,
        )
        assertTrue(client is MockAnalyzeClient)
    }
}
