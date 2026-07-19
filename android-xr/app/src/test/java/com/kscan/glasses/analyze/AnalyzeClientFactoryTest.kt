package com.kscan.glasses.analyze

import com.kscan.glasses.config.BetaConfig
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertTrue
import org.junit.Test

class AnalyzeClientFactoryTest {

    @Test
    fun `default config returns MockAnalyzeClient`() = runTest {
        // Debug-scoped: in release the same config must fail fast (covered below).
        val client = AnalyzeClientFactory.create(
            betaConfig = BetaConfig.DEFAULT,
            clientConfig = AnalyzeClientConfig.MOCK_ONLY,
            isDebugBuild = true,
        )
        assertTrue(client is MockAnalyzeClient)
    }

    @Test
    fun `useMockApi true blocks real analyze`() = runTest {
        // Debug-scoped: mock lock overrides real gates in debug only.
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
            isDebugBuild = true,
        )
        assertTrue(client is MockAnalyzeClient)
    }

    @Test
    fun `enableRealAnalyze false blocks real analyze`() = runTest {
        // Debug-scoped: a disabled real gate falls back to the labeled mock in debug.
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
            isDebugBuild = true,
        )
        assertTrue(client is MockAnalyzeClient)
    }

    @Test
    fun `enableRealFaceMasking false blocks real analyze`() = runTest {
        // Debug-scoped: the privacy gate falls back to the labeled mock in debug.
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
            isDebugBuild = true,
        )
        assertTrue(client is MockAnalyzeClient)
    }

    @Test
    fun `release with real analyze disabled fails closed without mock`() = runTest {
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
            isDebugBuild = false,
        )
        assertTrue(client !is MockAnalyzeClient)
        try {
            client.analyze(AnalyzeRequest("data:image/jpeg;base64,abc"))
            assertTrue("Expected AnalyzeException.Disabled", false)
        } catch (e: AnalyzeException.Disabled) {
            assertTrue(true)
        }
    }

    @Test
    fun `release with real face masking disabled fails closed without mock`() = runTest {
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
            isDebugBuild = false,
        )
        assertTrue(client !is MockAnalyzeClient)
        try {
            client.analyze(AnalyzeRequest("data:image/jpeg;base64,abc"))
            assertTrue("Expected AnalyzeException.Disabled", false)
        } catch (e: AnalyzeException.Disabled) {
            assertTrue(true)
        }
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
